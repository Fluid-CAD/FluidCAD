import { SceneObject } from "../common/scene-object.js";
import { type NumberParam } from "../core/param.js";
import { CopyAxisSource, CopyBase } from "./copy-base.js";
import { CopyLayout, CopySlotLayout } from "./copy-layout.js";

export type CircularCopyOptions = {
  count: NumberParam;
  centered?: boolean;
  skip?: number[]
} & (
    | { offset: NumberParam; angle?: never }
    | { angle: NumberParam; offset?: never }
);

export class CopyCircular extends CopyBase {
  constructor(
    public axis: CopyAxisSource,
    public options: CircularCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  slotLayout(): CopySlotLayout {
    return CopyLayout.circular(this.axis, this.options);
  }

  compareTo(other: CopyCircular): boolean {
    if (!(other instanceof CopyCircular)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!CopyCircular.axisSourceEquals(this.axis, other.axis)) {
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
    return "copy-circular";
  }

  serialize() {
    return {
    }
  }
}
