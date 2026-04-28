import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { findNearestRayIntersection } from "../../oc/ray-intersect.js";

export class HMove extends GeometrySceneObject {
  constructor(public distanceOrTarget: number | SceneObject) {
    super();
  }

  getType() {
    return 'hmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    let newPos: Point2D;

    if (typeof this.distanceOrTarget === 'number') {
      newPos = new Point2D(pos.x + this.distanceOrTarget, pos.y);
    } else {
      const plane = this.sketch.getPlane();
      const hit = findNearestRayIntersection(plane, pos, new Point2D(1, 0), this.distanceOrTarget);
      if (!hit) {
        throw new Error("Cannot move horizontally up to the specified geometry");
      }
      newPos = hit;
    }

    this.setCurrentPosition(newPos);
  }

  override getDependencies(): SceneObject[] {
    if (this.distanceOrTarget instanceof SceneObject) {
      return [this.distanceOrTarget];
    }
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const distanceOrTarget = this.distanceOrTarget instanceof SceneObject
      ? (remap.get(this.distanceOrTarget) || this.distanceOrTarget)
      : this.distanceOrTarget;
    return new HMove(distanceOrTarget);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof HMove)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (typeof this.distanceOrTarget !== typeof other.distanceOrTarget) {
      return false;
    }
    if (this.distanceOrTarget instanceof SceneObject && other.distanceOrTarget instanceof SceneObject) {
      return this.distanceOrTarget.compareTo(other.distanceOrTarget);
    }
    return this.distanceOrTarget === other.distanceOrTarget;
  }

  serialize() {
    return {
      distance: typeof this.distanceOrTarget === 'number' ? this.distanceOrTarget : null
    }
  }

}
