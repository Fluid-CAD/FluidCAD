import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";

export class MirrorFeature extends SceneObject {

  constructor(private plane: PlaneObjectBase) {
    super();
    this.setAlwaysVisible()
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
