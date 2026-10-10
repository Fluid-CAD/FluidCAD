import { HubRequestError } from './hub-request-error.ts';

/**
 * An install from the hub that didn't happen, worded for whoever is
 * installing: what is wrong, then what to do. Nothing is installed when
 * one is thrown; a download's scratch directory is already gone.
 *
 * The code is the hub's own when the hub refused (`version-removed`,
 * `rate-limited`, …), else the transport's (`network`, `timeout`,
 * `stalled`, `aborted`), else one of the installer's:
 * - `not-found`: no such package or version this reader may see;
 * - `nothing-published`: the package has no published version yet;
 * - `incompatible`: no published version runs on this FluidCAD;
 * - `not-installable`: the version has no archive (rejected, uploading);
 * - `too-large`: the archive is over the hub's `archiveBytes`;
 * - `truncated`: the download ended before its `Content-Length`;
 * - `integrity-mismatch`: the bytes, the hub and the pin don't agree;
 * - `wrong-package`: the archive holds another package or version.
 */

export type HubInstallErrorCode = string;

export class HubInstallError extends Error {
  readonly code: HubInstallErrorCode;
  readonly details: unknown;

  constructor(code: HubInstallErrorCode, message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HubInstallError';
    this.code = code;
    this.details = options.details;
  }

  /** A refusal decided here, with the hint its code calls for. */
  static local(code: HubInstallErrorCode, message: string, details?: unknown): HubInstallError {
    return new HubInstallError(code, HubInstallMessages.withHint(code, message), { details });
  }

  /** The hub's refusal (or no answer at all), with the hint its code calls for. */
  static fromHub(err: HubRequestError): HubInstallError {
    return new HubInstallError(err.code, HubInstallMessages.withHint(err.code, err.message), { details: err.details, cause: err });
  }
}

/** The next step each refusal calls for, after the sentence that names the problem. */
export class HubInstallMessages {
  static readonly OFFLINE_HINT =
    'Nothing was installed. Check the connection and try again; a package already in your library installs without the hub, and `fluidcad install <file.fluidpkg>` installs from a file.';
  static readonly RETRY_HINT = 'Nothing was installed: try again.';
  static readonly UPDATE_HINT = 'Update FluidCAD, then install it again.';

  private static readonly HINTS: Record<string, string> = {
    network: HubInstallMessages.OFFLINE_HINT,
    timeout: HubInstallMessages.OFFLINE_HINT,
    stalled: HubInstallMessages.OFFLINE_HINT,
    'unexpected-response': HubInstallMessages.RETRY_HINT,
    truncated: HubInstallMessages.RETRY_HINT,
    'rate-limited': 'Wait a minute, then install again.',
    incompatible: HubInstallMessages.UPDATE_HINT,
    'integrity-mismatch': 'Nothing was installed.',
    'wrong-package': 'Nothing was installed.',
  };

  /** `message`, then the hint for `code` when it has one (and the message doesn't already end with it). */
  static withHint(code: string, message: string): string {
    const hint = HubInstallMessages.HINTS[code];
    if (!hint || message.endsWith(hint)) {
      return message;
    }
    return `${message} ${hint}`;
  }
}
