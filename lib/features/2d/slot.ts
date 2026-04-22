import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { SceneObject } from "../../common/scene-object.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { ISlot } from "../../core/interfaces.js";

export class Slot extends ExtrudableGeometryBase implements ISlot {
  private _center: boolean = false;

  constructor(
    public distance: number,
    public radius: number,
    targetPlane: PlaneObjectBase = null,
  ) {
    super(targetPlane);
  }

  centered(value: boolean = true): this {
    this._center = value;
    return this;
  }

  build(): void {
    if (this.distance < 0) {
      throw new Error("Slot distance must be positive");
    }

    const plane = this.targetPlane?.getPlane() || (this.getParent() as Sketch).getPlane();
    const localToWorld = plane.localToWorld.bind(plane);

    let leftCenter = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();

    if (this._center) {
      leftCenter = leftCenter.translate(-this.distance / 2, 0);
    }

    const rightCenter = new Point2D(
      leftCenter.x + this.distance,
      leftCenter.y
    );

    // Four key points where lines meet arcs
    const topLeft = new Point2D(leftCenter.x, leftCenter.y + this.radius);
    const topRight = new Point2D(rightCenter.x, rightCenter.y + this.radius);
    const bottomRight = new Point2D(rightCenter.x, rightCenter.y - this.radius);
    const bottomLeft = new Point2D(leftCenter.x, leftCenter.y - this.radius);

    // Top line: topLeft -> topRight
    const topSegment = Geometry.makeSegment(
      localToWorld(topLeft),
      localToWorld(topRight)
    );

    // Right arc: topRight -> bottomRight (CW semicircle around rightCenter)
    const rightArc = Geometry.makeArc(
      localToWorld(rightCenter),
      this.radius,
      plane.normal.negate(),
      localToWorld(topRight),
      localToWorld(bottomRight)
    );

    // Bottom line: bottomRight -> bottomLeft
    const bottomSegment = Geometry.makeSegment(
      localToWorld(bottomRight),
      localToWorld(bottomLeft)
    );

    // Left arc: bottomLeft -> topLeft (CW semicircle around leftCenter)
    const leftArc = Geometry.makeArc(
      localToWorld(leftCenter),
      this.radius,
      plane.normal.negate(),
      localToWorld(bottomLeft),
      localToWorld(topLeft)
    );

    const edges: Edge[] = [
      Geometry.makeEdge(topSegment),
      Geometry.makeEdgeFromCurve(rightArc),
      Geometry.makeEdge(bottomSegment),
      Geometry.makeEdgeFromCurve(leftArc),
    ];

    this.addShapes(edges);

    if (this.sketch) {
      if (this._center) {
        this.setCurrentPosition(this.getCurrentPosition());
      } else {
        this.setCurrentPosition(leftCenter);
      }
    }

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  getType(): string {
    return 'slot';
  }

  override getDependencies(): SceneObject[] {
    return this.targetPlane ? [this.targetPlane] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane) : null;
    const s = new Slot(this.distance, this.radius, targetPlane);
    s.centered(this._center);
    return s;
  }

  compareTo(other: Slot): boolean {
    if (!(other instanceof Slot)) {
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

    return this.distance === other.distance &&
      this.radius === other.radius &&
      this._center === other._center;
  }

  serialize() {
    return {
      distance: this.distance,
      radius: this.radius,
      centered: this._center,
    };
  }
}
