import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";
import { ProjectionOps } from "../../oc/intersection.js";
import { Wire } from "../../common/wire.js";
import { SelectSceneObject } from "../select.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Projection extends ExtrudableGeometryBase {

  constructor(private sourceObjects: SceneObject[], targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  build(context?: BuildSceneObjectContext) {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const shapes = this.sourceObjects.flatMap(obj => obj.getShapes());
    const transform = context?.getTransform() ?? null;
    let projection: Wire[] = [];
    for (let shape of shapes) {
      if (transform) {
        shape = ShapeOps.transform(shape, transform);
      }

      if (shape instanceof Face) {
        const wires = ProjectionOps.projectFaceOntoPlane(plane, shape as Face);
        projection.push(...wires);
      }
      else if (shape instanceof Wire) {
        const firstEdge = shape.getEdges()[0];
        const wires = ProjectionOps.projectEdgeOntoPlane(plane, firstEdge);
        projection.push(...wires);
      }
      else if (shape instanceof Edge) {
        const wires = ProjectionOps.projectEdgeOntoPlane(plane, shape);
        projection.push(...wires);
      }
    }

    for (const wire of projection) {
      this.addShape(wire);
    }

    for (const obj of this.sourceObjects) {
      if (obj instanceof SelectSceneObject) {
        obj.removeShapes(this);
      }
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }

    if (this.sketch) {
      this.setCurrentPosition(this.getCurrentPosition());
    }
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [...this.sourceObjects];
    if (this.targetPlane) {
      deps.push(this.targetPlane);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const objects = this.sourceObjects.map(obj => remap.get(obj) || obj);
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    return new Projection(objects, targetPlane);
  }

  compareTo(other: Projection): boolean {
    if (!(other instanceof Projection)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    const thisObjects = this.sourceObjects || [];
    const otherObjects = other.sourceObjects || [];

    if (thisObjects.length !== otherObjects.length) {
      return false;
    }

    for (let i = 0; i < thisObjects.length; i++) {
      const thisObj = thisObjects[i];
      const otherObj = otherObjects[i];

      if (!thisObj.compareTo(otherObj)) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'projection';
  }

  serialize() {
    return {
      objectIds: this.sourceObjects.map(o => o.id)
    };
  }
}
