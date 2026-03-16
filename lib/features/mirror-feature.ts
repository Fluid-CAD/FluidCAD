import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Matrix4 } from "../math/matrix4.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";

export class MirrorFeature extends SceneObject {

  constructor(private plane: PlaneObjectBase, private _matrix?: Matrix4) {
    super();
    this.setAlwaysVisible()
  }

  override getTransformMatrix(): Matrix4 | null {
    return this._matrix || null;
  }

  override isContainer(): boolean {
    return true;
  }

  build(context: BuildSceneObjectContext) {
    this.plane.removeShapes(this)
    this.saveShapesSnapshot(context)
  }

  compareTo(other: MirrorFeature): boolean {
    if (!(other instanceof MirrorFeature)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "mirror";
  }

  getUniqueType(): string {
    return 'mirror-feature'
  }

  serialize() {
    return {
    }
  }
}
