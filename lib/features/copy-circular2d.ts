import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { rad } from "../helpers/math-helpers.js";
import { Copy2DBase, SlotLayout, SlotTransform } from "./copy2d-base.js";
import { LazyVertex } from "./lazy-vertex.js";
import { CircularCopyOptions } from "./copy-circular.js";
import { SolvedPointRef } from "./2d/solved/refs.js";
import { ReferencePointRef } from "./2d/solved/reference.js";
import { type NumberParam, resolveParam } from "../core/param.js";

export class CopyCircular2D extends Copy2DBase {
  constructor(
    public center: LazyVertex,
    public options: CircularCopyOptions,
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
    // Rotation-step slots: the original is 0, step i is i — the same
    // numbering the circular `skip` option uses.
    this.recordSourceEntities(objects, { center: this.center });

    const layout = this.slotTransforms();
    for (const obj of objects) {
      for (const shape of obj.getShapes()) {
        this.recordInstanceShape(shape, layout.originalSlot);
      }
    }
    this.stampDuplicates(objects, layout.duplicates);

    // Pen state stays a legacy concept — never written in a solved sketch.
    if (!this.sketch.isSolvedMode()) {
      this.setCurrentPosition(this.center.asPoint2D())
    }
  }

  /**
   * Rotation steps about the center: the original is slot 0, step i is
   * slot i. Shared by build() (stamping) and the statement-time
   * duplicate-entity registration, so the tie matrices and the stamped
   * shapes agree.
   */
  protected slotTransforms(): SlotLayout {
    const plane = this.sketch.getPlane();
    const origin = plane.localToWorld(this.center.asPoint2D());
    const direction = plane.normal;

    const count = resolveParam(this.options.count as NumberParam);
    const { centered, skip } = this.options;

    let offset: number;
    if ('offset' in this.options && this.options.offset !== undefined) {
      offset = resolveParam(this.options.offset as NumberParam);
    } else {
      offset = resolveParam((this.options as { angle: NumberParam }).angle) / count;
    }

    const startOffset = centered ? -(count * offset) / 2 : 0;

    const duplicates: SlotTransform[] = [];
    for (let i = 1; i < count; i++) {
      if (skip?.includes(i)) continue;

      const angle = startOffset + offset * i;
      duplicates.push({ slot: i, matrix: Matrix4.fromRotationAroundAxis(origin, direction, rad(angle)) });
    }

    return { originalSlot: 0, slotCount: count, duplicates };
  }

  protected statementSlotTransforms(): SlotLayout | null {
    // Constant centers only: a solver-backed center (c.center()) moves with
    // the solve — a constant tie matrix would freeze the guess and disagree
    // with the build-time stamping. Reading it here would also poison the
    // build's post-solve read (LazyVertex caches its first resolution).
    if (this.center instanceof SolvedPointRef || this.center instanceof ReferencePointRef) {
      return null;
    }
    try {
      return this.slotTransforms();
    } catch {
      // e.g. a center or plane that only resolves at build time.
      return null;
    }
  }

  compareTo(other: CopyCircular2D): boolean {
    if (!(other instanceof CopyCircular2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.center.compareTo(other.center)) {
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

  getUniqueType(): string {
    return "copy-circular-2d";
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
