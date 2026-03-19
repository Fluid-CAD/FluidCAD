import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { degree, rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Sketch } from "./2d/sketch.js";

export type CircularCopyOptions = {
  count: number;
  centered?: boolean;
  skip?: number[]
} & (
    | { offset: number; angle?: never }
    | { angle: number; offset?: never }
);

export class CopyCircular extends SceneObject {
  private _targetObjects: SceneObject[] | null = null;

  constructor(
    public axis: Axis,
    public options: CircularCopyOptions
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
    let objects = this.targetObjects;

    if (!this.targetObjects) {
      const parent = this.getParent() as Sketch;
      if (parent) {
        objects = parent.getPreviousSiblings(this);
      }
      else {
        objects = context.getActiveSceneObjects();
      }
    }

    const { count, centered, skip } = this.options;

    let offset: number;
    if ('offset' in this.options && this.options.offset !== undefined) {
      offset = this.options.offset;
    } else {
      offset = this.options.angle / count;
    }

    const startOffset = centered ? -(count * offset) / 2 : 0;

    for (let i = 1; i < count; i++) {
      if (skip?.includes(i)) continue;

      const angle = startOffset + offset * i;
      const matrix = Matrix4.fromRotationAroundAxis(this.axis.origin, this.axis.direction, rad(angle));

      for (const obj of objects) {
        for (const shape of obj.getShapes()) {
          const transformed = ShapeOps.transform(shape, matrix);
          this.addShape(transformed);
        }
      }
    }
  }

  compareTo(other: CopyCircular): boolean {
    if (!(other instanceof CopyCircular)) {
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
    return "copy-circular";
  }

  serialize() {
    return {
    }
  }
}
