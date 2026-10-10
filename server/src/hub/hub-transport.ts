import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { HubRequestError } from './hub-request-error.ts';

/**
 * How every hub request leaves the machine. It carries the lessons of
 * GH #80 (desktop projects that hung on a bad network), ported here
 * because the server never imports from `launcher/`:
 * - every request has a time limit (`AbortSignal.timeout`, 20 s for JSON),
 *   so a stalled link fails in seconds instead of undici's 300 s;
 * - `HTTPS_PROXY`/`HTTP_PROXY` are followed (Node's `fetch` ignores them on
 *   its own), with loopback always exempt;
 * - an idempotent GET is retried once, after a short pause, on a network
 *   error or a 502/503/504, the failures a retry can fix. Writes are never
 *   retried: the hub may have acted on the first one.
 *
 * Every request names its client in the user agent:
 * `fluidcad/<version> (<platform>; <arch>; cli|app)`.
 */

export type HubClientKind = 'cli' | 'app';

export type HubTransportOptions = {
  /** This FluidCAD's version, for the user agent. */
  version: string;
  /** Which FluidCAD is asking: the CLI, or the app's engine. Defaults to `cli`. */
  client?: HubClientKind;
  /** Per-request limit; defaults to {@link HubTransport.JSON_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The pause before the one retry; defaults to {@link HubTransport.RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Where proxy settings are read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export type HubTransportRequest = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the transport's limit for this request. */
  timeoutMs?: number;
};

export class HubTransport {
  static readonly JSON_TIMEOUT_MS = 20_000;
  static readonly RETRY_DELAY_MS = 500;
  static readonly RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
  private static readonly IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
  private static readonly LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];
  private static proxyFollowed = false;

  readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: HubTransportOptions) {
    this.userAgent = HubTransport.userAgent(options.version, options.client ?? 'cli');
    this.timeoutMs = options.timeoutMs ?? HubTransport.JSON_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? HubTransport.RETRY_DELAY_MS;
    if (!HubTransport.proxyFollowed) {
      HubTransport.proxyFollowed = true;
      HubTransport.followProxyEnvironment(options.env ?? process.env);
    }
  }

  /** `fluidcad/0.0.46 (darwin; arm64; cli)`. */
  static userAgent(version: string, client: HubClientKind, platform: string = process.platform, arch: string = process.arch): string {
    return `fluidcad/${version} (${platform}; ${arch}; ${client})`;
  }

  /**
   * Behind a proxy, hub requests go through it: undici's global dispatcher
   * is the one Node's `fetch` uses underneath, so setting it reaches every
   * `fetch` in the process. Loopback is always exempt (the CLI's own
   * sign-in callback and a local hub must never leave the machine), as is
   * whatever `NO_PROXY` names; `NO_PROXY=*` turns the proxy off. Returns
   * the agent it installed, or null when no proxy is set.
   */
  static followProxyEnvironment(env: NodeJS.ProcessEnv = process.env): EnvHttpProxyAgent | null {
    const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
    const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
    const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
    if (!(httpsProxy || httpProxy) || noProxy.trim() === '*') {
      return null;
    }
    const exempt = [noProxy, ...HubTransport.LOOPBACK].filter((entry) => entry.trim() !== '');
    const agent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: exempt.join(',') });
    setGlobalDispatcher(agent);
    return agent;
  }

  /**
   * Sends one request and answers the hub's response, whatever its status.
   * Throws a {@link HubRequestError} only when no response came: `timeout`
   * or `network`.
   */
  async send(url: string, request: HubTransportRequest = {}): Promise<Response> {
    const method = (request.method ?? 'GET').toUpperCase();
    const retryable = HubTransport.IDEMPOTENT_METHODS.has(method);
    try {
      const response = await this.attempt(url, method, request);
      if (!retryable || !HubTransport.RETRY_STATUSES.has(response.status)) {
        return response;
      }
      await response.body?.cancel();
    } catch (err) {
      if (!retryable || !(err instanceof HubRequestError) || err.code !== HubRequestError.NETWORK) {
        throw err;
      }
    }
    await HubTransport.pause(this.retryDelayMs);
    return this.attempt(url, method, request);
  }

  private async attempt(url: string, method: string, request: HubTransportRequest): Promise<Response> {
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    try {
      return await fetch(url, {
        method,
        headers: { 'user-agent': this.userAgent, accept: 'application/json', ...request.headers },
        body: request.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const origin = HubTransport.originOf(url);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new HubRequestError(0, HubRequestError.TIMEOUT, `${origin} didn't answer within ${HubTransport.duration(timeoutMs)}.`, { cause: err });
      }
      throw new HubRequestError(0, HubRequestError.NETWORK, `Couldn't reach ${origin}: ${HubTransport.reasonOf(err)}.`, { cause: err });
    }
  }

  /** `ECONNREFUSED`, `ENOTFOUND`, … from undici's `fetch failed`, else the message. */
  private static reasonOf(err: unknown): string {
    const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
    if (cause?.code) {
      return cause.code;
    }
    if (cause?.message) {
      return cause.message;
    }
    return err instanceof Error ? err.message : String(err);
  }

  /** `20 s`, or `150 ms` under a second. */
  private static duration(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
  }

  private static originOf(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }

  private static pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
