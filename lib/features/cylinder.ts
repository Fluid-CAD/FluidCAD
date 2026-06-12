import { TransformablePrimitive } from "../common/transformable-primitive.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Primitives } from "../oc/primitives.js";

export class Cylinder extends TransformablePrimitive  {

  constructor(public radius: number, public height: number) {
    super();
  }

  build(context?: BuildSceneObjectContext) {
    const cyl = Primitives.makeCylinder(this.radius, this.height);
    this.addPrimitiveShape(cyl, context);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Cylinder(this.radius, this.height).syncPrimitiveWith(this);
  }

  compareTo(other: Cylinder): boolean {
    if (!(other instanceof Cylinder)) {
      return false;
    }

    if (!super.compareTo(other)) {
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
