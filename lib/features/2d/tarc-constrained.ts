import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "./constraints/qualified-geometry.js";
import { createConstraintSolver } from "../../oc/constraints/create-solver.js";
import { ITangentArcTwoObjects } from "../../core/interfaces.js";

export class TangentArcTwoObjects extends GeometrySceneObject implements ITangentArcTwoObjects {
  constructor(
    public c1: QualifiedSceneObject,
    public c2: QualifiedSceneObject,
    public radius: number,
    public mustTouch: boolean
  ) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const solver = createConstraintSolver(this.mustTouch);
    const results = solver.getTangentArcs(plane, this.c1.toQualifiedShape(), this.c2.toQualifiedShape(), this.radius);

    for (let i = 0; i < results.edges.length; i++) {
      this.setState(`edge-${i}`, results.edges[i]);
    }

    if (results.edges.length > 0) {
      const lastEdge = results.edges[results.edges.length - 1];
      const endTangent = results.endTangent;

      const firstVertex = lastEdge.getFirstVertex();
      const lastVertex = lastEdge.getLastVertex();

      const localStart = plane.worldToLocal(firstVertex.toPoint());
      const localEnd = plane.worldToLocal(lastVertex.toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      this.setTangent(endTangent);
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(results.edges);
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
  }

  compareTo(other: TangentArcTwoObjects): boolean {
    if (!(other instanceof TangentArcTwoObjects)) {
      return false;
    }

    return this.c1.compareTo(other.c1) &&
      this.c2.compareTo(other.c2) &&
      this.radius === other.radius &&
      this.mustTouch === other.mustTouch;
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'two-objects-tarc';
  }

  serialize() {
    return {
      radius: this.radius
    };
  }
}
