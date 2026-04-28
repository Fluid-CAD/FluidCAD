import { getOC } from "../oc/init.js";

/**
 * Convert any thrown value to a readable string. OCC throws come through
 * Emscripten as raw numeric pointers; decode those via OCJS.getStandard_FailureData
 * so the actual reason ("Offset wire is not closed.", etc.) reaches the user.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'number' && Number.isFinite(error)) {
    try {
      const oc = getOC() as any;
      const failure = oc.OCJS.getStandard_FailureData(error);
      const msg = failure.GetMessageString();
      if (msg) {
        return `OCC: ${msg}`;
      }
      return `OCC error (ptr=${error})`;
    } catch (e) {
      console.log("[describeError] decode failed:", e);
    }
  }
  return String(error);
}
