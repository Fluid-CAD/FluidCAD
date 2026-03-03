import { Edge } from "../../common/edge.js";
import { WireOps } from "../../oc/wire-ops.js";
import { GeometrySceneObject } from "./geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class WireObject extends ExtrudableGeometryBase {

  constructor(private geometries: GeometrySceneObject[], targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  build() {
    let sources = this.geometries;

    const map = new Map<SceneObject, Edge[]>();
    for (const obj of sources) {
      const edges = obj.getShapes().filter(s => s instanceof Edge) as Edge[];
      map.set(obj, edges);
    }

    const allEdges: Edge[] = [];
    for (const [obj, edges] of map.entries()) {
      for (const edge of edges) {
        allEdges.push(edge);
        obj.removeShape(edge, this);
      }
    }

    const wire = WireOps.makeWireFromEdges(allEdges);
    this.addShape(wire);

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  compareTo(other: WireObject): boolean {
    if (!(other instanceof WireObject)) {
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

    const thisGeometries = this.geometries || [];
    const otherGeometries = other.geometries || [];

    if (thisGeometries.length !== otherGeometries.length) {
      return false;
    }

    for (let i = 0; i < thisGeometries.length; i++) {
      const thisGeo = thisGeometries[i];
      const otherGeo = otherGeometries[i];

      if (thisGeo.getUniqueType() !== otherGeo.getUniqueType()) {
        return false;
      }

      if (!thisGeo.compareTo(otherGeo)) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'wire'
  }

  getUniqueType(): string {
    return 'wire';
  }

  serialize() {
    return {
    }
  }
}
