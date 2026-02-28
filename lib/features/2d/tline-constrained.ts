import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { LazyVertex } from "../lazy-vertex.js";

export class TwoCirclesTangentLine extends GeometrySceneObject {

  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = Geometry.getTangentLines(plane, this.c1, this.c2);

    for (let i = 0; i < edges.length; i++) {
      this.setState(`edge-${i}`, edges[i]);
    }
    this.setState('edgeCount', edges.length);

    this.addShapes(edges);

    if (edges.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const start = lastEdge.getFirstVertex().toPoint2D();
      const end = lastEdge.getLastVertex().toPoint2D();
      this.setTangent(end.subtract(start).normalize());
    }
  }

  startVertex(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => {
      const edge = this.getState(`edge-${index}`) as Edge;
      return edge ? [edge.getFirstVertex()] : [];
    });
  }

  endVertex(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => {
      const edge = this.getState(`edge-${index}`) as Edge;
      return edge ? [edge.getLastVertex()] : [];
    });
  }

  compareTo(other: TwoCirclesTangentLine): boolean {
    if (!(other instanceof TwoCirclesTangentLine)) {
      return false;
    }

    return this.c1.compareTo(other.c1) && this.c2.compareTo(other.c2);
  }

  getType(): string {
    return 'line'
  }

  getUniqueType(): string {
    return 'two-circles-tline';
  }

  serialize() {
    return {
    }
  }
}
