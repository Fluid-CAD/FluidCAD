import { Geometry } from "../../oc/geometry.js";
import { GeometrySceneObject } from "./geometry.js";

export class TangentLine extends GeometrySceneObject {

  constructor(public distance: number) {
    super();
  }

  build() {
    const previousSibiling = this.sketch.getPreviousSibling(this);
    if (!previousSibiling) {
      throw new Error('TangentLine must have a previous sibling');
    }

    if (!(previousSibiling instanceof GeometrySceneObject)) {
      throw new Error('TangentLine previous sibling must be a Curve');
    }

    const tangent = previousSibiling.getTangent();

    const plane = this.sketch.getPlane();

    const startPoint = this.getCurrentPosition();
    const start = plane.localToWorld(startPoint);

    const direction = plane.xDirection.multiply(tangent.x).add(plane.yDirection.multiply(tangent.y));
    const end = start.add(direction.multiply(this.distance));
    const endPoint = plane.worldToLocal(end);

    let segment = Geometry.makeSegment(start, end);

    const edge = Geometry.makeEdge(segment);

    this.addShape(edge);

    this.setTangent(tangent.normalize());
    this.setCurrentPosition(endPoint);
  }

  compareTo(other: TangentLine): boolean {
    if (!(other instanceof TangentLine)) {
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
