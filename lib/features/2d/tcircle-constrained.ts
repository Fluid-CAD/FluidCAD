import { GeometrySceneObject } from "./geometry.js";
import { QualifiedSceneObject } from "./constraints/qualified-geometry.js";
import { createConstraintSolver } from "../../oc/constraints/create-solver.js";

export class TwoObjectsTangentCircle extends GeometrySceneObject {
  constructor(public c1: QualifiedSceneObject, public c2: QualifiedSceneObject, public radius: number, public mustTouch: boolean) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const solver = createConstraintSolver(this.mustTouch);
    const edges = solver.getTangentCircles(plane, this.c1.toQualifiedShape(), this.c2.toQualifiedShape(), this.radius);
    this.addShapes(edges);
  }

  compareTo(other: TwoObjectsTangentCircle): boolean {
    if (!(other instanceof TwoObjectsTangentCircle)) {
      return false;
    }
    return super.compareTo(other) && this.c1.compareTo(other.c1) && this.c2.compareTo(other.c2) && this.radius === other.radius && this.mustTouch === other.mustTouch;
  }

  getType(): string {
    return 'circle';
  }

  getUniqueType(): string {
    return 'two-objects-tcircle';
  }

  serialize() {
    return {};
  }
}
