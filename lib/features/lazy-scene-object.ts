import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { AnchorableSelection } from "./anchored-vertex.js";
import { withUnit } from "../units/registry.js";

export type LazySelectionArg = number | FilterBuilderBase<Shape>;

export class LazySelectionSceneObject extends AnchorableSelection {

  private _originalParent: SceneObject | null = null;

  constructor(
    private uniqueName: string,
    private getShapesFn: (parent: SceneObject) => Shape[],
    private sourceParent: SceneObject,
    private selectionArgs: LazySelectionArg[] = []
  ) {
    super();
  }

  // Resolvable ahead of the render loop's own build slot (the P6 reference
  // pre-pass builds projection sources early) — the latch makes the second
  // build a no-op instead of double-adding the shapes.
  private _resolved = false;

  build() {
    if (this._resolved) {
      return;
    }
    this._resolved = true;
    const shapes = this.getShapesFn(this.sourceParent)
    this.addShapes(shapes);
  }

  override isLazy(): boolean {
    return true;
  }

  /**
   * Resolve the lazy selections `object` reaches through lazy references —
   * itself, an anchor's selection, an accessor's accessor — for a consumer
   * about to read them. A reference handed over in a chained call
   * (`.connect(e.endEdges().start())`, `.along(e.sideEdges(0))`) is created
   * after its consumer's statement and has no earlier build slot in the
   * scene. Only lazy selections are resolved, never the features that
   * produce them; the build latch makes the render loop's own slot, where
   * there is one, a no-op.
   */
  static resolveReachable(object: SceneObject, seen = new Set<SceneObject>()): void {
    if (seen.has(object)) {
      return;
    }
    seen.add(object);
    for (const dependency of object.getDependencies()) {
      if (dependency.isLazy()) {
        LazySelectionSceneObject.resolveReachable(dependency, seen);
      }
    }
    if (object instanceof LazySelectionSceneObject) {
      withUnit(object.getUnit(), () => object.build());
    }
  }

  override getDependencies(): SceneObject[] {
    return [this.sourceParent];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedParent = remap.get(this.sourceParent) || this.sourceParent;
    const copy = new LazySelectionSceneObject(this.uniqueName, this.getShapesFn, remappedParent, this.selectionArgs);
    if (remappedParent !== this.sourceParent) {
      copy._originalParent = this._originalParent || this.sourceParent;
    }
    return copy;
  }

  compareTo(other: LazySelectionSceneObject): boolean {
    if (!(other instanceof LazySelectionSceneObject)) {
      return false;
    }

    if (this.uniqueName !== other.uniqueName) {
      return false;
    }

    if (!this.compareSelectionArgs(other)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.sourceParent.compareTo(other.sourceParent)) {
      return false;
    }

    return true;
  }

  // The unique name only encodes numeric args (filter builders all collapse to
  // 'f'), so filter-based selections must be compared structurally too.
  private compareSelectionArgs(other: LazySelectionSceneObject): boolean {
    if (this.selectionArgs.length !== other.selectionArgs.length) {
      return false;
    }

    for (let i = 0; i < this.selectionArgs.length; i++) {
      const a = this.selectionArgs[i];
      const b = other.selectionArgs[i];

      if (typeof a === 'number' || typeof b === 'number') {
        if (a !== b) {
          return false;
        }
        continue;
      }

      if (!a.equals(b)) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "select";
  }

  getUniqueType(): string {
      return 'lazy-select';
  }

  serialize() {
    return {
    }
  }
}
