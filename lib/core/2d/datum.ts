import { registerBuilder, SceneParserContext } from "../../index.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import type { DatumName } from "../../sketch-solver/index.js";
import { getCurrentScene } from "../../scene-manager.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { AssemblyOriginFrame, makeAssemblyOriginFrame, type OriginAxis } from "../../features/origin-frame.js";

/**
 * Typed overloads for the context-dispatched `origin`: the no-arg form is
 * declared as the sketch datum (its typed TS consumers are constraint
 * statements), though at assembly top level it returns the origin frame at
 * runtime — `mate()` takes `unknown` sides, so the widened type never
 * bites there.
 */
interface OriginFunction {
  (axis: OriginAxis): AssemblyOriginFrame;
  // Last on purpose: `ReturnType<typeof origin>` resolves to the final
  // signature, and existing typed consumers expect the sketch datum.
  (): SketchDatum;
}

// The datum accessors are expressions, not statements: they add no scene
// object and appear nowhere in the timeline. Misuse (legacy sketch, no
// active sketch, another sketch's datum) is diagnosed by the consuming
// constraint statement, which stashes the error instead of throwing.
function datumCommand(datum: DatumName) {
  return registerBuilder((context: SceneParserContext) =>
    function (): SketchDatum {
      return new SketchDatum(context.getActiveSketch(), datum);
    });
}

/**
 * Context-dispatched datum accessor.
 *
 * In part design (any `part()` scope — including part blocks inside an
 * assembly file) `origin()` is the sketch origin — the plane's local (0, 0)
 * — as a constraint target. A fixed reference point:
 * `coincident(l.start(), origin())`, `distance(origin(), c.center(), 40)`.
 *
 * At the top level of an *.assembly.js file `origin(axis?)` is the
 * assembly's own coordinate frame as a `mate()` side — how a base part
 * keeps degrees of freedom relative to the world instead of being fully
 * pinned by `.grounded()`. The optional axis ('x' | 'y' | 'z', default
 * 'z') aims the frame's Z along that world axis; position the joint with
 * the mate's `.offset()` (world coordinates — the origin side is the
 * grounded driver).
 */
export const origin = registerBuilder((context: SceneParserContext) =>
  function (axis?: unknown): SketchDatum | AssemblyOriginFrame {
    const scene = getCurrentScene();
    if (scene instanceof AssemblyScene && !scene.getActivePart()) {
      if (scene.currentScopePath() !== "") {
        // A sub-assembly's frame is not a solver body yet — accepting this
        // would silently leave the mate unenforced, so reject loudly at
        // parse time (same policy as the unimplemented mate types).
        throw new Error(
          "origin() inside an assembly() body — mating to a sub-assembly's own frame is not supported yet; ground the occurrence or mate its parts to the parent's instances instead.",
        );
      }
      return makeAssemblyOriginFrame(axis);
    }
    if (axis !== undefined) {
      throw new Error("origin(): the sketch origin datum takes no arguments.");
    }
    return new SketchDatum(context.getActiveSketch(), 'origin');
  }, { allowAssemblyTopLevel: true }) as unknown as OriginFunction;

/**
 * The sketch x axis — the infinite line through the origin along the
 * plane's x direction — as a constraint target. A fixed reference line:
 * `collinear(xAxis(), l)`, `coincident(p, xAxis())`,
 * `symmetric(a, b, xAxis())`, `distance(xAxis(), c, 25)`.
 * Constraint sketches only.
 */
export const xAxis = datumCommand('x-axis');

/**
 * The sketch y axis — the infinite line through the origin along the
 * plane's y direction — as a constraint target. A fixed reference line:
 * `collinear(yAxis(), l)`, `coincident(p, yAxis())`,
 * `symmetric(a, b, yAxis())`, `distance(yAxis(), c, 25)`.
 * Constraint sketches only.
 */
export const yAxis = datumCommand('y-axis');
