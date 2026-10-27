import fs from 'fs';
import { PackageLayout } from '../packages/package-manifest.ts';
import { PackageScratch } from '../packages/package-scratch.ts';
import { HubClient } from './hub-client.ts';
import { HubInstallError } from './hub-install-error.ts';
import { HubRequestError } from './hub-request-error.ts';
import { StallWatchdog } from './hub-stall-watchdog.ts';

/**
 * One archive downloaded from the hub (H8), carrying GH #80's lessons for
 * the way down:
 * - it streams into a scratch file under `<root>/.tmp` (the root the
 *   package will install into), as `<archive>.part`, renamed to the archive
 *   name only once every byte has arrived, and then read for inspection;
 *   the scratch directory is removed whatever happens, so a failed or
 *   stalled download leaves nothing behind;
 * - a {@link StallWatchdog} (30 s) runs from the moment the request
 *   leaves: a hub that never answers, or a body that stops coming, fails
 *   then. It is not a total limit; the total is 10 minutes;
 * - the caller's abort signal (a closed window) ends it at once;
 * - the hub's `archiveBytes` caps it: a larger `Content-Length` is refused
 *   before the body is read, and a body that grows past it is cut off;
 * - the body must be exactly its `Content-Length`;
 * - the hub's `x-fluidcad-integrity` is captured, and refused before the
 *   body is read when it isn't the integrity the hub's metadata gave.
 *
 * The bytes are checked by the caller: `PackageArchive.inspect` computes
 * the tree hash, which must equal the header's (and the pin's).
 */

export type HubDownloadOptions = {
  client: HubClient;
  /** The root whose `.tmp` holds the download (the package's install root). */
  root: string;
  /** Defaults to {@link HubDownload.STALL_MS}. */
  stallMs?: number;
  /** Defaults to {@link HubDownload.TIMEOUT_MS}. */
  timeoutMs?: number;
};

export type HubDownloadRequest = {
  name: string;
  version: string;
  /** The integrity the hub's metadata gave; the archive's header must say the same. */
  expectIntegrity?: string | null;
  /** The hub's `archiveBytes`. */
  maxBytes: number;
  signal?: AbortSignal;
  /** The bytes received so far, and the total when the hub sent one. */
  onProgress?: (received: number, total: number | null) => void;
};

export type HubDownloaded = {
  bytes: Buffer;
  /** The hub's `x-fluidcad-integrity`. */
  integrity: string;
};

export class HubDownload {
  static readonly STALL_MS = 30_000;
  static readonly TIMEOUT_MS = 10 * 60 * 1000;

  private readonly client: HubClient;
  private readonly root: string;
  private readonly stallMs: number;
  private readonly timeoutMs: number;

  constructor(options: HubDownloadOptions) {
    this.client = options.client;
    this.root = options.root;
    this.stallMs = options.stallMs ?? HubDownload.STALL_MS;
    this.timeoutMs = options.timeoutMs ?? HubDownload.TIMEOUT_MS;
  }

  async archive(request: HubDownloadRequest): Promise<HubDownloaded> {
    const at = `${request.name}@${request.version}`;
    const origin = this.client.config.origin;
    const watchdog = new StallWatchdog(this.stallMs);
    const signal = request.signal ? AbortSignal.any([watchdog.signal, request.signal]) : watchdog.signal;
    const scratch = PackageScratch.create(this.root);
    try {
      watchdog.receive();
      let response: Response;
      try {
        response = await this.client.archive(request.name, request.version, { signal, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw this.failure(err, watchdog, request.signal, at);
      }
      const integrity = response.headers.get(HubClient.INTEGRITY_HEADER);
      const total = HubDownload.lengthOf(response);
      if (!integrity) {
        await response.body?.cancel();
        throw HubInstallError.local('unexpected-response', `${origin} sent ${at} without its integrity (${HubClient.INTEGRITY_HEADER}), so it can't be verified.`);
      }
      if (request.expectIntegrity && integrity !== request.expectIntegrity) {
        await response.body?.cancel();
        throw HubInstallError.local(
          'integrity-mismatch',
          `${origin} lists ${at} as ${request.expectIntegrity}, but its download says ${integrity}.`,
          { listed: request.expectIntegrity, header: integrity },
        );
      }
      if (total !== null && total > request.maxBytes) {
        await response.body?.cancel();
        throw HubDownload.tooLarge(at, total, request.maxBytes, origin);
      }

      const archive = scratch.file(PackageLayout.archiveName(request.name, request.version));
      const partial = `${archive}.part`;
      const received = await this.receive(response, partial, { ...request, at, total, watchdog });
      if (total !== null && received !== total) {
        throw HubInstallError.local('truncated', `The download of ${at} from ${origin} ended after ${received} of its ${total} bytes.`, { received, total });
      }
      fs.renameSync(partial, archive);
      return { bytes: fs.readFileSync(archive), integrity };
    } finally {
      watchdog.stop();
      scratch.dispose();
    }
  }

  /** The body into `file`, chunk by chunk, each one re-arming the watchdog. Answers the bytes written. */
  private async receive(
    response: Response,
    file: string,
    request: HubDownloadRequest & { at: string; total: number | null; watchdog: StallWatchdog },
  ): Promise<number> {
    const handle = await fs.promises.open(file, 'wx');
    let received = 0;
    try {
      if (!response.body) {
        return 0;
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch (err) {
            throw this.failure(err, request.watchdog, request.signal, request.at);
          }
          if (chunk.done) {
            break;
          }
          request.watchdog.touch();
          received += chunk.value.byteLength;
          if (received > request.maxBytes) {
            throw HubDownload.tooLarge(request.at, received, request.maxBytes, this.client.config.origin);
          }
          await handle.write(chunk.value);
          request.onProgress?.(received, request.total);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return received;
    } finally {
      await handle.close();
    }
  }

  /** Why the request or its body failed: the watchdog, the caller, or what the transport said. */
  private failure(err: unknown, watchdog: StallWatchdog, caller: AbortSignal | undefined, at: string): HubInstallError {
    const origin = this.client.config.origin;
    if (err instanceof HubInstallError) {
      return err;
    }
    if (watchdog.fired) {
      return HubInstallError.local(HubRequestError.STALLED, `The download of ${at} from ${origin} stalled: nothing came for ${HubDownload.duration(watchdog.stallMs)}.`);
    }
    if (caller?.aborted) {
      return HubInstallError.local(HubRequestError.ABORTED, `The download of ${at} was stopped.`);
    }
    if (err instanceof HubRequestError) {
      return HubInstallError.fromHub(err);
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return HubInstallError.local(HubRequestError.TIMEOUT, `The download of ${at} from ${origin} took longer than ${HubDownload.duration(this.timeoutMs)}.`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    return HubInstallError.local(HubRequestError.NETWORK, `The download of ${at} from ${origin} failed: ${reason}.`);
  }

  /** `150 ms`, `30 s`, `10 min`. */
  private static duration(ms: number): string {
    if (ms < 1000) {
      return `${ms} ms`;
    }
    if (ms >= 120_000 && ms % 60_000 === 0) {
      return `${ms / 60_000} min`;
    }
    return `${Math.round(ms / 1000)} s`;
  }

  private static tooLarge(at: string, bytes: number, limit: number, origin: string): HubInstallError {
    return HubInstallError.local('too-large', `${at} is ${bytes} bytes, more than the ${limit} bytes ${origin} serves for an archive.`, { bytes, limit });
  }

  /** `Content-Length`, or null when the hub sent none. */
  private static lengthOf(response: Response): number | null {
    const header = response.headers.get('content-length');
    if (header === null || !/^\d+$/.test(header)) {
      return null;
    }
    return Number(header);
  }
}
