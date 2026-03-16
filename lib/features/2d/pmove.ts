import { Point2D } from "../../math/point.js";
import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";

export class PolarMove extends GeometrySceneObject {
  constructor(public radius: number, public angle: number) {
    super();
  }

  getType() {
    return 'pmove';
  }

  build() {
    const pos = this.getCurrentPosition();
    const newPos = new Point2D(
      pos.x + this.radius * Math.cos(this.angle),
      pos.y + this.radius * Math.sin(this.angle)
    );
    this.setCurrentPosition(newPos);
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new PolarMove(this.radius, this.angle);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof PolarMove)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.radius === other.radius && this.angle === other.angle;
  }

  serialize() {
    return {
      radius: this.radius,
      angle: this.angle
    }
  }

}
