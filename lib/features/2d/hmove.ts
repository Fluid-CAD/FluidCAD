import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";

export class HMove extends GeometrySceneObject {
  constructor(public distance: number) {
    super();
  }

  getType() {
    return 'hmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    const newPos = new Point2D(pos.x + this.distance, pos.y);
    this.setCurrentPosition(newPos);
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new HMove(this.distance);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof HMove)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.distance === other.distance;
  }

  serialize() {
    return {
      distance: this.distance
    }
  }

}
