import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Axis } from "../math/axis.js";
import { Matrix4 } from "../math/matrix4.js";
import { Copy2DBase, SlotLayout, SlotTransform } from "./copy2d-base.js";
import { LinearCopyOptions } from "./copy-linear.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { AxisObject } from "./axis.js";
import { AxisFromSketch } from "./axis-from-sketch.js";
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
      // Skip shape-less siblings (constraint statements in a solved sketch).
      objects = allSiblings.filter(obj => obj.getShapes().length > 0);
    }

    // The sources keep their shapes — the copy owns only the duplicates it
    // stamps below, so the originals stay independent statements.
    this.recordSourceEntities(objects, { axes: this.axes });

    const layout = this.slotTransforms();
    for (const obj of objects) {
      for (const shape of obj.getShapes()) {
        this.recordInstanceShape(shape, layout.originalSlot);
      }
    }
    this.stampDuplicates(objects, layout.duplicates);
  }

  /**
   * Grid slots linearize the position tuple axis-major (axis 0 slowest),
   * matching the generation order below. The original block sits at ITS
   * grid position — slot 0 uncentered, the center slot when centered.
   * Shared by build() (stamping) and the statement-time duplicate-entity
   * registration, so the tie matrices and the stamped shapes agree.
   */
  protected slotTransforms(): SlotLayout {
    // resolveAxis, not getAxis: at statement time (duplicate-entity
    // registration) an AxisFromSketch has no build state yet — getAxis()
    // returns undefined and local('x') copies would silently register
    // nothing.
    const resolvedAxes: Axis[] = this.axes.map(a =>
      a instanceof AxisObjectBase ? a.resolveAxis() : a
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

    const slotIndex = (pos: number[]) =>
      pos.reduce((acc, v, a) => acc * counts[a] + v, 0);
    const originalSlot = slotIndex(centerIndices);
    const slotCount = counts.reduce((acc, c) => acc * c, 1);

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

    const duplicates: SlotTransform[] = [];
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

      duplicates.push({ slot: slotIndex(pos), matrix });
    }

    return { originalSlot, slotCount, duplicates };
  }

  protected statementSlotTransforms(): SlotLayout | null {
    // Constant transforms only (the same classification as
    // collectSourceEntities): a solver-driven axis (AxisFromEdge over a
    // solved line) moves with the solve — a constant tie matrix would
    // freeze the guess and disagree with the build-time stamping.
    for (const axis of this.axes) {
      const constant = axis instanceof Axis
        || axis instanceof AxisObject
        || axis instanceof AxisFromSketch;
      if (!constant) {
        return null;
      }
    }
    try {
      return this.slotTransforms();
    } catch {
      // e.g. an axis or plane that only resolves at build time.
      return null;
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
      ...this.sourceEntitiesPayload(),
      ...this.instanceEntitiesPayload(),
    }
  }
}
