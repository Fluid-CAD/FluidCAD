// The `region(name, ...entities)` statement: a named region of the sketch,
// declared inside the sketch callback by the entities on its outer loop.
//
// A declaration is a sketch child with no geometry of its own, like a
// constraint statement. It registers its name with the sketch at statement
// time so a consuming feature can ask for the region by name
// (`extrude(20, s).region('r1')`); the region itself is only resolved when a
// feature consumes it, against the cells the sketch's edges cut the plane
// into at that moment — see region-match.ts. Registration problems (no
// sketch around the statement, a name declared twice, an entity of another
// sketch) are stashed and surface as the statement's own build error, so one
// bad declaration never aborts module evaluation.

import { SceneObject } from "../../../common/scene-object.js";
import { BuildError } from "../../../common/build-error.js";
import type { Sketch } from "../sketch.js";
import { RegionItem, RegionTarget, regionItemOf, remapItems, sameItem } from "./region-ref.js";

export class SketchRegionDeclaration extends SceneObject {

  private _items: RegionItem[] = [];
  private _sketch: Sketch | null = null;
  private _registrationError: string | null = null;

  constructor(readonly regionName: string) {
    super();
    // The row is the name: "r1" says which region this is, "Region" does
    // not. Same as a connector row, which reads its connector name. A bad
    // name (missing, not a string) keeps the type as the label; register()
    // reports it.
    if (typeof regionName === 'string' && regionName.length > 0) {
      this.name(regionName);
    }
  }

  /** Resolve the targets and register the name with the sketch (statement time). */
  register(sk: Sketch | null, targets: RegionTarget[]): void {
    if (typeof this.regionName !== 'string' || this.regionName.length === 0) {
      this._registrationError = "region() takes a name first — region('r1', l1, l2, c1)";
      return;
    }
    if (!sk) {
      this._registrationError = `region('${this.regionName}') must be written inside a sketch(plane, callback) body`;
      return;
    }
    this._sketch = sk;
    // The name is registered before the entities are checked, so a consumer
    // asking for a broken declaration hears what is wrong with it rather
    // than that it does not exist.
    const taken = sk.addRegionDeclaration(this);
    if (taken) {
      this._registrationError = taken;
      return;
    }
    if (targets.length === 0) {
      this._registrationError = `region('${this.regionName}') names no entity — list the sketch entities on the region's outer loop`;
      return;
    }
    try {
      this._items = targets.map(regionItemOf);
    } catch (error) {
      this._registrationError = error instanceof Error ? error.message : String(error);
      return;
    }
    for (const item of this._items) {
      if (!belongsTo(item.owner, sk)) {
        this._registrationError = `region('${this.regionName}') names a ${item.owner.getType()} of another sketch — a region is declared by the entities of its own sketch`;
        return;
      }
    }
  }

  /** The declared boundary: statement identities, sub-keys and sides. */
  get items(): RegionItem[] {
    return this._items;
  }

  get sketch(): Sketch | null {
    return this._sketch;
  }

  /** Why the declaration is unusable, or null. A consumer names it in its own error. */
  get registrationError(): string | null {
    return this._registrationError;
  }

  build(): void {
    if (this._registrationError) {
      throw new BuildError(this._registrationError);
    }
  }

  override getDependencies(): SceneObject[] {
    return [...new Set(this._items.map(item => item.owner))];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new SketchRegionDeclaration(this.regionName);
    copy._items = remapItems(this._items, remap);
    copy._sketch = (remap.get(this._sketch as unknown as SceneObject) as unknown as Sketch | undefined) ?? this._sketch;
    copy._registrationError = this._registrationError;
    copy._sketch?.addRegionDeclaration(copy);
    return copy;
  }

  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof SketchRegionDeclaration)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.regionName !== other.regionName || this._items.length !== other._items.length
      || this._registrationError !== other._registrationError) {
      return false;
    }
    // Statements compare by position in their sketch: the two declarations
    // belong to two builds of the same source, so the same position is the
    // same statement.
    const mine = this._sketch?.getChildren() ?? [];
    const theirs = other._sketch?.getChildren() ?? [];
    for (let i = 0; i < this._items.length; i++) {
      const a = this._items[i];
      const b = other._items[i];
      if (a.right !== b.right || a.path.join('.') !== b.path.join('.')) {
        return false;
      }
      if (mine.indexOf(a.owner) !== theirs.indexOf(b.owner)) {
        return false;
      }
    }
    return true;
  }

  getType(): string {
    return 'region';
  }

  getUniqueType(): string {
    return 'region-declaration';
  }

  serialize() {
    return {
      name: this.regionName,
      entities: this._items.length,
    };
  }

  /** Whether this declaration lists exactly these items (order-free). */
  matches(items: RegionItem[]): boolean {
    return this._items.length === items.length
      && this._items.every(mine => items.some(item => sameItem(mine, item)));
  }

  override toString(): string {
    return `Region(${this.regionName})`;
  }
}

/** Whether the statement sits inside `sketch` (directly or in a container of it). */
function belongsTo(statement: SceneObject, sketch: Sketch): boolean {
  for (let parent = statement.getParent(); parent; parent = parent.getParent()) {
    if ((parent as unknown) === sketch) {
      return true;
    }
  }
  return false;
}
