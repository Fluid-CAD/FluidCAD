// The regions of an extrudable source, keyed the way `.region()` accepts
// them — shared by the features that build from a source (ExtrudeBase) and
// the previews that only look at one (the dialog ghost, the region picker).

import { Edge } from "../../../common/edge.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Extrudable } from "../../../helpers/types.js";
import { Plane } from "../../../math/plane.js";
import { GeometrySceneObject } from "../geometry.js";
import { Sketch } from "../sketch.js";
import { SketchRegion, SketchRegionBuilder } from "./region-builder.js";
import { SketchStatementKeys } from "./statement-keys.js";

/** The sketch a statement sits in, or null for one outside any sketch. */
export function enclosingSketchOf(statement: SceneObject): Sketch | null {
  for (let parent = statement.getParent(); parent; parent = parent.getParent()) {
    if (parent instanceof Sketch) {
      return parent;
    }
  }
  return null;
}

/**
 * The regions of `source` on `plane`, keyed by their boundary statements.
 * A sketch reads its own statement keys; a primitive passed straight to an
 * operation (`extrude(10, c)`) reads the keys of the sketch it belongs to; a
 * source outside any sketch gets ordinal keys. `edges` overrides the edges
 * the source reports live — a preview of a consumed sketch reads them as if
 * nothing had consumed them.
 */
export function sourceRegions(
  source: Extrudable,
  plane: Plane,
  edges: Map<Edge, GeometrySceneObject> = source.getGeometriesWithOwner(),
): SketchRegion[] {
  if (source instanceof Sketch) {
    return new SketchRegionBuilder(edges, plane, source.statementKeys()).build();
  }
  const statements = [...new Set(edges.values())];
  const sketch = statements.map(enclosingSketchOf).find((s): s is Sketch => s !== null) ?? null;
  const keys = sketch
    ? sketch.statementKeys()
    : new SketchStatementKeys(statements, { sketchLocation: null, callbackSource: null });
  return new SketchRegionBuilder(edges, plane, keys).build();
}
