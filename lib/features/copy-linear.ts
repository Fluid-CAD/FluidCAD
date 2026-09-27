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

  protected connectorOptionsRefusal(): string | null {
    // An axis counted below one numbers no cells at all — not even the
    // original's, which every connector copy's numbering is built around.
    const counts = CopyLayout.linearCounts(this.axes, this.options);
    for (let a = 0; a < this.axes.length; a++) {
      if (!(counts[a] >= 1)) {
        return `copy(): a connector copy needs a count of at least 1 on every axis (got ${counts[a]})`;
      }
    }
    return null;
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
}
