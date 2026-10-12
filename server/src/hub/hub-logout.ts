import type { HubClient } from './hub-client.ts';
import type { HubConfig } from './hub-config.ts';
import { HubCredentials } from './hub-credentials.ts';
import { HubRequestError } from './hub-request-error.ts';

/**
 * Signing this machine out of one hub (HD8), shared by `fluidcad logout` and
 * the Hub panel's Sign out (H11 follow-up 3, the user's request of
 * 2026-10-12): revoke the saved token on the hub
 * (`DELETE /api/v1/me/tokens/current`), then forget it in
 * `$FLUIDCAD_HOME/credentials.json`, keeping every other hub's.
 *
 * - A token the hub already refuses (401) is simply forgotten
 *   (`already-revoked`).
 * - When the hub can't be reached, or answers anything else, the token is
 *   still forgotten here and the outcome is `not-revoked`, with why: the
 *   token stays valid on the hub until it is revoked there or goes unused
 *   for a year. The CLI says so and exits 1; the app says so in the panel.
 * - Nothing saved for that hub: `not-signed-in`, and no request is sent.
 *
 * Only the saved token is signed out: `FLUIDCAD_HUB_TOKEN` belongs to
 * whoever set it, so it is never revoked here, only reported
 * (`envToken`), since requests keep carrying it.
 */

export type HubLogoutOutcome = 'revoked' | 'already-revoked' | 'not-revoked' | 'not-signed-in';

/** What signing out did; the CLI prints it, `POST /api/hub/logout` answers it. */
export type HubLogoutResult = {
  /** The hub's origin. */
  hub: string;
  outcome: HubLogoutOutcome;
  /** Who was signed in, from the saved credential; null for `not-signed-in` or when it named nobody. */
  handle: string | null;
  email: string | null;
  /** `not-revoked`: why the hub didn't revoke the token, in the hub client's words. Null otherwise. */
  reason: string | null;
  /** `not-revoked`: true when the hub didn't answer or failed on its side, false when it refused. */
  unreachable: boolean;
  /** `FLUIDCAD_HUB_TOKEN` is set: requests still carry that token, which is never revoked here. */
  envToken: boolean;
};

export type HubLogoutOptions = {
  /** Which hub. */
  config: HubConfig;
  /** A client for that hub; the saved token is put on it for the revoke. */
  client: HubClient;
  /** Where `FLUIDCAD_HUB_TOKEN` is read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export class HubLogout {
  /**
   * Revoke, then forget. Throws only what isn't a hub request's failure (a
   * bug), before anything is forgotten, as `fluidcad logout` always has.
   */
  static async run(options: HubLogoutOptions): Promise<HubLogoutResult> {
    const origin = options.config.origin;
    const envToken = Boolean((options.env ?? process.env)[HubCredentials.ENV_TOKEN]);
    const stored = HubCredentials.stored(origin);
    if (!stored) {
      return { hub: origin, outcome: 'not-signed-in', handle: null, email: null, reason: null, unreachable: false, envToken };
    }

    let failure: HubRequestError | null = null;
    let alreadyRevoked = false;
    try {
      await options.client.withToken(stored.token).revokeCurrentToken();
    } catch (err) {
      if (!(err instanceof HubRequestError)) {
        throw err;
      }
      if (err.unauthorized) {
        alreadyRevoked = true;
      } else {
        failure = err;
      }
    }
    HubCredentials.clear(origin);

    const who = { hub: origin, handle: stored.handle, email: stored.email, envToken };
    if (failure) {
      return { ...who, outcome: 'not-revoked', reason: failure.message, unreachable: HubLogout.unreachable(failure) };
    }
    return { ...who, outcome: alreadyRevoked ? 'already-revoked' : 'revoked', reason: null, unreachable: false };
  }

  /** The hub never answered, or failed on its side (5xx), rather than refusing. */
  private static unreachable(err: HubRequestError): boolean {
    return err.unreachable || err.status >= 500;
  }
}
