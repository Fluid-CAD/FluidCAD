import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export class Rotate extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;
  private _excludedObjects: SceneObject[] = [];

  constructor(
    public axis: AxisObjectBase,
    public angle: number,
    private copy: boolean = false,
    ...targets: SceneObject[]) {
    super();
    this._targetObjects = targets.length > 0 ? targets : null;
  }

  get targetObjects(): SceneObject[] {
    return this._targetObjects;
  }

  exclude(...objects: SceneObject[]): this {
    this._excludedObjects.push(...objects);
    return this;
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    let targetObjects = this.targetObjects;
    let parent: SceneObject | null = null;

    if (this.parentId) {
      parent = this.getParent();
      objects = parent.getPreviousSiblings(this);
    }
    else {
      objects = context.getSceneObjects();
    }

    if (this.targetObjects && this.targetObjects.length > 0) {
      targetObjects = objects.filter(obj => this.targetObjects.includes(obj));
    }
    else {
      targetObjects = objects;
    }

    if (this._excludedObjects.length > 0) {
      targetObjects = targetObjects.filter(obj => !this._excludedObjects.includes(obj));
    }

    this.axis.removeShapes(this)

    const axis = this.axis.getAxis();
    const matrix = Matrix4.fromRotationAroundAxis(axis.origin, axis.direction, rad(this.angle));

    for (const obj of targetObjects) {
      const shapes = obj.getShapes();
      for (const shape of shapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        transformed.setMeshSource(shape, matrix);
        this.addShape(transformed);
        if (!this.copy) {
          obj.removeShape(shape, this);
        }
      }
    }
  }

  compareTo(other: Rotate): boolean {
    if (!(other instanceof Rotate)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.copy !== other.copy) {
      return false;
    }

    if (this.angle !== other.angle) {
      return false;
    }

    if (this.axis) {
      if (!this.axis.compareTo(other.axis)) {
        return false;
      }
    }

    const thisTargetObjects = this.targetObjects || [];
    const otherTargetObjects = other.targetObjects || [];

    if (thisTargetObjects.length !== otherTargetObjects.length) {
      return false;
    }

    for (let i = 0; i < thisTargetObjects.length; i++) {
      if (thisTargetObjects[i] !== otherTargetObjects[i]) {
        return false;
      }
    }

    if (this._excludedObjects.length !== other._excludedObjects.length) {
      return false;
    }

    for (let i = 0; i < this._excludedObjects.length; i++) {
      if (this._excludedObjects[i] !== other._excludedObjects[i]) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "rotate";
  }

  serialize() {
    return {
      angle: this.angle
    }
  }
}
