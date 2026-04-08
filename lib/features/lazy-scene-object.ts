import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";

export class LazySelectionSceneObject extends SceneObject {

  private _originalParent: SceneObject | null = null;

  constructor(
    private uniqueName: string,
    private getShapesFn: (parent: SceneObject) => Shape[],
    private sourceParent: SceneObject
  ) {
    super();
  }

  build() {
    const shapes = this.getShapesFn(this.sourceParent)
    this.addShapes(shapes);
  }

  override getDependencies(): SceneObject[] {
    return [this.sourceParent];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedParent = remap.get(this.sourceParent) || this.sourceParent;
    const copy = new LazySelectionSceneObject(this.uniqueName, this.getShapesFn, remappedParent);
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

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.sourceParent.compareTo(other.sourceParent)) {
      return false;
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
