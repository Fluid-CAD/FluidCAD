import { registerBuilder, SceneParserContext } from "../../index.js";
import { SketchDatum } from "../../features/2d/solved/datum.js";
import type { DatumName } from "../../sketch-solver/index.js";

// The datum accessors are expressions, not statements: they add no scene
// object and appear nowhere in the timeline. Misuse (no active sketch,
// another sketch's datum) is diagnosed by the consuming statement — a
// constraint stashes the error instead of throwing; mirror()/copy() throw.
function datumCommand(datum: DatumName) {
  return registerBuilder((context: SceneParserContext) =>
    function (): SketchDatum {
      return new SketchDatum(context.getActiveSketch(), datum);
    });
}

/**
 * The sketch origin — the plane's local (0, 0) — as a constraint target. A
 * fixed reference point: `coincident(l.start(), origin())`,
 * `distance(origin(), c.center(), 40)`.
 */
export const origin = datumCommand('origin');

/**
 * The sketch x axis — the infinite line through the origin along the
 * plane's x direction. A fixed constraint target: `collinear(xAxis(), l)`,
 * `coincident(p, xAxis())`, `symmetric(a, b, xAxis())`,
 * `distance(xAxis(), c, 25)`. Also the sketch's own X direction for the
 * in-sketch transforms — `mirror(xAxis(), g)`, `copy('linear', xAxis(),
 * …)` — where a bare `'x'` would mean WORLD x.
 */
export const xAxis = datumCommand('x-axis');

/**
 * The sketch y axis — the infinite line through the origin along the
 * plane's y direction. A fixed constraint target: `collinear(yAxis(), l)`,
 * `coincident(p, yAxis())`, `symmetric(a, b, yAxis())`,
 * `distance(yAxis(), c, 25)`. Also the sketch's own Y direction for the
 * in-sketch transforms — `mirror(yAxis(), g)`, `copy('linear', yAxis(),
 * …)` — where a bare `'y'` would mean WORLD y.
 */
export const yAxis = datumCommand('y-axis');
