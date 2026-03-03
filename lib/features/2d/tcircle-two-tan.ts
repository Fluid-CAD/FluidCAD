import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { TangentSolver } from "../../oc/tangent-solver.js";

export class TangentCircle2Tan extends GeometrySceneObject {
  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry, public radius: number) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = TangentSolver.getTangentCircles(plane, this.c1, this.c2, this.radius);
    this.addShapes(edges);
  }

  compareTo(other: TangentCircle2Tan): boolean {
    if (!(other instanceof TangentCircle2Tan)) {
      return false;
    }
    return super.compareTo(other) && this.c1.compareTo(other.c1) && this.c2.compareTo(other.c2) && this.radius === other.radius;
  }

  getType(): string {
    return 'circle';
  }

  getUniqueType(): string {
    return 'tcircle-2tan';
  }

  serialize() {
    return {};
  }
}
