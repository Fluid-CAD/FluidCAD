import { Edge } from "../../common/edge.js";
import { WireOps } from "../../oc/wire-ops.js";
import { GeometrySceneObject } from "./geometry.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { Wire } from "../../common/wire.js";

export class WireObject extends ExtrudableGeometryBase {

  constructor(private geometries: GeometrySceneObject[] | null, targetPlane: PlaneObjectBase = null) {
    super(targetPlane);
  }

  build() {
    const sources = this.geometries ?? this.sketch.getPreviousSiblings(this) as GeometrySceneObject[];

    const allEdges: Edge[] = [];
    for (const obj of sources) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        if (shape instanceof Edge) {
          allEdges.push(shape);
          obj.removeShape(shape, this);
        }
        else if (shape instanceof Wire) {
          const edges = shape.getEdges();
          allEdges.push(...edges);
          obj.removeShape(shape, this);
        }
      }
    }

    const groups = WireOps.groupConnectedEdges(allEdges);
    for (const group of groups) {
      const wire = WireOps.makeWireFromEdges(group);
      this.addShape(wire);
    }

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
