import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";

export type GeometryOrientation = "cw" | "ccw";

export abstract class GeometrySceneObject extends SceneObject {

  constructor() {
    super();
  }

  get sketch() {
    let parent = this.getParent();
    while (parent && !(parent instanceof Sketch)) {
      parent = parent.getParent();
    }

    if (!parent) {
      console.warn('GeometrySceneObject is not contained within a Sketch');
      return null;
    }

    return parent as Sketch;
  }

  getCurrentPosition(): Point2D {
    return this.sketch.getPositionAt(this);
  }

  setCurrentPosition(point: Point2D) {
    this.setState('current-position', point);
  }

  setTangent(point: Point2D) {
    this.setState('tangent', point);
  }

  getTangent(): Point2D {
    return this.getState('tangent');
  }
}
