import { Shape } from "../common/shape.js";
import { Plane } from "../math/plane.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BoundingBox } from "./types.js";
import { mmTol } from "../units/tolerance.js";

/** How far past the model a through-all extrusion runs, as a fraction of its reach. */
export const THROUGH_ALL_MARGIN = 1.1;

/** Through-all length when the scene offers nothing to size against, in mm. */
export const THROUGH_ALL_FALLBACK_MM = 100;

/** {@link THROUGH_ALL_FALLBACK_MM} in the active unit — read at use time, never at load. */
export function throughAllFallback(): number {
  return mmTol(THROUGH_ALL_FALLBACK_MM);
}

/** The farthest a box's corners sit from the plane, along its normal. */
export function normalReach(box: BoundingBox, plane: Plane): number {
  const origin = plane.origin;
  const n = plane.normal;
  let reach = 0;
  for (const x of [box.minX, box.maxX]) {
    for (const y of [box.minY, box.maxY]) {
      for (const z of [box.minZ, box.maxZ]) {
        const d = (x - origin.x) * n.x + (y - origin.y) * n.y + (z - origin.z) * n.z;
        reach = Math.max(reach, Math.abs(d));
      }
    }
  }
  return reach;
}

export function boxDiagonal(box: BoundingBox): number {
  const dx = box.maxX - box.minX;
  const dy = box.maxY - box.minY;
  const dz = box.maxZ - box.minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * How far a through-all extrusion has to run to clear `stock`, measured from
 * `plane` along its normal and padded by {@link THROUGH_ALL_MARGIN}.
 *
 * Neither a truly infinite prism nor a flat stand-in for one works here. OC's
 * `Inf=true` flag makes `BRepAlgoAPI_Cut` silently fail (verified
 * experimentally), and a fixed large length is worse than it looks: OCCT sizes
 * the tolerance of every intersection curve against the faces that produced
 * it, so a tool hundreds of metres long against a part tens of millimetres
 * wide comes back with tolerances in the tens of millimetres. The cut raises a
 * warning, the result fails `BRepCheck_Analyzer`, and `ShapeFix_Shape` then
 * shreds it down to a couple of faces. (Seen with a repeated symmetric
 * through-all cut into a drafted cone: a 200 m tool produced a 2-face solid
 * whose cone would not mesh; the same cut sized to the model is clean.)
 *
 * `profile` is the fallback when there is no stock to measure — a cut with
 * nothing to cut still needs a non-zero prism to build.
 */
export function throughAllLength(stock: Shape[], profile: Shape[], plane: Plane): number {
  let reach = 0;
  for (const solid of stock) {
    reach = Math.max(reach, normalReach(ShapeOps.getBoundingBox(solid), plane));
  }
  if (reach === 0) {
    for (const shape of profile) {
      reach = Math.max(reach, boxDiagonal(ShapeOps.getBoundingBox(shape)));
    }
  }
  return reach > 0 ? reach * THROUGH_ALL_MARGIN : throughAllFallback();
}
