import { GeometrySceneObject } from "./geometry.js";
import { QualifiedGeometry } from "./constraints/qualified-geometry.js";
import { Geometry } from "../../oc/geometry.js";

export class TangentCircle2Tan extends GeometrySceneObject {

  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry, public radius: number) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = Geometry.getTangentCircles(plane, this.c1, this.c2, this.radius);
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
    return {
    };
  }
}

export class TangentCircle3Tan extends GeometrySceneObject {

  constructor(public c1: QualifiedGeometry, public c2: QualifiedGeometry, public c3: QualifiedGeometry) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const edges = Geometry.getTangentCircles3Tan(plane, this.c1, this.c2, this.c3);
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
    return {
    };
  }
}
