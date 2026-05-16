import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { RepeatAxisSource } from "./repeat-linear.js";

function axisOf(source: RepeatAxisSource): Axis {
  return source instanceof AxisObjectBase ? source.getAxis() : source;
}

export type CircularRepeatOptions = {
  count: number;
  centered?: boolean;
  skip?: number[];
} & (
    | { offset: number; angle?: never }
    | { angle: number; offset?: never }
);

export class RepeatCircular extends SceneObject {
  constructor(
    public axis: RepeatAxisSource,
    public options: CircularRepeatOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
    this.setAlwaysVisible()
  }

  isContainer(): boolean {
      return true;
  }

  build(context: BuildSceneObjectContext) {
    this.saveShapesSnapshot(context);
  }

  compareTo(other: RepeatCircular): boolean {
    if (!(other instanceof RepeatCircular)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!axisOf(this.axis).equals(axisOf(other.axis))) {
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

    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "repeat-circular";
  }

  serialize() {
    return {
    }
  }
}
