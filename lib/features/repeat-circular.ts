import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";

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
    public axis: Axis,
    public options: CircularRepeatOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
    this.setAlwaysVisible()
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

    if (!this.axis.equals(other.axis)) {
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
