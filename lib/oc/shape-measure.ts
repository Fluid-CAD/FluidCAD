import type { TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Shape } from "../common/shape.js";
import type { Edge } from "../common/edge.js";
import type { Face } from "../common/face.js";
import { EdgeProps } from "./edge-props.js";
import { FaceProps } from "./face-props.js";

/**
 * Mass-property measures the rank filters compare shapes by. Edges and
 * curves measure through `LinearProperties` (length, center of the curve),
 * faces and bodies through `SurfaceProperties` (area, center of the
 * surface). The center is the center of mass, not a bounding extreme: a box's four rim edges and its vertical
 * edges all touch the top plane, but only the rim's centers lie on it, which
 * is what makes `farthest('z')` return the rim.
 */
export class ShapeMeasure {
  // Geometry is immutable per wrapper, and the rank filters re-measure the
  // same candidates on every evaluation (the synthesizer runs them dozens of
  // times per pick), so measures are memoized per wrapper for its lifetime.
  private static centers = new WeakMap<Shape, Point>();
  private static sizes = new WeakMap<Shape, number>();
  private static radii = new WeakMap<Shape, number | null>();

  static centerOfMass(shape: Shape): Point {
    return ShapeMeasure.centers.get(shape) ?? ShapeMeasure.measure(shape).center;
  }

  /** Edge length, or face area — the shape's natural size measure. */
  static size(shape: Shape): number {
    return ShapeMeasure.sizes.get(shape) ?? ShapeMeasure.measure(shape).size;
  }

  /**
   * The centre and the size come out of one integration, which on a
   * free-form face costs milliseconds: whichever is asked for first keeps
   * both.
   */
  private static measure(shape: Shape): { center: Point; size: number } {
    const props = ShapeMeasure.properties(shape);
    try {
      const cog = props.CentreOfMass();
      const center = new Point(cog.X(), cog.Y(), cog.Z());
      cog.delete();
      const size = props.Mass();
      ShapeMeasure.centers.set(shape, center);
      ShapeMeasure.sizes.set(shape, size);
      return { center, size };
    } finally {
      props.delete();
    }
  }

  /**
   * Radius of a circular edge/arc, or of a cylindrical/spherical/toroidal
   * (minor) face; null for shapes without a radius.
   */
  static radius(shape: Shape): number | null {
    const cached = ShapeMeasure.radii.get(shape);
    if (cached !== undefined) {
      return cached;
    }
    const radius = ShapeMeasure.measureRadius(shape);
    ShapeMeasure.radii.set(shape, radius);
    return radius;
  }

  private static measureRadius(shape: Shape): number | null {
    if (shape.isEdge()) {
      const props = EdgeProps.of(shape as Edge);
      return props.radius ?? null;
    }
    if (shape.isFace()) {
      const props = FaceProps.of(shape as Face);
      if (props.radius !== undefined) {
        return props.radius;
      }
      return props.minorRadius ?? null;
    }
    return null;
  }

  private static properties(shape: Shape) {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    const raw: TopoDS_Shape = shape.getShape();
    if (shape.isEdge() || shape.isWire()) {
      oc.BRepGProp.LinearProperties(raw, props, false, false);
    } else {
      oc.BRepGProp.SurfaceProperties(raw, props, false, false);
    }
    return props;
  }
}
