import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Axis } from "../math/axis.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { AxisObjectBase } from "./axis-renderable-base.js";
import { Connector } from "./connector.js";
import { ConnectorCopy, ConnectorCopyRules, ConnectorCopyScope, ConnectorFamily } from "./connector-copy.js";
import { Part } from "./part.js";
import type { CopySlot, CopySlotLayout } from "./copy-layout.js";

/** An axis a copy can follow: a concrete Axis or a scene-resident axis object. */
export type CopyAxisSource = Axis | AxisObjectBase;

/**
 * Shared base for the 3D copy features. A copy takes the shapes its targets
 * hold and adds one moved clone of them per slot of its layout — the slots
 * `CopyLayout` numbers from the statement's axes and options.
 *
 * Connector targets never go through that shape path (a connector's only
 * shape is its meta marker): each one gets a {@link ConnectorFamily} instead,
 * one {@link ConnectorCopy} per placed slot, made when the statement runs and
 * folded away under it like a repeat's clones.
 *
 * Also holds axis-source equality for `compareTo`, which runs during
 * cache-compare — before any render — when an `AxisObjectBase` source may not
 * yet have its resolved `Axis` state. The slot moves read the axis lazily, at
 * build time, safe because an axis object is always added to the scene (and
 * thus built) before the copy that consumes it.
 */
export abstract class CopyBase extends SceneObject {

  /**
   * Explicit targets, connectors included, or null for the target-less
   * "copy everything before me" form.
   */
  abstract targetObjects: SceneObject[] | null;

  /** The families this statement made, one per connector target, in target order. */
  private families: ConnectorFamily[] = [];

  /**
   * The statement's slots. Safe at parse time: counts resolve from the
   * options, and each slot's move stays lazy until build.
   */
  abstract slotLayout(): CopySlotLayout;

  /**
   * Why the statement's own options can't copy a connector — a count below
   * one, or a form connector copies don't support yet — or null.
   */
  protected abstract connectorOptionsRefusal(): string | null;

  override hidesChildren(): boolean {
    return true;
  }

  /** The explicit targets that are connectors, in target order. */
  connectorTargets(): Connector[] {
    return (this.targetObjects ?? []).filter((target): target is Connector => target instanceof Connector);
  }

  /**
   * Copy the connector targets: one family per seed, one copy per placed
   * slot, parented under this statement — called when the statement runs,
   * right after it joins the scene; the builder registers the returned
   * copies after it, so they build after their seeds and axes. A target
   * {@link ConnectorCopyRules} refuses — or options a connector copy can't
   * take — refuses the whole statement instead, and nothing is copied.
   */
  copyConnectors(scope: ConnectorCopyScope): ConnectorCopy[] {
    const seeds = this.connectorTargets();
    if (seeds.length === 0) {
      return [];
    }
    const refusal = ConnectorCopyRules.seedRefusal(seeds, scope) ?? this.connectorOptionsRefusal();
    if (refusal) {
      this.refuse(refusal);
      return [];
    }
    const layout = this.slotLayout();
    const copies: ConnectorCopy[] = [];
    for (const seed of seeds) {
      const family = new ConnectorFamily(seed, this, layout.originalSlot, layout.slotCount);
      for (const { slot, matrix } of layout.slots) {
        const copy = new ConnectorCopy(seed, slot, matrix);
        this.addChildObject(copy);
        family.add(copy);
        copies.push(copy);
      }
      seed.attachFamily(family);
      this.families.push(family);
    }
    if (copies.length > 0) {
      // Like a repeat's row: shown while its copies draw, whatever later
      // features do to the shapes it copies.
      this.setAlwaysVisible();
    }
    return copies;
  }

  build(context: BuildSceneObjectContext) {
    const objects = this.shapeTargets(context);

    const originalShapes = objects.flatMap(obj => obj.getShapes());
    for (const obj of objects) {
      obj.removeShapes(this);
    }
    for (const shape of originalShapes) {
      this.addShape(shape);
    }

    this.stampSlots(originalShapes, this.slotLayout().slots);
  }

  /**
   * The targets whose shapes the statement copies: the explicit ones that
   * aren't connectors — none at all when every explicit target is one, never
   * the target-less fallback — or, for the target-less form, everything
   * still active before it but the enclosing part. That part is a member of
   * its own scope, yet its shapes are its members', each listed on its own:
   * taking it too copied every solid twice and, removing through it, stripped
   * every member — a connector's marker included, though a copy without
   * targets never copies connectors.
   */
  private shapeTargets(context: BuildSceneObjectContext): SceneObject[] {
    if (this.targetObjects === null) {
      return context.getActiveSceneObjects()
        .filter(obj => !(obj instanceof Part) && !(obj instanceof Connector));
    }
    return this.targetObjects.filter(target => !(target instanceof Connector));
  }

  /** One moved clone of every original shape per slot, in slot order. */
  private stampSlots(originalShapes: Shape[], slots: CopySlot[]): void {
    for (const { matrix } of slots) {
      const placement = matrix.resolve();
      for (const shape of originalShapes) {
        const transformed = ShapeOps.transform(shape, placement);
        transformed.setMeshSource(shape, placement);
        this.addShape(transformed);
      }
    }
  }

  protected static axisSourceEquals(a: CopyAxisSource, b: CopyAxisSource): boolean {
    const aObj = a instanceof AxisObjectBase;
    const bObj = b instanceof AxisObjectBase;
    if (aObj !== bObj) {
      return false;
    }
    if (aObj) {
      return a.compareTo(b as AxisObjectBase);
    }
    return (a as Axis).equals(b as Axis);
  }

  getDisplayType(): string {
    return "Copy";
  }

  /**
   * The connector families the statement made — for a row that copies
   * connectors, the seeds (ids read live, as the render emits them), the
   * pattern's numbering and the slots its copies sit at. Nothing otherwise.
   */
  serialize() {
    if (this.families.length === 0) {
      return {};
    }
    const [first] = this.families;
    return {
      connectorCopies: {
        seeds: this.families.map(family => ({ id: family.seed.id, name: family.seed.connectorName })),
        originalSlot: first.originalSlot,
        slotCount: first.slotCount,
        slots: first.getCopies().map(copy => copy.slot),
      },
    };
  }
}
