import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { SectionOps } from "../../oc/section-ops.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Intersect extends ExtrudableGeometryBase {

  constructor(private sourceObjects: SceneObject[], targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  build(context?: BuildSceneObjectContext) {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const shapes = this.sourceObjects.flatMap(obj => obj.getShapes());
    const transform = context?.getTransform() ?? null;

    let lastEdge: Edge = null;

    for (let shape of shapes) {
      if (transform) {
        shape = ShapeOps.transform(shape, transform);
      }

      const edges = SectionOps.sectionShapeWithPlane(plane, shape);
      for (const edge of edges) {
        lastEdge = edge;
      }
      this.addShapes(edges);
    }

    if (lastEdge) {
      const localStart = plane.worldToLocal(lastEdge.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastEdge.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));
    }

    for (const obj of this.sourceObjects) {
      obj.removeShapes(this);
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
    return new Intersect(objects, targetPlane);
  }

  compareTo(other: Intersect): boolean {
    if (!(other instanceof Intersect)) {
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
      if (!thisObjects[i].compareTo(otherObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'intersect';
  }

  serialize() {
    return {
      objectIds: this.sourceObjects.map(o => o.id)
    };
  }
}
