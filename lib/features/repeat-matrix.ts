import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { LazyMatrix } from "../math/lazy-matrix.js";

export class RepeatMatrix extends SceneObject {

  constructor(private _matrix: LazyMatrix, public targetObjects: SceneObject[]) {
    super();
    this.setAlwaysVisible();
  }

  override getTransformMatrix(): Matrix4 | null {
    return this._matrix.resolve();
  }

  override isContainer(): boolean {
    return true;
  }

  build(context: BuildSceneObjectContext) {
    this.saveShapesSnapshot(context);
  }

  compareTo(other: RepeatMatrix): boolean {
    if (!(other instanceof RepeatMatrix)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this._matrix.equals(other._matrix)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "repeat-matrix";
  }

  getUniqueType(): string {
    return "repeat-matrix";
  }

  serialize() {
    return {};
  }
}
