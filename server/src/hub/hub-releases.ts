import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import { PackageName } from '../packages/package-name.ts';
import { HubClient } from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * The hub's releases for packages a project pins (hub-plan H10, "Feeding
 * P10"): for each name, the version an install by name would get on this
 * engine (`compatibility.newestCompatible`: published, neither yanked nor
 * removed, runnable here). `ProjectPackages.updates` compares it with the
 * pin, so the Packages dialog's "x.y.z available" chip also shows a hub
 * release. Previewing and applying an upgrade remain Stage P10's.
 *
 * Every answer is kept for {@link TTL_MS} (10 minutes), per hub and name;
 * a hub that couldn't be asked is asked again after {@link FAILURE_TTL_MS}.
 * {@link newest} never holds the Packages dialog up for long: it waits at
 * most `waitMs` for answers it doesn't have yet, leaves the rest out of
 * this answer, and keeps them for the next one when they arrive. Reads are
 * anonymous: only published versions are offered.
 */

export type HubReleasesOptions = {
  engineVersion: string;
  /** Defaults to the lib's `SDK_VERSION`. */
  sdkVersion?: number;
  /** Where the hub URL is read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to an app transport with {@link HubReleases.REQUEST_TIMEOUT_MS}. */
  transport?: HubTransport;
  /** Defaults to {@link HubReleases.WAIT_MS}. */
  waitMs?: number;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
};

type Release = { version: string | null; at: number; ok: boolean };

export class HubReleases {
  static readonly TTL_MS = 10 * 60 * 1000;
  static readonly FAILURE_TTL_MS = 60 * 1000;
  static readonly WAIT_MS = 3_000;
  static readonly REQUEST_TIMEOUT_MS = 5_000;

  private readonly options: HubReleasesOptions;
  private readonly sdkVersion: number;
  private transportInUse: HubTransport | null;
  private readonly now: () => number;
  private readonly known = new Map<string, Release>();
  private readonly asking = new Map<string, Promise<Release>>();

  constructor(options: HubReleasesOptions) {
    this.options = options;
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.transportInUse = options.transport ?? null;
    this.now = options.now ?? Date.now;
  }

  /**
   * Name → the hub's version for this engine, for each of `names` the hub
   * has one for (answers older than 10 minutes asked again). A hub that
   * isn't configured properly, or doesn't answer in time, gives none.
   */
  async newest(names: readonly string[]): Promise<Record<string, string>> {
    let config: HubConfig;
    try {
      config = HubConfig.resolve({ env: this.options.env });
    } catch {
      return {};
    }
    const pending: Promise<unknown>[] = [];
    for (const name of new Set(names)) {
      if (PackageName.isValid(name) && !this.fresh(config, name)) {
        pending.push(this.ask(config, name));
      }
    }
    if (pending.length > 0) {
      await Promise.race([Promise.allSettled(pending), HubReleases.pause(this.options.waitMs ?? HubReleases.WAIT_MS)]);
    }
    const versions: Record<string, string> = {};
    for (const name of names) {
      const release = this.known.get(HubReleases.keyOf(config, name));
      if (release?.version) {
        versions[name] = release.version;
      }
    }
    return versions;
  }

  /** Forgets every answer (tests). */
  forget(): void {
    this.known.clear();
  }

  private fresh(config: HubConfig, name: string): boolean {
    const release = this.known.get(HubReleases.keyOf(config, name));
    if (!release) {
      return false;
    }
    return this.now() - release.at < (release.ok ? HubReleases.TTL_MS : HubReleases.FAILURE_TTL_MS);
  }

  /** One lookup at a time per hub and name; its answer is kept whenever it comes. */
  private ask(config: HubConfig, name: string): Promise<Release> {
    const key = HubReleases.keyOf(config, name);
    const running = this.asking.get(key);
    if (running) {
      return running;
    }
    const lookup = this.lookup(config, name)
      .then((release) => {
        this.known.set(key, release);
        return release;
      })
      .finally(() => this.asking.delete(key));
    this.asking.set(key, lookup);
    return lookup;
  }

  private async lookup(config: HubConfig, name: string): Promise<Release> {
    const client = new HubClient(config, this.transport());
    try {
      const detail = await client.package(name, { engine: this.options.engineVersion, sdk: this.sdkVersion });
      const version = detail ? (detail.compatibility ? detail.compatibility.newestCompatible : detail.latestVersion) : null;
      return { version, at: this.now(), ok: true };
    } catch (err) {
      if (err instanceof HubRequestError) {
        // A refusal the hub decided (a bad name, a rate limit) or no answer: ask again soon.
        return { version: null, at: this.now(), ok: false };
      }
      throw err;
    }
  }

  private transport(): HubTransport {
    if (!this.transportInUse) {
      this.transportInUse = new HubTransport({ version: this.options.engineVersion, client: 'app', timeoutMs: HubReleases.REQUEST_TIMEOUT_MS });
    }
    return this.transportInUse;
  }

  private static keyOf(config: HubConfig, name: string): string {
    return `${config.origin} ${name}`;
  }

  private static pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
