import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";

export class TangentArcTwoCircles extends GeometrySceneObject {
  constructor(
    public c1: QualifiedGeometry,
    public c2: QualifiedGeometry,
    public radius: number
  ) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const results = Geometry.getTangentArcs(plane, this.c1, this.c2, this.radius);

    for (let i = 0; i < results.length; i++) {
      this.setState(`edge-${i}`, results[i].edge);
    }

    if (results.length > 0) {
      const { edge: lastEdge, endTangent } = results[results.length - 1];
      const firstVertex = lastEdge.getFirstVertex();
      const lastVertex = lastEdge.getLastVertex();

      const localStart = plane.worldToLocal(firstVertex.toPoint());
      const localEnd = plane.worldToLocal(lastVertex.toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      this.setTangent(endTangent);
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(results.map(r => r.edge));
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
  }

  compareTo(other: TangentArcTwoCircles): boolean {
    if (!(other instanceof TangentArcTwoCircles)) {
      return false;
    }

    return this.c1.compareTo(other.c1) &&
      this.c2.compareTo(other.c2) &&
      this.radius === other.radius;
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'two-circles-tarc';
  }

  serialize() {
    return {
      radius: this.radius
    };
  }
}
