import crypto from 'crypto';
import { HubClient } from './hub-client.ts';
import type { HubConfig } from './hub-config.ts';
import { HubLogin, HubLoginError, type HubLoginResult, type HubLoginSession } from './hub-login.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * Signing in from the app (H11 follow-up 2, the user's request of
 * 2026-10-12): the Hub panel's Sign in runs `fluidcad login`'s own flow
 * (`HubLogin`: loopback + PKCE, the code exchanged by this engine, the
 * credentials written to `$FLUIDCAD_HOME/credentials.json` for the hub's
 * origin, exactly where the CLI writes them), started by the engine and
 * followed by the page:
 *
 * 1. {@link start} checks that the hub answers (`GET /api/v1`, 5 s), so an
 *    unreachable hub is refused before any page opens, then begins the
 *    sign-in and answers its URL. The page opens it in the user's browser
 *    through its host (VS Code's `open-external`, `window.open` elsewhere):
 *    the engine never opens a browser itself.
 * 2. The page follows {@link current} until the sign-in ends: `signed-in`
 *    (with the handle), `denied`, `expired` (nothing came back within the
 *    hub request's five minutes, a closed browser tab included),
 *    `cancelled` ({@link cancel}) or `failed` (with a code).
 *
 * One sign-in at a time per engine: starting again while one waits for the
 * same hub answers that one (`resumed`), whatever page asks, so a second
 * click or a reload never leaves two loopbacks waiting. Every ended state
 * carries a sentence in the app's words; the CLI's say `fluidcad login`.
 */

export type HubAppLoginStatus = 'pending' | 'signed-in' | 'denied' | 'expired' | 'cancelled' | 'failed';

/** Why a `failed` sign-in failed. */
export type HubAppLoginFailure = 'hub-unreachable' | 'exchange-failed' | 'state-mismatch' | 'callback-error' | 'loopback';

/** `GET /api/hub/login`: one sign-in, as the page follows it. */
export type HubAppLoginState = {
  /** Tells one sign-in from the next. */
  id: string;
  /** The hub's origin. */
  hub: string;
  status: HubAppLoginStatus;
  /** The page to open in the browser, while it waits; null once it has ended. */
  authorizeUrl: string | null;
  startedAt: string;
  /** When a sign-in still waiting for the browser ends as `expired`. */
  expiresAt: string;
  /** Who signed in (`signed-in`); null otherwise, or for an account without a handle yet. */
  handle: string | null;
  /** Why it `failed`; null otherwise. */
  code: HubAppLoginFailure | null;
  /** What happened, for any ended state but `signed-in`. */
  error: string | null;
};

/** `POST /api/hub/login`. */
export type HubAppLoginStart = {
  login: HubAppLoginState;
  /** True when a sign-in was already waiting and this is it. */
  resumed: boolean;
};

export type HubAppLoginOptions = {
  /** Which hub, resolved at each start (the bridge's own `config()`); a bad URL throws `HubConfigError`. */
  config: () => HubConfig;
  /** This FluidCAD's version: the device panel and the user agent. */
  version: string;
  /** Tests: a transport that doesn't wait between retries. */
  transport?: HubTransport;
  /** Defaults to `HubLogin.TIMEOUT_MS` (the hub request's life). */
  timeoutMs?: number;
};

type Attempt = { state: HubAppLoginState; session: HubLoginSession };

export class HubAppLogin {
  /** How long {@link start} waits for the hub to answer before it refuses. */
  static readonly REACH_TIMEOUT_MS = 5_000;

  private attempt: Attempt | null = null;
  private starting: Promise<HubAppLoginState> | null = null;

  constructor(private readonly options: HubAppLoginOptions) {}

  /**
   * Begin a sign-in, or answer the one already waiting for this hub. Throws
   * the hub's `HubRequestError` when it doesn't answer (the routes' 503
   * `hub-unreachable`), and `HubConfigError` for a bad hub URL.
   */
  async start(): Promise<HubAppLoginStart> {
    if (this.starting) {
      return { login: await this.starting, resumed: true };
    }
    const config = this.options.config();
    const waiting = this.attempt;
    if (waiting && waiting.state.status === 'pending') {
      if (waiting.state.hub === config.origin) {
        return { login: { ...waiting.state }, resumed: true };
      }
      // The engine's hub changed under a waiting sign-in: that one can't finish here any more.
      this.cancel();
    }
    const starting = this.begin(config);
    this.starting = starting;
    try {
      return { login: await starting, resumed: false };
    } finally {
      this.starting = null;
    }
  }

  /** The sign-in waiting or last ended in this engine, or null when there was none. */
  current(): HubAppLoginState | null {
    return this.attempt ? { ...this.attempt.state } : null;
  }

  /**
   * Stop the waiting sign-in. Once the browser has come back the exchange
   * decides, so the sign-in stays `pending` until it ends; an ended one is
   * answered as it is.
   */
  cancel(): HubAppLoginState | null {
    const attempt = this.attempt;
    if (attempt && attempt.state.status === 'pending' && attempt.session.cancel()) {
      HubAppLogin.end(attempt, { status: 'cancelled', error: 'Sign-in cancelled. Nothing was saved.' });
    }
    return this.current();
  }

  /** Stop a waiting sign-in (the engine's shutdown, tests). */
  dispose(): void {
    this.cancel();
  }

  private async begin(config: HubConfig): Promise<HubAppLoginState> {
    const version = this.options.version;
    // Before any page opens: a hub that doesn't answer gets the routes' usual 503.
    const quick = this.options.transport ?? new HubTransport({ version, client: 'app', timeoutMs: HubAppLogin.REACH_TIMEOUT_MS });
    await new HubClient(config, quick).meta();
    const transport = this.options.transport ?? new HubTransport({ version, client: 'app' });
    const session = await HubLogin.begin({
      config,
      version,
      client: new HubClient(config, transport),
      timeoutMs: this.options.timeoutMs,
      surface: 'app',
      holdProcess: false,
    });
    const attempt: Attempt = {
      session,
      state: {
        id: crypto.randomUUID(),
        hub: config.origin,
        status: 'pending',
        authorizeUrl: session.authorizeUrl,
        startedAt: new Date().toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        handle: null,
        code: null,
        error: null,
      },
    };
    this.attempt = attempt;
    session.result.then(
      (result) => HubAppLogin.end(attempt, HubAppLogin.signedIn(result)),
      (err) => HubAppLogin.end(attempt, HubAppLogin.ended(err, config)),
    );
    return { ...attempt.state };
  }

  /** The first outcome counts; the page's link to the browser goes with the wait. */
  private static end(attempt: Attempt, outcome: Partial<HubAppLoginState>): void {
    if (attempt.state.status !== 'pending') {
      return;
    }
    attempt.state = { ...attempt.state, ...outcome, authorizeUrl: null };
  }

  private static signedIn(result: HubLoginResult): Partial<HubAppLoginState> {
    return { status: 'signed-in', handle: result.handle };
  }

  /** A sign-in that ended without one, in the app's words. */
  private static ended(err: unknown, config: HubConfig): Partial<HubAppLoginState> {
    const host = HubAppLogin.host(config);
    if (!(err instanceof HubLoginError)) {
      return {
        status: 'failed',
        code: 'loopback',
        error: `FluidCAD couldn't wait for the browser to come back: ${(err as Error)?.message ?? String(err)}`,
      };
    }
    switch (err.code) {
      case 'denied':
        return { status: 'denied', error: 'The sign-in was denied in the browser. Nothing was saved.' };
      case 'timeout':
        return { status: 'expired', error: 'The sign-in wasn’t finished within 5 minutes, the time the hub gives it. Nothing was saved.' };
      case 'cancelled':
        return { status: 'cancelled', error: 'Sign-in cancelled. Nothing was saved.' };
      case 'state-mismatch':
        return { status: 'failed', code: 'state-mismatch', error: 'The browser came back from a sign-in FluidCAD didn’t start, so it was refused. Nothing was saved.' };
      case 'callback-error':
        return { status: 'failed', code: 'callback-error', error: `${host} sent the browser back without signing FluidCAD in. Nothing was saved.` };
      case 'exchange-failed': {
        const cause = err.cause instanceof HubRequestError ? err.cause : null;
        if (cause && (cause.unreachable || cause.status >= 500)) {
          return { status: 'failed', code: 'hub-unreachable', error: `Couldn’t reach ${host} to finish signing in. Nothing was saved.` };
        }
        return {
          status: 'failed',
          code: 'exchange-failed',
          error: `${host} didn’t give FluidCAD a token${cause ? `: ${cause.message.replace(/\s*Run `fluidcad login` again\.?$/, '')}` : '.'} Nothing was saved.`,
        };
      }
    }
  }

  private static host(config: HubConfig): string {
    try {
      return new URL(config.origin).host;
    } catch {
      return config.origin;
    }
  }
}
