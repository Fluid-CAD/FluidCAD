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
    return (this.getState('plane-center') || this.getPlane()?.origin) as Point;
  }

  getType(): string {
    return 'plane';
  }

  /**
   * A feature consumes a plane for display only: the quad leaves the rendered
   * scene from the consumer on (a sketch drawn on it, a mirror across it, a
   * mid plane between it and another), but any later feature may take the
   * same plane again with no `.reusable()`. `remove(p)` drops it for good.
   */
  override consumedForDisplayOnly(): boolean {
    return true;
  }
}


