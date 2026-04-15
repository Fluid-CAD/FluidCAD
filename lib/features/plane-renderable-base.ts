import { Plane } from "../math/plane.js";
import { SceneObject } from "../common/scene-object.js";
import { IPlane } from "../core/interfaces.js";
import { Point } from "../math/point.js";

export abstract class PlaneObjectBase extends SceneObject implements IPlane {

  constructor() {
    super();
  }

  getPlane(): Plane {
    return this.getState('plane') as Plane;
  }

  getPlaneCenter() {
    return (this.getState('plane-center') || this.getPlane().origin) as Point;
  }

  getType(): string {
    return 'plane';
  }
}

