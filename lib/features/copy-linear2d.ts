import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Copy2DBase } from "./copy2d-base.js";
import { LinearCopyOptions } from "./copy-linear.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { type NumberParam, resolveParam } from "../core/param.js";

export type CopyLinear2DAxis = Axis | AxisObjectBase;

export class CopyLinear2D extends Copy2DBase {
  constructor(
    public axes: CopyLinear2DAxis[],
    public options: LinearCopyOptions,
    public targetObjects: SceneObject[] | null = null
    ) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    this.resetInstances();
    let objects: SceneObject[];
    const allSiblings = this.sketch.getPreviousSiblings(this);

    if (this.targetObjects && this.targetObjects.length > 0) {
      objects = allSiblings.filter(obj => this.targetObjects.includes(obj));
    } else {
      objects = allSiblings;
    }

    const originalShapes = objects.flatMap(obj => obj.getShapes());
    for (const obj of objects) {
      obj.removeShapes(this);
    }
    for (const shape of originalShapes) {
      this.addShape(shape);
    }

    const resolvedAxes: Axis[] = this.axes.map(a =>
      a instanceof AxisObjectBase ? a.getAxis() : a
    );

    const { centered, skip } = this.options;

    const counts = Array.isArray(this.options.count)
      ? this.options.count
      : resolvedAxes.map(() => resolveParam(this.options.count as NumberParam));

    const offsets = 'offset' in this.options && this.options.offset !== undefined
      ? (Array.isArray(this.options.offset) ? this.options.offset : resolvedAxes.map(() => resolveParam(this.options.offset as NumberParam)))
      : null;

    const lengths = 'length' in this.options && this.options.length !== undefined
      ? (Array.isArray(this.options.length) ? this.options.length : resolvedAxes.map(() => resolveParam(this.options.length as NumberParam)))
      : null;

    const axisOffsets = resolvedAxes.map((_, a) => {
      if (offsets) {
        return offsets[a] ?? offsets[0];
      }
      const len = lengths ? (lengths[a] ?? lengths[0]) : 1;
      const axisCount = counts[a];
      return axisCount > 1 ? len / (axisCount - 1) : 0;
    });

    const centerIndices = resolvedAxes.map((_, a) =>
      centered ? Math.floor(counts[a] / 2) : 0
    );

    // Grid slots linearize the position tuple axis-major (axis 0 slowest),
    // matching the generation order below. The original block sits at ITS
    // grid position — slot 0 uncentered, the center slot when centered.
    const slotIndex = (pos: number[]) =>
      pos.reduce((acc, v, a) => acc * counts[a] + v, 0);
    const originalSlot = slotIndex(centerIndices);
    for (const shape of originalShapes) {
      this.recordInstanceShape(shape, originalSlot);
    }

    // Build grid positions as cartesian product of per-axis indices (0..counts[a]-1)
    let positions: number[][] = [[]];
    for (let a = 0; a < resolvedAxes.length; a++) {
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
      for (let a = 0; a < resolvedAxes.length; a++) {
        const distance = (pos[a] - centerIndices[a]) * axisOffsets[a];
        const translation = resolvedAxes[a].direction.multiply(distance);
        matrix = matrix.multiply(Matrix4.fromTranslationVector(translation));
      }

      for (const shape of originalShapes) {
        const transformed = ShapeOps.transform(shape, matrix);
        transformed.setMeshSource(shape, matrix);
        this.addShape(transformed);
        this.recordInstanceShape(transformed, slotIndex(pos));
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
      const a = this.axes[i];
      const b = other.axes[i];
      const aIsObj = a instanceof AxisObjectBase;
      const bIsObj = b instanceof AxisObjectBase;
      if (aIsObj !== bIsObj) {
        return false;
      }
      if (aIsObj) {
        if (!a.compareTo(b as AxisObjectBase)) {
          return false;
        }
      }
      else if (!(a as Axis).equals(b as Axis)) {
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

  getDisplayType(): string {
    return "Copy";
  }

  serialize() {
    return {
    }
  }
}
