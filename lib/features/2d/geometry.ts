import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";

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

  protected getCurrentPosition(): Point2D {
    return this.sketch.getPositionAt(this);
  }

  protected setCurrentPosition(point: Point2D) {
    this.setState('current-position', point);
  }

  protected setTangent(point: Point2D) {
    this.setState('tangent', point);
  }

  getTangent(): Point2D {
    return this.getState('tangent');
  }

  tangent(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('tangent'), () => {
      const tangent = this.getTangent();
      if (tangent) {
        return [Vertex.fromPoint2D(tangent)];
      }
      return [];
    });
  }
}
