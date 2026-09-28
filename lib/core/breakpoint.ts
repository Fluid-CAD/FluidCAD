import { captureSourceLocation } from "../index.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { getCurrentScene } from "../scene-manager.js";

export function breakpoint(): never {
  // The scene notes where the build stopped before the throw unwinds it: the
  // render reports its paused row from that (Scene.renderStop).
  getCurrentScene()?.markBreakpoint();
  throw new BreakpointHit(captureSourceLocation());
}
