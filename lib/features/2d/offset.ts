import { WireOps } from "../../oc/wire-ops.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Offset extends ExtrudableGeometryBase {

  constructor(
    private distance: number,
    private removeOriginal: boolean = false,
    private sourceGeometries: SceneObject[] = null,
    targetPlane: PlaneObjectBase = null,
  ) {
    super(targetPlane);
  }

  build() {
    let sourceObjects: Map<Wire | Edge, SceneObject>;
    if (this.sketch) {
      sourceObjects = this.sketch.getGeometriesWithOwner();
    }
    else {
      sourceObjects = new Map<Wire | Edge, SceneObject>();
      for (const obj of this.sourceGeometries) {
        const shapes = obj.getShapes();
        for (const shape of shapes) {
          if (shape instanceof Wire || shape instanceof Edge) {
            sourceObjects.set(shape, obj);
          }
        }
      }

      this.targetPlane.removeShapes(this);
    }

    for (const [wire, owner] of sourceObjects) {
      const isOpen = !wire.isClosed()
      const offsetWire = WireOps.offsetWire(wire, this.distance, isOpen);

      this.addShape(offsetWire);

      if (this.removeOriginal && owner) {
        owner.removeShape(wire, this);
      }
    }
  }

  clone(): SceneObject[] {
    const targetPlane = this.targetPlane ? this.targetPlane.clone()[0] as PlaneObjectBase : null;
    const geometriesClone = this.sourceGeometries ? this.sourceGeometries.map(obj => obj.clone()).flat() : null;
    return [new Offset(this.distance, this.removeOriginal, geometriesClone, targetPlane)];
  }

  compareTo(other: Offset): boolean {
    if (!(other instanceof Offset)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }

    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    if ((this.sourceGeometries === null) !== (other.sourceGeometries === null)) {
      return false;
    }

    if (this.sourceGeometries && other.sourceGeometries) {
      if (this.sourceGeometries.length !== other.sourceGeometries.length) {
        return false;
      }

      for (let i = 0; i < this.sourceGeometries.length; i++) {
        const obj1 = this.sourceGeometries[i];
        const obj2 = other.sourceGeometries[i];
        if (!obj1.compareTo(obj2)) {
          return false;
        }
      }
    }

    return this.distance === other.distance && this.removeOriginal === other.removeOriginal;
  }

  getType(): string {
    return 'offset';
  }

  serialize() {
    return {
      distance: this.distance,
      removeOriginal: this.removeOriginal
    };
  }
}
