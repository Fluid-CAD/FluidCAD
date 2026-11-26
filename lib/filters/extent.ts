import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { mmTol } from "../units/tolerance.js";

/**
 * The least and greatest signed distance of a shape from a plane, for the
 * `above` / `below` filters. The kernel pads the bounds of a free-form curve
 * or surface by its confusion tolerance (1e-7), so a distance within 1e-6 of
 * the plane reads as on it (zero): a curve that lies in the plane or touches
 * it is on neither side there, as an end vertex on the plane is.
 */
export function extentDistances(shape: Shape, plane: Plane): [number, number] {
  const { min, max } = ShapeOps.extentAlong(shape, plane);
  return [onPlaneAsZero(min), onPlaneAsZero(max)];
}

function onPlaneAsZero(distance: number): number {
  return Math.abs(distance) <= mmTol(1e-6) ? 0 : distance;
}
