import crypto from 'crypto';
import http from 'http';
import os from 'os';
import type { AddressInfo } from 'net';
import { HubClient, type HubCliTokenResponse } from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import { HubCredentials } from './hub-credentials.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * `fluidcad login` (HD7): loopback + PKCE (RFC 8252, RFC 7636) against the
 * hub's `/cli/authorize`.
 *
 * 1. A one-shot server on `127.0.0.1:0` (an IP literal: the hub refuses
 *    `localhost`, which can resolve elsewhere).
 * 2. A random `state` and PKCE verifier (32 bytes each, base64url) and the
 *    S256 challenge.
 * 3. The authorize URL is printed and opened in the browser.
 * 4. The browser comes back to `/callback`:
 *    - `state` must match, or the sign-in is refused and nothing is asked
 *      of the hub;
 *    - with a `code`, the CLI **exchanges it first** and writes the
 *      credentials, **then** sends the browser to `/cli/done?request=<id>`,
 *      so the done page (which reads the hub's own record) reports what
 *      really happened, the exchange's failure included;
 *    - with `error=access_denied`, nothing is written and the browser goes
 *      to the same page.
 * 5. Five minutes without a callback ends it, the hub's own request life.
 * 6. Only the first callback counts; any later one is refused.
 */

export type HubLoginOptions = {
  config: HubConfig;
  /** Opens a URL in the user's browser; a failure is fine, the URL is printed too. */
  openBrowser: (url: string) => Promise<void> | void;
  /** One line for the terminal. */
  print: (line: string) => void;
  /** Defaults to {@link HubLogin.TIMEOUT_MS}. */
  timeoutMs?: number;
  /** This FluidCAD's version, for the device panel and the user agent. */
  version: string;
  /** Defaults to a client over a new {@link HubTransport}. */
  client?: HubClient;
};

export type HubLoginResult = {
  origin: string;
  handle: string | null;
  email: string;
  tokenId: string;
  /** Where the credentials were written. */
  path: string;
};

export type HubLoginErrorCode = 'denied' | 'callback-error' | 'state-mismatch' | 'exchange-failed' | 'timeout';

export class HubLoginError extends Error {
  readonly code: HubLoginErrorCode;

  constructor(code: HubLoginErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HubLoginError';
    this.code = code;
  }
}

type Callback = { code: string | null; state: string | null; error: string | null; request: string | null };

export class HubLogin {
  static readonly CLIENT_ID = 'fluidcad-cli';
  static readonly TIMEOUT_MS = 5 * 60 * 1000;
  static readonly CALLBACK_PATH = '/callback';
  /** The hub's request ids; anything else is not put in a URL. */
  private static readonly REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
  /** The hub's display caps (`CliRules.DISPLAY_MAX`). */
  private static readonly DISPLAY_MAX = { clientVersion: 32, os: 64, arch: 32 } as const;
  private static readonly PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

  private readonly verifier = HubLogin.randomToken();
  private readonly state = HubLogin.randomToken();
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  private readonly client: HubClient;
  private redirectUri = '';
  private claimed = false;
  private settled = false;
  private timer: NodeJS.Timeout | null = null;
  private resolve!: (result: HubLoginResult) => void;
  private reject!: (err: Error) => void;

  private constructor(private readonly options: HubLoginOptions) {
    this.client = options.client ?? new HubClient(options.config, new HubTransport({ version: options.version, client: 'cli' }));
  }

  /** Signs in and writes the credentials; resolves with who signed in, or rejects with a {@link HubLoginError}. */
  static run(options: HubLoginOptions): Promise<HubLoginResult> {
    return new HubLogin(options).start();
  }

  /** The URL the browser is sent to. */
  authorizeUrl(): string {
    const device = HubLogin.device(this.options.version);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: HubLogin.CLIENT_ID,
      redirect_uri: this.redirectUri,
      code_challenge: HubLogin.challengeOf(this.verifier),
      code_challenge_method: 'S256',
      state: this.state,
      // Display-only, for the device panel; PKCE and the loopback decide.
      client_version: device.clientVersion,
      os: device.os,
      arch: device.arch,
    });
    return `${this.options.config.url('/cli/authorize')}?${params}`;
  }

  private start(): Promise<HubLoginResult> {
    return new Promise<HubLoginResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.server.on('error', (err) => this.fail(err));
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        this.redirectUri = `http://127.0.0.1:${port}${HubLogin.CALLBACK_PATH}`;
        const timeoutMs = this.options.timeoutMs ?? HubLogin.TIMEOUT_MS;
        this.timer = setTimeout(() => {
          this.fail(new HubLoginError('timeout', `No answer from the browser within ${HubLogin.duration(timeoutMs)}. Run \`fluidcad login\` again.`));
        }, timeoutMs);
        const url = this.authorizeUrl();
        this.options.print(`Opening your browser to sign in to ${this.options.config.origin}…`);
        this.options.print('');
        this.options.print(`  ${url}`);
        this.options.print('');
        void Promise.resolve()
          .then(() => this.options.openBrowser(url))
          .catch(() => {
            // The URL is printed above; the user can open it themselves.
          });
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== HubLogin.CALLBACK_PATH) {
      HubLogin.plain(res, 404, 'Not found.');
      return;
    }
    if (this.claimed || this.settled) {
      HubLogin.plain(res, 409, 'This sign-in has already finished. You can close this tab.');
      return;
    }
    this.claimed = true;
    const callback: Callback = {
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      request: url.searchParams.get('request'),
    };
    void this.finish(callback, res);
  }

  private async finish(callback: Callback, res: http.ServerResponse): Promise<void> {
    if (!HubLogin.sameSecret(callback.state, this.state)) {
      HubLogin.plain(res, 400, 'This sign-in link does not belong to the waiting `fluidcad login`. Nothing was saved.');
      this.fail(new HubLoginError('state-mismatch', 'The browser came back with a state this login never sent, so it was refused and nothing was saved. Run `fluidcad login` again.'));
      return;
    }
    if (callback.error !== null || callback.code === null) {
      this.redirectToDone(res, callback.request);
      if (callback.error === 'access_denied') {
        this.fail(new HubLoginError('denied', 'Sign-in was denied in the browser. Nothing was saved.'));
      } else {
        this.fail(new HubLoginError('callback-error', `The hub sent the browser back without a sign-in code (${callback.error ?? 'no code'}). Nothing was saved.`));
      }
      return;
    }

    let result: HubLoginResult;
    try {
      const exchanged = await this.client.exchangeCliCode({
        clientId: HubLogin.CLIENT_ID,
        code: callback.code,
        codeVerifier: this.verifier,
        redirectUri: this.redirectUri,
      });
      result = this.save(exchanged);
    } catch (err) {
      this.redirectToDone(res, callback.request);
      const reason = err instanceof HubRequestError ? err.message : String((err as Error)?.message ?? err);
      this.fail(new HubLoginError('exchange-failed', `The hub didn't give this machine a token: ${reason} Nothing was saved.`, { cause: err }));
      return;
    }
    this.redirectToDone(res, callback.request);
    this.succeed(result);
  }

  private save(exchanged: HubCliTokenResponse): HubLoginResult {
    const origin = this.options.config.origin;
    const file = HubCredentials.write(origin, {
      token: exchanged.token,
      tokenId: exchanged.tokenId,
      handle: exchanged.user.handle,
      email: exchanged.user.email,
    });
    return { origin, handle: exchanged.user.handle, email: exchanged.user.email, tokenId: exchanged.tokenId, path: file };
  }

  /** 302 to the hub's done page, which shows the request's own status; never a status flag of ours. */
  private redirectToDone(res: http.ServerResponse, request: string | null): void {
    if (request === null || !HubLogin.REQUEST_ID.test(request)) {
      HubLogin.plain(res, 200, 'The sign-in has finished; see the terminal. You can close this tab.');
      return;
    }
    const location = `${this.options.config.url('/cli/done')}?${new URLSearchParams({ request })}`;
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
  }

  private succeed(result: HubLoginResult): void {
    if (this.settle()) {
      this.resolve(result);
    }
  }

  private fail(err: Error): void {
    if (this.settle()) {
      this.reject(err);
    }
  }

  /** Stops the timer and the server once; true for the first caller. */
  private settle(): boolean {
    if (this.settled) {
      return false;
    }
    this.settled = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    // Let the answer just written reach the browser, then drop every connection.
    this.server.close();
    setImmediate(() => this.server.closeAllConnections());
    return true;
  }

  private static plain(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`${text}\n`);
  }

  /** 32 random bytes, base64url: 43 characters of the RFC 7636 alphabet. */
  private static randomToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  private static challengeOf(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  private static sameSecret(received: string | null, expected: string): boolean {
    if (received === null) {
      return false;
    }
    const a = crypto.createHash('sha256').update(received).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** What the device panel shows: `0.0.46`, `macOS 25.5.0`, `arm64`, within the hub's caps. */
  private static device(version: string): { clientVersion: string; os: string; arch: string } {
    const platform = HubLogin.PLATFORM_NAMES[process.platform] ?? process.platform;
    // os.release() is the kernel version; its leading x.y.z is the useful part.
    const release = os.release().split('-')[0];
    const cap = (text: string, max: number) => [...text].slice(0, max).join('');
    return {
      clientVersion: cap(version, HubLogin.DISPLAY_MAX.clientVersion),
      os: cap(`${platform} ${release}`.trim(), HubLogin.DISPLAY_MAX.os),
      arch: cap(process.arch, HubLogin.DISPLAY_MAX.arch),
    };
  }

  private static duration(ms: number): string {
    if (ms >= 60_000 && ms % 60_000 === 0) {
      const minutes = ms / 60_000;
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${Math.max(1, Math.round(ms / 1000))} s`;
  }
}
