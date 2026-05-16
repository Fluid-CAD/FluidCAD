import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";

export type RepeatAxisSource = Axis | AxisObjectBase;

function axisOf(source: RepeatAxisSource): Axis {
  return source instanceof AxisObjectBase ? source.getAxis() : source;
}

export type LinearRepeatOptions = {
  count: number | number[];
  centered?: boolean;
  skip?: number[][]
} & (
    | { offset: number | number[]; length?: never }
    | { length: number | number[]; offset?: never }
);

export class RepeatLinear extends SceneObject {
  constructor(
    public axes: RepeatAxisSource[],
    public options: LinearRepeatOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
    this.setAlwaysVisible()
  }

  isContainer(): boolean {
      return true;
  }

  build(context: BuildSceneObjectContext) {
    for (const axis of this.axes) {
      if (axis instanceof AxisObjectBase) {
        axis.removeShapes(this);
      }
    }
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
      if (!axisOf(this.axes[i]).equals(axisOf(other.axes[i]))) {
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
