import { Point2D } from "../../math/point.js";
import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { IGeometry } from "../../core/interfaces.js";

export type GeometryOrientation = "cw" | "ccw";

export abstract class GeometrySceneObject extends SceneObject implements IGeometry {

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

  protected applyEdgeResults(plane: Plane, edges: Edge[]) {
    for (let i = 0; i < edges.length; i++) {
      this.setState(`edge-${i}`, edges[i]);
    }

    if (edges.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const localStart = plane.worldToLocal(lastEdge.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastEdge.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      this.setTangent(localEnd.subtract(localStart).normalize());
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(edges);
  }

  getTangent(): Point2D {
    return this.getState('tangent');
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => {
      const start = this.getState('start');
      console.log('Getting start vertex:', start);
      if (start) {
        console.log('Getting start vertex:', start);
        return [start];
      }
      return [];
    });
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => {
      const end = this.getState('end');
      if (end) {
        console.log('Getting end vertex:', end);
        return [end];
      }
      return [];
    });
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
