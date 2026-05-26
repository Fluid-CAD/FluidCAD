import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { RepeatBase, RepeatAxisSource } from "./repeat-base.js";

export type CircularRepeatOptions = {
  count: number;
  centered?: boolean;
  skip?: number[];
} & (
    | { offset: number; angle?: never }
    | { angle: number; offset?: never }
);

export class RepeatCircular extends RepeatBase {
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
    if (this.axis instanceof AxisObjectBase) {
      this.axis.removeShapes(this);
    }
    this.saveShapesSnapshot(context);
  }

  compareTo(other: RepeatCircular): boolean {
    if (!(other instanceof RepeatCircular)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!RepeatCircular.axisSourceEquals(this.axis, other.axis)) {
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
