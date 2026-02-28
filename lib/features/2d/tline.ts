import { Edge } from "../../common/edge.js";
import { Geometry } from "../../oc/geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
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

    this.setState('edge', edge);
    this.addShape(edge);

    this.setTangent(tangent.normalize());
    this.setCurrentPosition(endPoint);
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
    return 'tline';
  }

  serialize() {
    return {
      distance: this.distance
    }
  }
}
