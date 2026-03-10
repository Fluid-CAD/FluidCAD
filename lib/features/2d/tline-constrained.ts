import { GeometrySceneObject } from "./geometry.js";
import { LazyVertex } from "../lazy-vertex.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "./constraints/qualified-geometry.js";
import { createConstraintSolver } from "../../oc/constraints/create-solver.js";

export class OneObjectTangentLine extends GeometrySceneObject {
  constructor(public object: QualifiedSceneObject) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const currentPos = this.getCurrentPosition();

    const shape = this.object.object.getShapes({ excludeGuide: false })[0]

    if (!shape) {
      throw new Error('At least one shape is required for the tangent line constraint');
    }

    const currentPosVertex = Vertex.fromPoint2D(currentPos);
    const solver = createConstraintSolver()
    console.log('Solver created');
    const edges = solver.getTangentLines(plane,
      {
        shape: currentPosVertex,
        qualifier: 'unqualified'
      },
      this.object.toQualifiedShape()
    );
    this.applyEdgeResults(plane, edges);
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
  }

  compareTo(other: OneObjectTangentLine): boolean {
    if (!(other instanceof OneObjectTangentLine)) {
      return false;
    }

    return this.object.compareTo(other.object);
  }

  getType(): string {
    return 'line';
  }

  getUniqueType(): string {
    return 'one-object-tline';
  }

  serialize() {
    return {};
  }
}

export class TwoObjectsTangentLine extends GeometrySceneObject {
  constructor(public object1: QualifiedSceneObject, public object2: QualifiedSceneObject) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();

    const solver = createConstraintSolver()
    const edges = solver.getTangentLines(plane,
      this.object1.toQualifiedShape(), this.object2.toQualifiedShape());

    this.applyEdgeResults(plane, edges);
  }

  start(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`start-vertex-${index}`), () => [this.getState('start')]);
  }

  end(index: number = 0): LazyVertex {
    return new LazyVertex(this.generateUniqueName(`end-vertex-${index}`), () => [this.getState('end')]);
  }

  compareTo(other: TwoObjectsTangentLine): boolean {
    if (!(other instanceof TwoObjectsTangentLine)) {
      return false;
    }
    return this.object1.compareTo(other.object1) && this.object2.compareTo(other.object2);
  }

  getType(): string {
    return 'line';
  }

  getUniqueType(): string {
    return 'two-objects-tline';
  }

  serialize() {
    return {};
  }
}
