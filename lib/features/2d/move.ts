import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

export class Move extends GeometrySceneObject {
  constructor(public targetPosition: LazyVertex) {
    super();
  }

  getType() {
    return 'move';
  }

  build() {
    const point = this.targetPosition.asPoint2D();
    this.setCurrentPosition(point);
  }

  clone(): SceneObject[] {
    const move = new Move(this.targetPosition);
    return [move];
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Move)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.targetPosition.compareTo(other.targetPosition);
  }

  serialize() {
    return {
      position: this.targetPosition
    }
  }

}
