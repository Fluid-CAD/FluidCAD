import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Solid } from "../common/shapes.js";

export class Subtract extends SceneObject {

  constructor(public solid1: SceneObject, public solid2: SceneObject) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const stock = this.solid1.getShapes();
    const toBeRemoved = this.solid2.getShapes();

    const stockCompound = ShapeOps.makeCompound(stock);
    const toBeRemovedCompound = ShapeOps.makeCompound(toBeRemoved);

    const result = p.record('Cut solids', () => BooleanOps.cutShapes(stockCompound, toBeRemovedCompound));
    const shapes = Explorer.findShapes(result.getShape(), Explorer.getOcShapeType("solid"));

    const newShapes = shapes.map(s => ShapeOps.cleanShapeRaw(s)).map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));

    for (const shape of toBeRemoved) {
      this.solid2.removeShape(shape, this);
    }

    for (const shape of stock) {
      this.solid1.removeShape(shape, this);
    }

    this.addShapes(newShapes);
  }

  compareTo(other: Subtract): boolean {
    if (!(other instanceof Subtract)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.solid1.constructor !== other.solid1.constructor
      || this.solid2.constructor !== other.solid2.constructor) {
      return false;
    }

    if (!this.solid1.compareTo(other.solid1) || !this.solid2.compareTo(other.solid2)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "subtract";
  }

  serialize() {
    return {
      shape1: this.solid1.serialize(),
      shape2: this.solid2.serialize()
    }
  }
}
