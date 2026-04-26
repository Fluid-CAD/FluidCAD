import { Geometry } from "../../oc/geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { Point2D } from "../../math/point.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";

export class Ellipse extends ExtrudableGeometryBase {
  constructor(
    public rx: number,
    public ry: number,
    targetPlane: PlaneObjectBase = null,
    private centerOverride: Point2D | null = null,
  ) {
    super(targetPlane);
  }

  getType() {
    return 'ellipse';
  }

  build() {
    if (this.rx <= 0 || this.ry <= 0) {
      throw new Error(`Ellipse radii must be positive (rx=${this.rx}, ry=${this.ry})`);
    }

    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();
    const center = this.centerOverride
      ?? (this.targetPlane
        ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
        : this.getCurrentPosition());

    // OCC requires majorRadius >= minorRadius. Pick which plane axis carries the major.
    const rxIsMajor = this.rx >= this.ry;
    const major = rxIsMajor ? this.rx : this.ry;
    const minor = rxIsMajor ? this.ry : this.rx;
    const majorAxisDir = rxIsMajor ? plane.xDirection : plane.yDirection;

    const edge = Geometry.makeEllipseEdge(
      plane.localToWorld(center),
      major,
      minor,
      plane.normal,
      majorAxisDir,
    );

    this.addShape(edge);
    if (this.sketch) {
      this.setCurrentPosition(center);
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    return new Ellipse(this.rx, this.ry, targetPlane, this.centerOverride);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Ellipse)) {
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

    if (this.rx !== other.rx || this.ry !== other.ry) {
      return false;
    }

    if (this.centerOverride && other.centerOverride) {
      return this.centerOverride.x === other.centerOverride.x
        && this.centerOverride.y === other.centerOverride.y;
    }
    return this.centerOverride === other.centerOverride;
  }

  serialize() {
    return {
      rx: this.rx,
      ry: this.ry,
      ...(this.centerOverride ? { center: { x: this.centerOverride.x, y: this.centerOverride.y } } : {}),
    };
  }
}
