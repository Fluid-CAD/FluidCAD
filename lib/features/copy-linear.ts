import { SceneObject } from "../common/scene-object.js";
import { type NumberParam } from "../core/param.js";
import { CopyAxisSource, CopyBase } from "./copy-base.js";
import { CopyLayout, CopySlotLayout } from "./copy-layout.js";

export type LinearCopyOptions = {
  count: NumberParam | number[];
  centered?: boolean;
  skip?: number[][]
} & (
    | { offset: NumberParam | number[]; length?: never }
    | { length: NumberParam | number[]; offset?: never }
);

export class CopyLinear extends CopyBase {
  constructor(
    public axes: CopyAxisSource[],
    public options: LinearCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  slotLayout(): CopySlotLayout {
    return CopyLayout.linear(this.axes, this.options);
  }

  compareTo(other: CopyLinear): boolean {
    if (!(other instanceof CopyLinear)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.axes.length !== other.axes.length) {
      return false;
    }

    for (let i = 0; i < this.axes.length; i++) {
      if (!CopyLinear.axisSourceEquals(this.axes[i], other.axes[i])) {
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
    return "copy-linear";
  }

  serialize() {
    return {
    }
  }
}
