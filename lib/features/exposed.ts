import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import type { ContactEntity } from "../oc/contact-classify.js";
import { classifyContact } from "./contact-chain.js";

/**
 * Wire form of an exposure: the name plus the canonical contact geometry a
 * tangent mate solves against, in part-local frame. `seed: null` marks an
 * unsupported surface form (torus / freeform) — the mate record build fails
 * that mate loudly instead of silently no-op'ing.
 */
export type SerializedExposure = {
  name: string;
  seed: ContactEntity | null;
  chain: ContactEntity[];
};

/**
 * A named geometry publication registered by `expose('name', source)` inside
 * a `part()` block. Unlike `Connector`, an exposure is a pure pass-through:
 * `build()` never consumes the source and emits no shapes — consumers read
 * the SOURCE (not this wrapper) via `def.features.<name>`, so cross-part
 * dependency tracking keeps resolving to the donor-owned object.
 */
export class Exposed extends SceneObject {
  constructor(
    public readonly exposeName: string,
    public readonly source: SceneObject,
  ) {
    super();
    this.name(exposeName);
  }

  getType(): string {
    return "exposed";
  }

  build(_context?: BuildSceneObjectContext): void {
    // A publication is a reference, not geometry — the source is never
    // CONSUMED (consumers keep reading it through def.features), but its
    // selection highlight must not stay rendered forever either. Render-only
    // removal hides it from the final scene (and re-shows it when the
    // timeline is scrubbed before this statement) while every scope-less
    // reader — contact classification, sourceServes pick matching, the
    // cross-part sketch/extrude consumers — still sees the shapes.
    // Reusable sources (`.reusable()` sketches) stay visible, mirroring
    // the hard-consumption guard.
    this.source.removeShapesFromDisplay(this);
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Exposed(this.exposeName, this.source);
  }

  compareTo(other: Exposed): boolean {
    if (!(other instanceof Exposed)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.exposeName !== other.exposeName) {
      return false;
    }
    // A re-pointed exposure (same name, different source) must invalidate —
    // consumers resolve through the name to whatever it now publishes.
    if (!this.source.compareTo(other.source)) {
      return false;
    }
    return true;
  }

  serialize(): SerializedExposure {
    const contact = this.classifyContactGeometry();
    return { name: this.exposeName, seed: contact.seed, chain: contact.chain };
  }

  boundTo(instanceId: string): BoundExposure {
    return new BoundExposure(this, instanceId);
  }

  /** Memoized per built source shape — a cached render re-serves the same Shape objects. */
  private _contactCache: { key: Shape; seed: ContactEntity | null; chain: ContactEntity[] } | null = null;

  /**
   * Canonical contact geometry of the published shape (part-local frame):
   * the seed face/edge classification plus its tangent-propagation chain on
   * the owning solid. Classification happens at serialize time so it rides
   * the part cache — no rebuild, no reclassify.
   */
  private classifyContactGeometry(): { seed: ContactEntity | null; chain: ContactEntity[] } {
    let shapes: Shape[];
    try {
      shapes = this.source.getShapes();
    } catch {
      return { seed: null, chain: [] };
    }
    const seedShape = shapes[0];
    if (!seedShape) {
      return { seed: null, chain: [] };
    }
    if (this._contactCache && this._contactCache.key === seedShape) {
      return this._contactCache;
    }

    const parent = this.getParent();
    let roots: Shape[] = [];
    try {
      roots = parent ? parent.getShapes().filter(s => s.isSolid()) : [];
    } catch {
      // A part whose body failed to build still serializes the exposure name.
    }

    let result: { seed: ContactEntity | null; chain: ContactEntity[] };
    try {
      result = classifyContact(seedShape, roots);
    } catch {
      result = { seed: null, chain: [] };
    }
    this._contactCache = { key: seedShape, ...result };
    return result;
  }
}

/**
 * An exposure bound to one inserted instance — what `instance.features.<name>`
 * returns and what `mate('tangent', …)` consumes. Mirrors `BoundConnector`:
 * the live `Exposed` reference plus the instance id that disambiguates
 * siblings of the same part definition (and thereby the param variant).
 */
export class BoundExposure {
  constructor(
    public readonly exposed: Exposed,
    public readonly instanceId: string,
  ) {}
}
