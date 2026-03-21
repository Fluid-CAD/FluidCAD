import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { LinearCopyOptions } from "./copy-linear.js";

export class CopyLinear2D extends GeometrySceneObject {
  constructor(
    public axes: Axis[],
    public options: LinearCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    let objects: SceneObject[];
    const allSiblings = this.sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      objects = allSiblings.filter(obj => this.targetObjects.includes(obj));
    } else {
      objects = allSiblings;
    }

    let length = this.options.length || 1;
    const { count, centered, skip } = this.options;

    // Normalize count to per-axis array
    const counts = Array.isArray(count)
      ? count
      : this.axes.map(() => count);

    let offset: number;
    if ('offset' in this.options && this.options.offset !== undefined) {
      offset = this.options.offset;
    } else {
      offset = length / Math.max(...counts);
    }

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
      if (pos.every(idx => idx === 0)) continue;
      if (skip?.some(coord => coord.every((v, a) => v === pos[a]))) {
        continue;
      }

      let matrix = Matrix4.identity();
      for (let a = 0; a < this.axes.length; a++) {
        const axisCount = counts[a];
        const startOffset = centered ? -(axisCount * offset) / 2 : 0;
        const distance = startOffset + offset * pos[a];
        const translation = this.axes[a].direction.multiply(distance);
        matrix = matrix.multiply(Matrix4.fromTranslationVector(translation));
      }

      for (const obj of objects) {
        for (const shape of obj.getShapes()) {
          const transformed = ShapeOps.transform(shape, matrix);
          this.addShape(transformed);
        }
      }
    }
  }

  compareTo(other: CopyLinear2D): boolean {
    if (!(other instanceof CopyLinear2D)) {
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

  getUniqueType(): string {
    return "copy-linear-2d";
  }

  serialize() {
    return {
    }
  }
}
