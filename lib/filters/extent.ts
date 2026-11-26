import { Plane } from "../math/plane.js";
import { Shape } from "../common/shape.js";
import { getOC } from "../oc/init.js";
import { ShapeOps } from "../oc/shape-ops.js";

/**
 * The least and greatest signed distance of a shape from a plane, for the
 * `above` / `below` filters. The kernel pads the bounds of a free-form curve
 * or surface by its confusion tolerance, so a distance within
 * {@link onPlaneSnap} of the plane reads as on it (zero): a curve that lies
 * in the plane or touches it is on neither side there, as an end vertex on
 * the plane is.
 */
export function extentDistances(shape: Shape, plane: Plane): [number, number] {
  const { min, max } = ShapeOps.extentAlong(shape, plane);
  return [onPlaneAsZero(min), onPlaneAsZero(max)];
}

/**
 * An interval that holds both of {@link extentDistances}, at no cost per
 * plane; null for a shape with no control hull to read it off (see
 * {@link ShapeOps.outerExtentAlong}). The hull bounds the shape itself, so
 * it is widened by the kernel's padding and snapped like the distances it
 * stands in for.
 */
export function extentBounds(shape: Shape, plane: Plane): [number, number] | null {
  const outer = ShapeOps.outerExtentAlong(shape, plane);
  if (!outer) {
    return null;
  }
  const padding = getOC().Precision.Confusion();
  return [onPlaneAsZero(outer.min - padding), onPlaneAsZero(outer.max + padding)];
}

/**
 * Two distances on the sides of `plane` that {@link extentDistances} are
 * on: the bounds of them when those clear the plane, which settles the side
 * without measuring the shape, and the distances themselves otherwise.
 */
export function extentSides(shape: Shape, plane: Plane): [number, number] {
  const outer = extentBounds(shape, plane);
  if (outer && (outer[0] > 0 || outer[1] < 0)) {
    return outer;
  }
  return extentDistances(shape, plane);
}

/**
 * How close to a plane a measured distance reads as on it: ten times the
 * kernel's confusion tolerance. That tolerance is 1e-7 of whatever unit the
 * document uses and is what the kernel pads a free-form bound by, so the
 * snap is a number of the kernel's own, never a length in millimetres — in
 * inches or metres a millimetre figure would fall below the padding.
 */
function onPlaneSnap(): number {
  // unit: OCCT floor
  return 10 * getOC().Precision.Confusion();
}

function onPlaneAsZero(distance: number): number {
  return Math.abs(distance) <= onPlaneSnap() ? 0 : distance;
}
