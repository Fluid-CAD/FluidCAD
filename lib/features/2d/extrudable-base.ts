import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Extrudable } from "../../helpers/types.js";
import { GeometrySceneObject } from "./geometry.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Plane } from "../../math/plane.js";
import { IExtrudableGeometry } from "../../core/interfaces.js";

export abstract class ExtrudableGeometryBase extends GeometrySceneObject implements Extrudable, IExtrudableGeometry {

  constructor(protected targetPlane?: PlaneObjectBase) {
    super();
  }

  isExtrudable(): boolean {
    return true;
  }

  getGeometries(): (Wire | Edge)[] {
    return this.getShapes() as Edge[];
  }

  getGeometriesWithOwner(): Map<Wire | Edge, GeometrySceneObject> {
    const geometries = new Map<Wire | Edge, GeometrySceneObject>();

    for (const shape of this.getShapes()) {
      if (shape instanceof Edge) {
        geometries.set(shape, this);
      }
    }

    return geometries;
  }

  getPlane(): Plane {
    return this.targetPlane ? this.targetPlane.getPlane() : this.sketch.getPlane();
  }
}
