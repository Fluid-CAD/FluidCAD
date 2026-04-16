import { SceneObject } from "../common/scene-object.js";

export class Remove extends SceneObject {

  constructor(public objects: SceneObject[]) {
    super();
  }

  build() {
    for (const obj of this.objects) {
      obj.removeShapes(this, true);
    }
  }

  compareTo(other: Remove): boolean {
    if (!(other instanceof Remove)) {
      return false;
    }

    if (this.objects.length !== other.objects.length) {
      return false;
    }

     for (let i = 0; i < this.objects.length; i++) {
      if (!this.objects[i].compareTo(other.objects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return 'remove';
  }

  serialize() {
    return {
    }
  }
}
