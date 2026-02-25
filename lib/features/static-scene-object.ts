import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";

export class StaticSceneObject extends SceneObject {

  constructor(public shapes: Shape[]) {
    super();

    this.build();
  }

  build() {
    this.addShapes(this.shapes);
  }

  compareTo(other: StaticSceneObject): boolean {
    return true;
  }

  getType(): string {
    return "static";
  }

  serialize() {
    return {
    }
  }
}
