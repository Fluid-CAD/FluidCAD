import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { GeometrySceneObject } from "./geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { WireOps } from "../../oc/wire-ops.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class SlotFromEdge extends ExtrudableGeometryBase {

  constructor(
    public sourceGeometry: GeometrySceneObject,
    public radius: number,
    public deleteSource: boolean = true,
    targetPlane: PlaneObjectBase = null,
  ) {
    super(targetPlane);
  }

  build(): void {
    const shapes = this.sourceGeometry.getShapes(false);

    if (shapes.length === 0) {
      throw new Error("SlotFromEdge: source geometry has no edges or wires");
    }

    for (const shape of shapes) {
      if (shape.isEdge() || shape.isWire()) {
        const wire = WireOps.offsetWire(shape as (Wire | Edge), this.radius, false);
        this.addShape(wire);
      }
    }

    if (this.deleteSource) {
      this.sourceGeometry.removeShapes(this);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  getType(): string {
    return 'slot';
  }

  getUniqueType(): string {
    return 'slot-from-edge';
  }

  override clone(): SceneObject[] {
    const targetPlane = this.targetPlane ? this.targetPlane.clone()[0] as PlaneObjectBase : null;
    return [new SlotFromEdge(this.sourceGeometry, this.radius, this.deleteSource, targetPlane)];
  }

  compareTo(other: SlotFromEdge): boolean {
    if (!(other instanceof SlotFromEdge)) {
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

    return this.sourceGeometry.compareTo(other.sourceGeometry) &&
      this.radius === other.radius &&
      this.deleteSource === other.deleteSource;
  }

  serialize() {
    return {
      radius: this.radius,
    };
  }
}
