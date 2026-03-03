import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { TangentSolver } from "../../oc/tangent-solver.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";

export class OneCircleTangentLine extends GeometrySceneObject {
  constructor(public c1: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const currentPos = this.getCurrentPosition();

    const posVertex = new LazyVertex(
      this.generateUniqueName('current-pos-vertex'),
      () => [Vertex.fromPoint2D(currentPos)]
    );

    const qualifiedVertex = new QualifiedGeometry(posVertex, 'unqualified');
    const edges = TangentSolver.getTangentLines(plane, this.c1, qualifiedVertex);
    this.applyEdgeResults(plane, edges);
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
  }

  compareTo(other: OneCircleTangentLine): boolean {
    if (!(other instanceof OneCircleTangentLine)) {
      return false;
    }
    return this.c1.compareTo(other.c1);
  }

  getType(): string {
    return 'line';
  }

  getUniqueType(): string {
    return 'one-circle-tline';
  }

  serialize() {
    return {};
  }
}

export class TwoCirclesTangentLine extends GeometrySceneObject {
  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = TangentSolver.getTangentLines(plane, this.c1, this.c2);
    this.applyEdgeResults(plane, edges);
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
    return 'line';
  }

  getUniqueType(): string {
    return 'two-circles-tline';
  }

  serialize() {
    return {};
  }
}
