import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape, ShapeFilter } from "../common/shape.js";
import { ShapeType } from "../common/shape-type.js";

export class LazySceneObject extends SceneObject {

  private _isBuilt: boolean = false;
  private _originalParent: SceneObject | null = null;

  constructor(
    private uniqueName: string,
    private getShapesFn: (parent: SceneObject) => Shape[],
    private sourceParent: SceneObject,
    public deletable = false
  ) {
    super();
  }

  build() {
    if (this._isBuilt) {
      return;
    }

    console.log('LazySceneObject::build - ', this.sourceParent.id);
    const shapes = this.getShapesFn(this.sourceParent)


    this.addShapes(shapes);
    this._isBuilt = true;
  }

  override getShapes(filter: ShapeFilter, type: ShapeType): Shape[] {
    if (!this._isBuilt) {
      this.build();
    }

    return super.getShapes(filter, type);
  }

  override getDependencies(): SceneObject[] {
    return [this.sourceParent];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedParent = remap.get(this.sourceParent) || this.sourceParent;
    const copy = new LazySceneObject(this.uniqueName, this.getShapesFn, remappedParent, this.deletable);
    if (remappedParent !== this.sourceParent) {
      copy._originalParent = this._originalParent || this.sourceParent;
    }
    return copy;
  }

  compareTo(other: LazySceneObject): boolean {
    return super.compareTo(other) && this.uniqueName === other.uniqueName;
  }

  getType(): string {
    return "lazy";
  }

  serialize() {
    return {
    }
  }
}
