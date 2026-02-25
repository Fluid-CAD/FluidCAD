import { SceneObject } from "../common/scene-object.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { SelectSceneObject } from "./select.js";

export abstract class ExtrudeBase extends SceneObject {

  constructor(
    public options: ExtrudeOptions = {}) {
    super();
  }

  firstFace(): SelectSceneObject {
    return null;
  }

  lastFace(): SelectSceneObject {
    return null;
  }

  getType(): string {
    return "extrude";
  }
}
