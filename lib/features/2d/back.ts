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
    const { position, tangent } = this.sketch.getPreviousState(this, this.count);
    this.setCurrentPosition(position);
    this.setTangent(tangent);
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
