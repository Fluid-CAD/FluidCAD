import { SceneObject } from "../common/scene-object.js";
import { Shape, ShapeFilter } from "../common/shape.js";

export class LazySceneObject extends SceneObject {

  private _isBuilt: boolean = false;

  constructor(private uniqueName: string, private getShapesFn: () => Shape[], public deletable = false) {
    super();
  }

  build() {
    if (this._isBuilt) {
      return;
    }

    const shapes = this.getShapesFn();
    console.log("LazySceneObject::build retrieved shapes:", shapes);
    this.addShapes(shapes);
    this._isBuilt = true;
  }

  override getShapes(filter?: ShapeFilter, type?: string): Shape[] {
    this.build();
    const shapes = super.getShapes(filter, type);
    console.log("LazySceneObject::getShapes built shapes:", shapes);
    return shapes;
  }

  clone(): SceneObject[] {
    const clone = new LazySceneObject(this.uniqueName, this.getShapesFn);
    return [clone];
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
