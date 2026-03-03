import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { TangentSolver } from "../../oc/tangent-solver.js";

export class TangentCircle3Tan extends GeometrySceneObject {
  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry, public c3: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = TangentSolver.getTangentCircles3Tan(plane, this.c1, this.c2, this.c3);
    this.addShapes(edges);
  }

  compareTo(other: TangentCircle3Tan): boolean {
    if (!(other instanceof TangentCircle3Tan)) {
      return false;
    }
    return this.c1.compareTo(other.c1) && this.c2.compareTo(other.c2) && this.c3.compareTo(other.c3);
  }

  getType(): string {
    return 'circle';
  }

  getUniqueType(): string {
    return 'tcircle-3tan';
  }

  serialize() {
    return {};
  }
}
