import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";

export type LinearRepeatOptions = {
  count: number | number[];
  centered?: boolean;
  skip?: number[][]
} & (
    | { offset: number; length?: never }
    | { length: number; offset?: never }
);

export class RepeatLinear extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;

  constructor(
    public axes: Axis[],
    public options: LinearRepeatOptions
    ) {
    super();
    this.setAlwaysVisible()
  }

  target(...objects: SceneObject[]): this {
    this._targetObjects = objects;
    return this;
  }

  get targetObjects(): SceneObject[] | null {
    return this._targetObjects;
  }

  build(context: BuildSceneObjectContext) {
    this.saveShapesSnapshot(context);
  }

  compareTo(other: RepeatLinear): boolean {
    if (!(other instanceof RepeatLinear)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.axes.length !== other.axes.length) {
      return false;
    }

    for (let i = 0; i < this.axes.length; i++) {
      if (!this.axes[i].equals(other.axes[i])) {
        return false;
      }
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

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "repeat-linear";
  }

  serialize() {
    return {
    }
  }
}
