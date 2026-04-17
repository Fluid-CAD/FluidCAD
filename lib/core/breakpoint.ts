import { captureSourceLocation } from "../index.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";

export function breakpoint(): never {
  throw new BreakpointHit(captureSourceLocation());
}
