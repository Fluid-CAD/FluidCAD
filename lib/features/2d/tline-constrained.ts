import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";

export class TwoCirclesTangentLine extends GeometrySceneObject {

  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = Geometry.getTangentLines(plane, this.c1, this.c2);
    this.addShapes(edges);
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
