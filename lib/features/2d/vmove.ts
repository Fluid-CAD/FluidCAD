import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";

export class VMove extends GeometrySceneObject {
  constructor(public distance: number) {
    super();
  }

  getType() {
    return 'vmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    const newPos = new Point2D(pos.x, pos.y + this.distance);
    this.setCurrentPosition(newPos);
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new VMove(this.distance);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof VMove)) {
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
