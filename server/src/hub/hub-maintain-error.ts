import { HubRequestError } from './hub-request-error.ts';

/**
 * A change to a package on the hub that didn't happen (`fluidcad deprecate`,
 * `listing`, H12), worded for its owner: what is wrong, then what to do.
 * The code is the hub's own when the hub refused (`version-not-open`,
 * `version-removed`, `bad-request`, …), and the same code when the CLI could
 * tell before sending anything. The codes only the CLI gives:
 * - `signed-out`: no token for this hub;
 * - `bad-name`: what the command was given isn't a package name (or the
 *   workspace isn't a package);
 * - `nothing-open`: release notes for a package with no draft or version
 *   in review.
 *
 * `local` is true when nothing was sent to the hub about the package.
 */
export class HubMaintainError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly local: boolean;

  constructor(code: string, message: string, options: { details?: unknown; local?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HubMaintainError';
    this.code = code;
    this.details = options.details;
    this.local = options.local ?? true;
  }

  /** A refusal decided here, before anything about the package was sent. */
  static local(code: string, message: string, details?: unknown): HubMaintainError {
    return new HubMaintainError(code, HubMaintainMessages.withHint(code, message), { details, local: true });
  }

  /** The hub's refusal (or no answer), with the hint its code calls for. */
  static fromHub(err: HubRequestError, origin: string): HubMaintainError {
    return new HubMaintainError(err.code, HubMaintainMessages.explain(err, origin), { details: err.details, local: false, cause: err });
  }
}

/** The next step each refusal calls for, after the sentence that names the problem. */
export class HubMaintainMessages {
  static readonly LOGIN_HINT = 'Run `fluidcad login`, then try again.';
  static readonly OFFLINE_HINT = 'Nothing changed: check the connection, then try again.';

  private static readonly HINTS: Record<string, string> = {
    unauthorized: HubMaintainMessages.LOGIN_HINT,
    'version-not-open': 'A published version\'s release notes and license are fixed; the next version takes its own from `fluidcad publish --notes`.',
    network: HubMaintainMessages.OFFLINE_HINT,
    stalled: HubMaintainMessages.OFFLINE_HINT,
  };

  /** `message`, then the hint for `code` when it has one (and the message doesn't already end with it). */
  static withHint(code: string, message: string): string {
    const hint = HubMaintainMessages.HINTS[code];
    if (!hint || message.endsWith(hint)) {
      return message;
    }
    return `${message} ${hint}`;
  }

  /** A hub refusal in the owner's terms: a validation refusal names its fields (the license list among them). */
  static explain(err: HubRequestError, origin: string): string {
    if (err.unauthorized) {
      return HubMaintainMessages.withHint('unauthorized', `${origin} no longer accepts your token (revoked or expired).`);
    }
    if (err.code === HubRequestError.TIMEOUT) {
      return `${err.message} The hub may still have made the change: check with \`fluidcad listing show\`.`;
    }
    return HubMaintainMessages.withHint(err.code, err.sentence);
  }
}
