import { Plane } from "../math/plane.js";
import { SceneObject } from "../common/scene-object.js";
import { IPlane } from "../core/interfaces.js";

export abstract class PlaneObjectBase extends SceneObject implements IPlane {

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

