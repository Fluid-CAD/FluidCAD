import { Vertex } from "../../common/vertex.js";
import { Geometry } from "../../oc/geometry.js";
import { GeometrySceneObject } from "./geometry.js";

export class TangentLine extends GeometrySceneObject {

  constructor(public distance: number) {
    super();
  }

  build() {
    const tangent = this.sketch.getTangentAt(this);
    if (!tangent) {
      throw new Error('TangentLine requires a previous sibling with a tangent');
    }

    const plane = this.sketch.getPlane();

    const startPoint = this.getCurrentPosition();
    const start = plane.localToWorld(startPoint);

    const direction = plane.xDirection.multiply(tangent.x).add(plane.yDirection.multiply(tangent.y));
    const end = start.add(direction.multiply(this.distance));
    const endPoint = plane.worldToLocal(end);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.setState('start', Vertex.fromPoint2D(startPoint));
    this.setState('end', Vertex.fromPoint2D(endPoint));

    this.setTangent(tangent.normalize());
    this.setCurrentPosition(endPoint);

    this.addShape(edge);
  }

  compareTo(other: TangentLine): boolean {
    if (!(other instanceof TangentLine)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.distance === other.distance;
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'tline';
  }

  serialize() {
    return {
      distance: this.distance
    }
  }
}
