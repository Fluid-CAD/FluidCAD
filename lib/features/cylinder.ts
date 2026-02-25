import { SceneObject } from "../common/scene-object.js";
import { Primitives } from "../oc/primitives.js";

export class Cylinder extends SceneObject  {

  constructor(public radius: number, public height: number) {
    super();
  }

  build() {
    const cyl = Primitives.makeCylinder(this.radius, this.height);
    this.addShapes([cyl]);
  }

  compareTo(other: Cylinder): boolean {
    if (!(other instanceof Cylinder)) {
      return false;
    }

    return this.radius === other.radius && this.height === other.height;
  }

  getType(): string {
    return "cylinder";
  }

  serialize() {
    return {
      radius: this.radius,
      height: this.height,
    }
  }
}
