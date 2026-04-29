import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { PlaneRenderableOptions } from "../core/plane.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { FaceOps } from "../oc/face-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { SelectSceneObject } from "./select.js";
import { Face } from "../common/face.js";
import { Point } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { requireShapes } from "../common/operand-check.js";

export class PlaneFromObject extends PlaneObjectBase {

  constructor(public sourceObject: SceneObject, public options?: PlaneRenderableOptions) {
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

    if (this.options) {
      // Apply the same transform to the center so the preview face stays on
      // the rotated plane instead of floating at its pre-rotation position.
      const matrix = plane.getTransformMatrix(this.options);
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
    return new PlaneFromObject(this, this.options);
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

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
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
      options: this.options,
      center: this.getState('plane-center') || plane.origin,
    }
  }
}
