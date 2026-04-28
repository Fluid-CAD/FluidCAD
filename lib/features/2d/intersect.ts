import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { SectionOps } from "../../oc/section-ops.js";
import { WireOps } from "../../oc/wire-ops.js";
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

    const allEdges: Edge[] = [];
    for (const shape of shapes) {
      const edges = SectionOps.sectionShapeWithPlane(plane, shape);
      allEdges.push(...edges);
      this.addShapes(edges);
    }

    // Section across multiple source faces yields an unordered edge set that
    // may form one connected chain, several disjoint chains, or closed loops.
    // Take the first connected group and use its actual chain endpoints —
    // not an arbitrary edge's vertices, which can land on interior junctions.
    if (allEdges.length > 0) {
      const groups = WireOps.groupConnectedEdges(allEdges);
      const endpoints = WireOps.findChainEndpoints(groups[0]);
      if (endpoints) {
        const localStart = plane.worldToLocal(endpoints.start.toPoint());
        const localEnd = plane.worldToLocal(endpoints.end.toPoint());

        this.setState('start', Vertex.fromPoint2D(localStart));
        this.setState('end', Vertex.fromPoint2D(localEnd));
      }
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
