import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";
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

    if (edges.length > 0) {
      const lastEdge = edges[edges.length - 1];
      const firstVertex = lastEdge.getFirstVertex();
      const lastVertex = lastEdge.getLastVertex();

      const localStart = plane.worldToLocal(firstVertex.toPoint());
      const localEnd = plane.worldToLocal(lastVertex.toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      this.setTangent(localEnd.subtract(localStart).normalize());
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(edges);
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
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
