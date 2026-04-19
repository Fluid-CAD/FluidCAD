import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";

export type LinearCopyOptions = {
  count: number | number[];
  centered?: boolean;
  skip?: number[][]
} & (
    | { offset: number | number[]; length?: never }
    | { length: number | number[]; offset?: never }
);

export class CopyLinear extends SceneObject {
  constructor(
    public axes: Axis[],
    public options: LinearCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let objects = this.targetObjects;

    if (!this.targetObjects) {
      objects = context.getActiveSceneObjects();
    }

    const { count, centered, skip } = this.options;

    const counts = Array.isArray(count)
      ? count
      : this.axes.map(() => count);

    const offsets = 'offset' in this.options && this.options.offset !== undefined
      ? (Array.isArray(this.options.offset) ? this.options.offset : this.axes.map(() => this.options.offset as number))
      : null;

    const lengths = 'length' in this.options && this.options.length !== undefined
      ? (Array.isArray(this.options.length) ? this.options.length : this.axes.map(() => this.options.length as number))
      : null;

    const axisOffsets = this.axes.map((_, a) => {
      if (offsets) {
        return offsets[a] ?? offsets[0];
      }
      const len = lengths ? (lengths[a] ?? lengths[0]) : 1;
      const axisCount = counts[a];
      return axisCount > 1 ? len / (axisCount - 1) : 0;
    });

    const centerIndices = this.axes.map((_, a) =>
      centered ? Math.floor(counts[a] / 2) : 0
    );

    // Build grid positions as cartesian product of per-axis indices (0..counts[a]-1)
    let positions: number[][] = [[]];
    for (let a = 0; a < this.axes.length; a++) {
      const next: number[][] = [];
      for (const pos of positions) {
        for (let i = 0; i < counts[a]; i++) {
          next.push([...pos, i]);
        }
      }
      positions = next;
    }

    for (const pos of positions) {
      if (pos.every((idx, a) => idx === centerIndices[a])) continue;
      if (skip?.some(coord => coord.every((v, a) => v === pos[a]))) {
        continue;
      }

      let matrix = Matrix4.identity();
      for (let a = 0; a < this.axes.length; a++) {
        const distance = (pos[a] - centerIndices[a]) * axisOffsets[a];
        const translation = this.axes[a].direction.multiply(distance);
        matrix = matrix.multiply(Matrix4.fromTranslationVector(translation));
      }

      for (const obj of objects) {
        for (const shape of obj.getShapes()) {
          const transformed = ShapeOps.transform(shape, matrix);
          transformed.setMeshSource(shape, matrix);
          this.addShape(transformed);
        }
      }
    }
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
    return "copy-linear";
  }

  serialize() {
    return {
    }
  }
}
