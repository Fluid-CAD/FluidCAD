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
    const shapes = this.sourceGeometry.getShapes({ excludeGuide: false });

    if (shapes.length === 0) {
      throw new Error("SlotFromEdge: source geometry has no edges or wires");
    }

    // A straight source segment has no curvature for BRepOffsetAPI_MakeOffset
    // to infer the offset plane from — the face-less Init fails with "Failed
    // to offset wire" — so pass the sketch/target plane as the reference face
    // (the same regression Offset2D fixed).
    const plane = this.getPlane();
    for (const shape of shapes) {
      if (shape.isEdge() || shape.isWire()) {
        const wire = WireOps.offsetWire(shape as (Wire | Edge), this.radius, false, plane);
        this.addShapes(wire.getEdges());
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

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = this.targetPlane ? [this.targetPlane] : [];
    deps.push(this.sourceGeometry);
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    // The source must remap to its new-scene counterpart — a copy holding the
    // previous render's geometry would offset stale (disposed) OC shapes.
    const source = (remap.get(this.sourceGeometry) as GeometrySceneObject) ?? this.sourceGeometry;
    return new SlotFromEdge(source, this.radius, this.deleteSource, targetPlane);
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
