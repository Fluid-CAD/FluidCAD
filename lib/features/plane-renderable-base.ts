import { Plane } from "../math/plane.js";
import { SceneObject } from "../common/scene-object.js";

export abstract class PlaneObjectBase extends SceneObject {

  constructor() {
    super();
  }

  getPlane(): Plane {
    return this.getState('plane') as Plane;
  }

  getPlaneCenter() {
    return this.getState('plane-center') || this.getPlane().origin;
  }

  getType(): string {
    return 'plane';
  }
}

