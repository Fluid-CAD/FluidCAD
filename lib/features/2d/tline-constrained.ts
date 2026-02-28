import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";
import { Edge } from "../../common/edge.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";

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

    this.addShapes(edges);

    if (edges.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const firstVertex = lastEdge.getFirstVertex();
      const lastVertex = lastEdge.getLastVertex();

      const localStart = plane.worldToLocal(firstVertex.toPoint());
      const localEnd = plane.worldToLocal(lastVertex.toPoint());

      this.setTangent(localEnd.subtract(localStart).normalize());
      this.setCurrentPosition(localEnd);
    }
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => {
      const edge = this.getState(`edge-${index}`) as Edge;
      if (!edge) {
        return [];
      }
      const plane = this.sketch.getPlane();
      const firstVertex = edge.getFirstVertex();
      const localPos = plane.worldToLocal(firstVertex.toPoint());
      return [Vertex.fromPoint2D(localPos)];
    });
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => {
      const edge = this.getState(`edge-${index}`) as Edge;
      if (!edge) {
        return [];
      }
      const plane = this.sketch.getPlane();
      const lastVertex = edge.getLastVertex();
      const localPos = plane.worldToLocal(lastVertex.toPoint());
      return [Vertex.fromPoint2D(localPos)];
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
