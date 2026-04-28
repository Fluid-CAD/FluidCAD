import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { findNearestRayIntersection } from "../../oc/ray-intersect.js";

export class PolarMove extends GeometrySceneObject {
  constructor(public radiusOrTarget: number | SceneObject, public angle: number) {
    super();
  }

  getType() {
    return 'pmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    const tangent = (this.sketch?.getTangentAt(this) ?? new Point2D(1, 0)).normalize();
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const direction = new Point2D(
      cos * tangent.x - sin * tangent.y,
      sin * tangent.x + cos * tangent.y
    );
    let newPos: Point2D;

    if (typeof this.radiusOrTarget === 'number') {
      newPos = new Point2D(
        pos.x + this.radiusOrTarget * direction.x,
        pos.y + this.radiusOrTarget * direction.y
      );
    } else {
      const plane = this.sketch.getPlane();
      const hit = findNearestRayIntersection(plane, pos, direction, this.radiusOrTarget);
      if (!hit) {
        throw new Error("Cannot move at the specified angle up to the geometry");
      }
      newPos = hit;
    }

    this.setCurrentPosition(newPos);

    const moveVec = newPos.subtract(pos);
    const moveLen = Math.hypot(moveVec.x, moveVec.y);
    if (moveLen > 1e-12) {
      this.setTangent(new Point2D(moveVec.x / moveLen, moveVec.y / moveLen));
    } else {
      this.setTangent(direction);
    }
  }

  override getDependencies(): SceneObject[] {
    if (this.radiusOrTarget instanceof SceneObject) {
      return [this.radiusOrTarget];
    }
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const radiusOrTarget = this.radiusOrTarget instanceof SceneObject
      ? (remap.get(this.radiusOrTarget) || this.radiusOrTarget)
      : this.radiusOrTarget;
    return new PolarMove(radiusOrTarget, this.angle);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof PolarMove)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if (typeof this.radiusOrTarget !== typeof other.radiusOrTarget) {
      return false;
    }
    if (this.radiusOrTarget instanceof SceneObject && other.radiusOrTarget instanceof SceneObject) {
      return this.radiusOrTarget.compareTo(other.radiusOrTarget);
    }
    return this.radiusOrTarget === other.radiusOrTarget;
  }

  serialize() {
    return {
      radius: typeof this.radiusOrTarget === 'number' ? this.radiusOrTarget : null,
      angle: this.angle
    }
  }

}
