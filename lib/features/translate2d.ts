import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { LazyVertex } from "./lazy-vertex.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";

export class Translate2D extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;

  constructor(
    private amount: LazyVertex,
    private plane: PlaneObjectBase,
  ) {
    super();
  }

  target(...objects: SceneObject[]): this {
    this._targetObjects = objects;
    return this;
  }

  get targetObjects(): SceneObject[] | null {
    return this._targetObjects;
  }

  build(context: BuildSceneObjectContext) {
    const objects = this.targetObjects || context.getSceneObjects();
    const p = this.plane.getPlane();
    const local = this.amount.asPoint2D();
    const worldOffset = p.xDirection.multiply(local.x).add(p.yDirection.multiply(local.y));

    for (const obj of objects) {
      const shapes = obj.getShapes({ excludeMeta: false });
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, Matrix4.fromTranslation(worldOffset.x, worldOffset.y, worldOffset.z));

        this.addShape(transformed);
        obj.removeShape(shape, this);
      }
    }

    this.plane.removeShapes(this);
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = this.targetObjects ? [...this.targetObjects] : [];
    deps.push(this.plane);
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const plane = (remap.get(this.plane) as PlaneObjectBase) || this.plane;
    const copy = new Translate2D(this.amount, plane);
    if (this.targetObjects) {
      copy.target(...this.targetObjects.map(obj => remap.get(obj) || obj));
    }
    return copy;
  }

  compareTo(other: Translate2D): boolean {
    if (!(other instanceof Translate2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.amount.compareTo(other.amount)) {
      return false;
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (!thisTargetObjects[i].compareTo(otherTargetObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "translate2d";
  }

  serialize() {
    return {
      amount: this.amount
    }
  }
}
