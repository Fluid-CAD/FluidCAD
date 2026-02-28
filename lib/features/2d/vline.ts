import { Edge } from "../../common/edge.js";
import { Geometry } from "../../oc/geometry.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";

export class VerticalLine extends GeometrySceneObject {

  constructor(public distance: number, public centered: boolean = false, private targetPlane: PlaneObjectBase = null) {
    super();
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();
    const startPoint = this.centered
      ? currentPos.translate(0, -this.distance / 2)
      : currentPos;
    const endPoint = startPoint.translate(0, this.distance);

    const start = plane.localToWorld(startPoint);
    const end = plane.localToWorld(endPoint);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('edge', edge);
    this.addShape(edge);

    const sign = Math.sign(this.distance) || 1;
    this.setTangent(new Point2D(0, sign));
    if (this.sketch) this.setCurrentPosition(endPoint);

    if (this.targetPlane) this.targetPlane.removeShapes(this);
  }

  compareTo(other: VerticalLine): boolean {
    if (!(other instanceof VerticalLine)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }

    return this.distance === other.distance && this.centered === other.centered;
  }

  start(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('start-vertex'), () => {
      const edge = this.getState('edge') as Edge;
      return edge ? [edge.getFirstVertex()] : [];
    });
  }

  end(): LazyVertex {
    return new LazyVertex(this.generateUniqueName('end-vertex'), () => {
      const edge = this.getState('edge') as Edge;
      return edge ? [edge.getLastVertex()] : [];
    });
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'vline';
  }

  serialize() {
    return {
      distance: this.distance,
      centered: this.centered
    }
  }
}
