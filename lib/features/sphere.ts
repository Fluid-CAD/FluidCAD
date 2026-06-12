import { TransformablePrimitive } from "../common/transformable-primitive.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Primitives } from "../oc/primitives.js";

export class Sphere extends TransformablePrimitive {

  constructor(public radius: number, public angle: number) {
    super();
  }

  build(context?: BuildSceneObjectContext) {
    const sphere = Primitives.makeSphere(this.radius, this.angle);
    this.addPrimitiveShape(sphere, context);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Sphere(this.radius, this.angle).syncPrimitiveWith(this);
  }

  compareTo(other: Sphere): boolean {
    if (!(other instanceof Sphere)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.radius === other.radius && this.angle === other.angle;
  }

  getType(): string {
    return "sphere";
  }

  serialize() {
    return {
      radius: this.radius,
      angle: this.angle,
    }
  }
}
