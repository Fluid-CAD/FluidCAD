import { Point, PointLike } from "../math/point.js";
import { LazyVertex } from "./lazy-vertex.js";
import { SketchPointVertex } from "./sketch-point-ref.js";
import { SceneObject } from "../common/scene-object.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { withUnit } from "../units/registry.js";

/** Resolves points for consumers outside sketches, where coordinates are world-space. */
export class PointResolver {
  /** The world-space position a point names. */
  static toWorld(point: PointLike | LazyVertex): Point {
    return PointResolver.resolve(point, false);
  }

  /**
   * The world-space displacement a point names (a translation amount, an
   * offset). A sketch point is a displacement inside its sketch plane: it
   * turns with the plane but does not pick up the plane's origin.
   */
  static toWorldVector(point: PointLike | LazyVertex): Point {
    return PointResolver.resolve(point, true);
  }

  private static resolve(point: PointLike | LazyVertex, asVector: boolean): Point {
    let resolved: Point;
    if (point instanceof SketchPointVertex) {
      const sketch = point.getSketch();
      const plane = sketch?.getPlane();
      if (!sketch || !plane) {
        throw new Error("Sketch point reference has no built sketch plane.");
      }
      sketch.ensureSolvedForBuild();
      resolved = plane.localToWorld(point.localPoint());
      if (asVector) {
        resolved = resolved.subtract(plane.origin);
      }
    } else if (point instanceof LazyVertex) {
      PointResolver.prepareSelections(point);
      resolved = point.asPoint();
    } else if (Array.isArray(point)) {
      resolved = new Point(point[0], point[1], point[2]);
    } else if (point && typeof point === 'object') {
      resolved = new Point(point.x, point.y, point.z);
    } else {
      throw new Error("Expected a point with three finite coordinates or a vertex reference.");
    }
    if (!resolved.toArray().every(Number.isFinite)) {
      throw new Error("Point coordinates must be finite numbers.");
    }
    return resolved;
  }

  private static prepareSelections(object: SceneObject, seen = new Set<SceneObject>()): void {
    if (seen.has(object)) {
      return;
    }
    seen.add(object);
    // Chained .connect() references are created after the loft statement;
    // inline accessor selections have no earlier scene build slot. Resolve
    // only those lazy selections, never rebuild their producing features.
    for (const dependency of object.getDependencies()) {
      if (dependency.isLazy()) {
        PointResolver.prepareSelections(dependency, seen);
      }
    }
    if (object instanceof LazySelectionSceneObject) {
      withUnit(object.getUnit(), () => object.build());
    }
  }
}
