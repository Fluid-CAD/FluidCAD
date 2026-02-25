import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";

export class RMove extends GeometrySceneObject {
  constructor(public pivot: LazyVertex, public angle: number) {
    super();
  }

  getType() {
    return 'rmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    const newPos = pos.rotate(this.angle, this.pivot.asPoint2D());
    this.setCurrentPosition(newPos);
  }

  clone(): SceneObject[] {
    const move = new RMove(this.pivot, this.angle);
    return [move];
  }

  compareTo(other: this): boolean {
    if (!(other instanceof RMove)) {
      return false;
    }

    return this.pivot.compareTo(other.pivot) && this.angle === other.angle;
  }

  serialize() {
    return {
      pivot: this.pivot,
      angle: this.angle
    }
  }

}
