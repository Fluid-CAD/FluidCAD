/**
 * A hub request that didn't succeed, as the CLI and the engine word it.
 *
 * - An answer from the hub keeps its HTTP status and the hub's own error
 *   code and sentence (`{ error: { code, message, details? } }`, codes
 *   from the hub's `contract/errors.ts`, e.g. `unauthorized`,
 *   `invalid-grant`).
 * - An answer that isn't the hub's error shape (a proxy's 502 page) has
 *   the code `unexpected-response`.
 * - No answer at all has status 0 and the code `network`, `timeout`,
 *   `stalled` (a transfer nothing moved on for the stall limit), or
 *   `aborted` (the caller stopped it).
 */

export type HubRequestErrorCode = string;

export class HubRequestError extends Error {
  static readonly NETWORK = 'network';
  static readonly TIMEOUT = 'timeout';
  static readonly STALLED = 'stalled';
  /** The caller's signal stopped the request (a closed window, a download's stall watchdog). */
  static readonly ABORTED = 'aborted';
  static readonly UNEXPECTED = 'unexpected-response';

  readonly status: number;
  readonly code: HubRequestErrorCode;
  readonly details: unknown;

  constructor(status: number, code: HubRequestErrorCode, message: string, options: { details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HubRequestError';
    this.status = status;
    this.code = code;
    this.details = options.details;
  }

  /** True when the hub refused the token: revoked, expired or unknown. */
  get unauthorized(): boolean {
    return this.status === 401;
  }

  /** True when the hub was never reached, or never answered. */
  get unreachable(): boolean {
    return this.status === 0;
  }
}
