import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { Edge } from "../common/edge.js";
import { requireShapes } from "../common/operand-check.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceOps } from "../oc/face-ops.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";
import type { Axis } from "../math/axis.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { PlaneFromObject } from "./plane-from-object.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";

/**
 * The plane a sketched line seeds: it contains the line and stands normal
 * to the line's sketch — the sheet the line would sweep out if it were
 * extruded both ways out of its sketch. The plane's x-direction is the
 * line's own direction and its normal is the line direction turned a
 * quarter turn inside the sketch (line × sketch normal), so the sides of a
 * split read left-to-right along the line. `center` is the line's midpoint,
 * where a datum quad is drawn.
 *
 * Shared with the split ghost, which reads the same line off the rendered
 * scene. Throws a `BuildError` naming what is wrong with the seed.
 */
export function sketchLinePlane(line: GeometrySceneObject, consumer = 'split'): { plane: Plane; center: Point } {
  const sketch = line.sketch;
  if (!sketch) {
    throw new BuildError(
      `${consumer}: the ${line.getType()} is not part of a sketch, so its plane has no sketch to stand normal to.`,
      "Seed the split with a line drawn inside a sketch, or pass a plane.",
    );
  }

  const edges = line.getShapes({ excludeGuide: false }).filter(s => s.isEdge()) as Edge[];
  if (edges.length !== 1) {
    throw new BuildError(
      `${consumer}: the ${line.getType()} resolves to ${edges.length} edges; a split seed is one straight line.`,
      "Pass a single line() of the sketch.",
    );
  }

  let axis: Axis;
  try {
    axis = EdgeOps.edgeToAxis(edges[0]);
  } catch {
    throw new BuildError(
      `${consumer}: the ${line.getType()} is not a straight line, so it does not seed a plane.`,
      "Seed the split with a line(), or pass a plane.",
    );
  }

  const sketchNormal = sketch.getPlane().normal.normalize();
  const direction = axis.direction.normalize();
  const normal = direction.cross(sketchNormal);
  if (normal.length() < 1e-9) {
    throw new BuildError(`${consumer}: the seed line runs along its sketch normal, which gives no plane.`);
  }

  const start = edges[0].getFirstVertex().toPoint();
  const end = edges[0].getLastVertex().toPoint();
  return {
    plane: new Plane(start, direction, normal.normalize()),
    center: start.lerp(end, 0.5),
  };
}

/**
 * The datum a `split(line, …)` names: the plane its seed line sweeps out of
 * its sketch (see {@link sketchLinePlane}). The line is only referenced —
 * never consumed — so it stays with its sketch for a constraint or a later
 * feature; the split itself hides the sketch for display, as an extrude
 * does its profile. A construction (guide) line is accepted, since that is
 * what a split seed usually is.
 */
export class PlaneFromSketchLine extends PlaneObjectBase {

  constructor(public readonly line: GeometrySceneObject) {
    super();
  }

  override validate() {
    requireShapes(this.line, "line", "split", { filter: { excludeGuide: false } });
  }

  build(_context?: BuildSceneObjectContext) {
    // The line's edge is already where its (possibly cloned) sketch put it;
    // the context transform is the clone's, which a copied datum applies
    // when it is read back through PlaneFromObject. Nothing to apply here.
    const { plane, center } = sketchLinePlane(this.line);

    this.setState('plane-center', center);
    this.setState('plane', plane);

    const face = FaceOps.planeToFace(plane, center);
    face.markAsMetaShape();
    this.addShape(face);
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    // Same as PlaneFromObject: the copy wraps this built plane as its
    // source and applies the clone transform on top of the resolved plane.
    return new PlaneFromObject(this);
  }

  compareTo(other: PlaneFromSketchLine): boolean {
    if (!(other instanceof PlaneFromSketchLine)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.line.compareTo(other.line);
  }

  getUniqueType(): string {
    return 'plane-from-sketch-line';
  }

  serialize() {
    const plane = this.getPlane();
    if (!plane) {
      return {};
    }
    return {
      origin: plane.origin,
      xDirection: plane.xDirection,
      yDirection: plane.yDirection,
      normal: plane.normal,
      center: this.getState('plane-center') || plane.origin,
    };
  }
}
