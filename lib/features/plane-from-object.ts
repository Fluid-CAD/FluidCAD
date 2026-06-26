import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { EdgePlanePosition, PlaneRenderableOptions } from "../core/plane.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { WireOps } from "../oc/wire-ops.js";
import { PathFrame, PathSampler } from "../oc/path-sampler.js";
import { SelectSceneObject } from "./select.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { requireShapes } from "../common/operand-check.js";

export class PlaneFromObject extends PlaneObjectBase {

  constructor(
    public sourceObject: SceneObject,
    public optionsOrPosition?: PlaneRenderableOptions | EdgePlanePosition
  ) {
    super();
  }

  override validate() {
    // PlaneObjectBase sources expose the plane directly — no shapes required.
    if (this.sourceObject instanceof PlaneObjectBase) {
      return;
    }
    requireShapes(this.sourceObject, "source", "plane");
  }

  build(context?: BuildSceneObjectContext) {
    // An edge source produces a plane normal to the edge at a position along
    // it. The face-vs-edge decision is deferred to here (rather than the
    // plane() builder) because the source shape type is only known once the
    // selection has been resolved.
    if (!(this.sourceObject instanceof PlaneObjectBase)) {
      const shapes = this.sourceObject.getShapes({ excludeGuide: false });
      if (shapes.length === 1 && shapes[0].isEdge()) {
        this.buildFromEdge(context, shapes[0] as Edge);
        return;
      }
    }

    let plane: Plane;
    let sourceFace: Face;
    let center: Point | undefined;

    if (this.sourceObject instanceof PlaneObjectBase) {
      plane = this.getFromPlaneObject(this.sourceObject);
      center = (this.sourceObject as PlaneObjectBase).getPlaneCenter();
    } else {
      const extract = this.getFromSceneObject(this.sourceObject);

      plane = extract.plane;
      sourceFace = extract.sourceFace;
    }

    this.sourceObject.removeShapes(this);

    if (sourceFace) {
      const bbox = ShapeOps.getBoundingBox(sourceFace.getShape());
      center = new Point(bbox.centerX, bbox.centerY, bbox.centerZ);
    }

    const options = this.faceOptions();
    if (options) {
      // Apply the same transform to the center so the preview face stays on
      // the rotated plane instead of floating at its pre-rotation position.
      const matrix = plane.getTransformMatrix(options);
      plane = plane.applyMatrix(matrix);
      if (center) {
        center = center.transform(matrix);
      }
    }

    const transform = context?.getTransform() ?? null;
    if (transform) {
      plane = plane.applyMatrix(transform);

      if (center) {
        center = center.transform(transform);
      }
    }

    if (center) {
      this.setState('plane-center', center);
    }

    this.setState('plane', plane);

    const face = FaceOps.planeToFace(plane, center);

    face.markAsMetaShape();
    this.addShape(face);
  }

  /**
   * Builds a plane normal to `edge` at the configured position. The edge
   * tangent at that point becomes the plane normal; the in-plane axes are
   * an arbitrary (but deterministic) basis around it.
   */
  private buildFromEdge(context: BuildSceneObjectContext | undefined, edge: Edge) {
    const t = normalizeEdgePosition(this.optionsOrPosition);
    const frame = sampleEdgeFrame(edge, t);

    // The forward tangent points *into* the edge at the start, so the plane
    // would face inward there. Flip it at the start endpoint so it faces
    // outward — like an extrude's start cap (the end already faces outward via
    // the forward tangent). Interior/end positions keep the forward tangent.
    const normal = t <= 0 ? frame.tangent.negate() : frame.tangent;

    let plane = Plane.fromPointAndNormal(frame.point, normal);
    let center: Point = frame.point;

    // Unlike the face path, an edge is only *referenced* to derive the plane —
    // it is not consumed, so it stays available to its owning solid and to
    // other features.

    const transform = context?.getTransform() ?? null;
    if (transform) {
      plane = plane.applyMatrix(transform);
      center = center.transform(transform);
    }

    this.setState('plane-center', center);
    this.setState('plane', plane);

    const face = FaceOps.planeToFace(plane, center);
    face.markAsMetaShape();
    this.addShape(face);
  }

  /**
   * Resolves the second argument for a face/plane source. A bare number is a
   * normal-offset distance; a string position is only meaningful for edges
   * and is rejected here.
   */
  private faceOptions(): PlaneRenderableOptions | undefined {
    const value = this.optionsOrPosition;
    if (value == null) {
      return undefined;
    }
    if (typeof value === 'number') {
      return { offset: value };
    }
    if (typeof value === 'string') {
      throw new Error(`Plane: position '${value}' is only valid for an edge source`);
    }
    return value;
  }

  getFromSceneObject(sceneObject: SceneObject) {
    const shapes = sceneObject.getShapes();

    console.log(`Plane: Retrieved ${shapes.length} shapes from selection`, shapes);

    if (shapes.length === 0) {
      throw new Error("Plane: Selected object has no shapes to extract plane from");
    }

    let sourceFace: Face = shapes[0] as Face;

    if (!sourceFace.isFace()) {
      throw new Error("Plane: Selected shape is not a face; cannot extract plane: " + sourceFace.getType());
    }

    let plane = sourceFace.getPlane();
    console.log('Plane: Extracted plane from face', plane.normal);

    return { plane, sourceFace };
  }

  getFromPlaneObject(sceneObject: PlaneObjectBase) {
    let plane = sceneObject.getPlane();

    return plane;
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new PlaneFromObject(this, this.optionsOrPosition);
  }

  compareTo(other: PlaneFromObject): boolean {
    if (!(other instanceof PlaneFromObject)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.sourceObject.compareTo(other.sourceObject)) {
      return false;
    }

    if (JSON.stringify(this.optionsOrPosition) !== JSON.stringify(other.optionsOrPosition)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'plane-from-face';
  }

  serialize() {
    const plane = this.getPlane()
    return {
      origin: plane.origin,
      xDirection: plane.xDirection,
      yDirection: plane.yDirection,
      normal: plane.normal,
      options: this.optionsOrPosition,
      center: this.getState('plane-center') || plane.origin,
    }
  }
}

/**
 * Evaluates the point and unit (forward) tangent on `edge` at a normalized
 * position `t` (`0` = start, `1` = end), measured by arc length.
 */
function sampleEdgeFrame(edge: Edge, t: number): PathFrame {
  const wire = WireOps.makeWireFromEdges([edge]);
  const sampler = new PathSampler(wire);
  try {
    return sampler.evalAt(t * sampler.length);
  } finally {
    sampler.dispose();
  }
}

function normalizeEdgePosition(
  position: PlaneRenderableOptions | EdgePlanePosition | undefined
): number {
  if (position === undefined) {
    return 0;
  }
  if (typeof position === 'number') {
    return position;
  }
  switch (position) {
    case 'start':
      return 0;
    case 'middle':
      return 0.5;
    case 'end':
      return 1;
  }
  throw new Error(
    "Plane: an edge plane takes a 0–1 position or 'start'/'middle'/'end', not transform options"
  );
}
