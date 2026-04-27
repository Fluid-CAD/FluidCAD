import { SceneObject } from "../../common/scene-object.js";
import { GeometrySceneObject } from "./geometry.js";

export class Back extends GeometrySceneObject {
  constructor(public count: number) {
    super();
  }

  getType() {
    return 'back';
  }

  build() {
    const target = this.sketch.getPreviousPosition(this, this.count);
    this.setCurrentPosition(target);
  }

  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Back(this.count);
  }

  compareTo(other: this): boolean {
    if (!(other instanceof Back)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.count === other.count;
  }

  serialize() {
    return {
      count: this.count
    }
  }
}
