import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { getUnitRegistry } from "../units/registry.js";
import { parseLengthUnit } from "../units/units.js";

/**
 * Declares the unit this file's numbers are in: `unit('in')`. Metadata only —
 * nothing is scaled; the kernel runs in the document's unit. Files without
 * `unit()` are millimetres.
 *
 * Top-level only, once per file, before any geometry, parts only: an
 * assembly's own lengths are in the project unit (`fluidcad.json`). Not a
 * SceneObject — never a timeline row, so it bypasses registerBuilder and
 * captures its own source location the way breakpoint() does.
 */
export default function unit(name: string): void {
  const scene = getCurrentScene();
  if (scene && scene.getActiveContainer()) {
    throw new Error(
      "unit(): unit() must be a top-level statement — not inside part(), assembly() or sketch() callbacks.",
    );
  }
  // The assembly rule is about the CALLING FILE, never the current scene: an
  // assembly importing an inch part evaluates that part's top-level unit()
  // while the assembly scene is current, and that call is legitimate.
  const parsed = parseLengthUnit(name);
  const location = captureSourceLocation();
  if (!location) {
    throw new Error(
      "unit(): could not determine the calling file — call unit() at the top level of a .part.js / .fluid.js model file.",
    );
  }
  if (location.filePath.endsWith(".assembly.js")) {
    throw new Error(
      "unit(): unit() is not allowed in assembly files — units belong to parts; assembly lengths are in the project unit (fluidcad.json).",
    );
  }
  getUnitRegistry().declare(location.filePath, parsed);
}
