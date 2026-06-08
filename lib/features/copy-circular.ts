import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { type NumberParam, resolveParam } from "../core/param.js";

export type CircularCopyOptions = {
  count: NumberParam;
  centered?: boolean;
  skip?: number[]
} & (
    | { offset: NumberParam; angle?: never }
    | { angle: NumberParam; offset?: never }
);

export class CopyCircular extends SceneObject {
  constructor(
    public axis: Axis,
    public options: CircularCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let objects = this.targetObjects;

    if (!this.targetObjects) {
      objects = context.getActiveSceneObjects();
    }

    const originalShapes = objects.flatMap(obj => obj.getShapes());
    for (const obj of objects) {
      obj.removeShapes(this);
    }
    for (const shape of originalShapes) {
      this.addShape(shape);
    }

    const count = resolveParam(this.options.count as NumberParam);
    const { centered, skip } = this.options;

    let offset: number;
    if ('offset' in this.options && this.options.offset !== undefined) {
      offset = resolveParam(this.options.offset as NumberParam);
    } else {
      offset = resolveParam((this.options as { angle: NumberParam }).angle) / count;
    }

    const startOffset = centered ? -(count * offset) / 2 : 0;

    for (let i = 1; i < count; i++) {
      if (skip?.includes(i)) continue;

      const angle = startOffset + offset * i;
      const matrix = Matrix4.fromRotationAroundAxis(this.axis.origin, this.axis.direction, rad(angle));

      for (const shape of originalShapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        transformed.setMeshSource(shape, matrix);
        this.addShape(transformed);
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
