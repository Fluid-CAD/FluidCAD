import { Edge } from "../../common/edge.js";
import { Geometry } from "../../oc/geometry.js";
import { rad } from "../../helpers/math-helpers.js";
import { Point2D } from "../../math/point.js";
import { LazyVertex } from "../lazy-vertex.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { GeometrySceneObject } from "./geometry.js";

export class AngledLine extends GeometrySceneObject {

  constructor(public length: number, public angle: number, public centered: boolean = false, private targetPlane: PlaneObjectBase = null) {
    super();
  }

  build() {
    const plane = this.targetPlane?.getPlane() || this.sketch.getPlane();

    let tangent = this.sketch?.getTangentAt(this) || new Point2D(1, 0);

    tangent = tangent.normalize();

    const angleRad = rad(this.angle);

    // 2D rotation of tangent by angle
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const dirX = cos * tangent.x - sin * tangent.y;
    const dirY = sin * tangent.x + cos * tangent.y;
    const direction = new Point2D(dirX, dirY);

    const currentPos = this.targetPlane
      ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
      : this.getCurrentPosition();
    const startPoint = this.centered
      ? currentPos.translate(-direction.x * this.length / 2, -direction.y * this.length / 2)
      : currentPos;
    const start = plane.localToWorld(startPoint);

    const worldDir = plane.xDirection.multiply(direction.x).add(plane.yDirection.multiply(direction.y));
    const end = start.add(worldDir.multiply(this.length));
    const endPoint = plane.worldToLocal(end);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('edge', edge);
    this.addShape(edge);

    this.setTangent(direction.normalize());
    if (this.sketch) this.setCurrentPosition(endPoint);

    if (this.targetPlane) this.targetPlane.removeShapes(this);
  }

  compareTo(other: AngledLine): boolean {
    if (!(other instanceof AngledLine)) {
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

    return this.length === other.length && this.angle === other.angle && this.centered === other.centered;
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
    return 'aline';
  }

  serialize() {
    return {
      length: this.length,
      angle: this.angle,
      centered: this.centered
    }
  }
}
