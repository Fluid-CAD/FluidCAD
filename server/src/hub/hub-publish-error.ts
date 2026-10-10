import { HubRequestError } from './hub-request-error.ts';

/**
 * A publish that didn't happen, worded for the author: what is wrong, then
 * what to do (`fluidcad publish --status`, a version bump, …).
 *
 * The code is the hub's own when the hub refused (`open-version-exists`,
 * `version-not-greater`, …), and the same code when the CLI refused before
 * sending anything because it could already tell, so both read alike. The
 * codes only the CLI gives:
 * - `signed-out`: no token for this hub;
 * - `cli-too-old`: this FluidCAD is older than the hub's `minCliVersion`;
 * - `notes-too-long`: `--notes` over the hub's `releaseNotesChars`;
 * - `nothing-open`: `--withdraw` with no draft or version in review;
 * - `integrity-mismatch` after an upload: the hub stored other bytes than
 *   the ones packed here.
 *
 * `local` is true when nothing was sent to the hub's upload route.
 */

export type HubPublishErrorCode = string;

export class HubPublishError extends Error {
  readonly code: HubPublishErrorCode;
  readonly details: unknown;
  /** True when the CLI refused before uploading anything. */
  readonly local: boolean;

  constructor(code: HubPublishErrorCode, message: string, options: { details?: unknown; local?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HubPublishError';
    this.code = code;
    this.details = options.details;
    this.local = options.local ?? true;
  }

  /** A refusal decided here, before the upload. */
  static local(code: HubPublishErrorCode, message: string, details?: unknown): HubPublishError {
    return new HubPublishError(code, HubPublishMessages.withHint(code, message), { details, local: true });
  }

  /** The hub's refusal (or no answer at all), with the hint its code calls for. */
  static fromHub(err: HubRequestError, origin: string): HubPublishError {
    return new HubPublishError(err.code, HubPublishMessages.explain(err, origin), { details: err.details, local: false, cause: err });
  }
}

/** The next step each refusal calls for, after the sentence that names the problem. */
export class HubPublishMessages {
  static readonly STATUS_HINT = 'See it with `fluidcad publish --status`, or withdraw it with `fluidcad publish --withdraw`.';
  static readonly BUMP_HINT = 'Bump the version with `fluidcad version patch` (or minor, or major), then publish again.';
  static readonly LOGIN_HINT = 'Run `fluidcad login`, then publish again.';
  /** The hub's own sentence for `sources-too-large` ends with it, so it is never said twice. */
  static readonly SOURCES_HINT = 'Move large data out of .js and .json files, or split the package.';

  private static readonly HINTS: Record<string, string> = {
    'open-version-exists': HubPublishMessages.STATUS_HINT,
    'in-review': HubPublishMessages.STATUS_HINT,
    'version-exists': HubPublishMessages.BUMP_HINT,
    'version-not-greater': HubPublishMessages.BUMP_HINT,
    'email-unverified': 'Verify it from the email the hub sent (or sign in on the hub to send another), then publish again.',
    'publishing-closed': 'The hub\'s admins grant publishing; nothing was uploaded.',
    'unauthorized': HubPublishMessages.LOGIN_HINT,
    'scope-mismatch': 'A package\'s feature ids start with its scope: rename them, pack again, then publish.',
    'integrity-mismatch': 'Publish again; if it happens again, the archive is changing on its way to the hub.',
    'network': 'Nothing was stored: check the connection, then publish again.',
    'stalled': 'Nothing was stored: check the connection, then publish again.',
    'upload-expired': 'Nothing was stored: publish again.',
    'sources-too-large': HubPublishMessages.SOURCES_HINT,
  };

  /** `message`, then the hint for `code` when it has one (and the message doesn't already end with it). */
  static withHint(code: string, message: string): string {
    const hint = HubPublishMessages.HINTS[code];
    if (!hint || message.endsWith(hint)) {
      return message;
    }
    return `${message} ${hint}`;
  }

  /** A hub refusal in the author's terms. */
  static explain(err: HubRequestError, origin: string): string {
    if (err.unauthorized) {
      return HubPublishMessages.withHint('unauthorized', `${origin} no longer accepts your token (revoked or expired).`);
    }
    if (err.code === HubRequestError.TIMEOUT) {
      return `${err.message} The hub may still have stored it: check with \`fluidcad publish --status\`.`;
    }
    return HubPublishMessages.withHint(err.code, err.message);
  }
}
