import { GeometrySceneObject } from "./geometry.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "./constraints/qualified-geometry.js";
import { createConstraintSolver } from "../../oc/constraints/create-solver.js";
import { ITangentArcToObject } from "../../core/interfaces.js";

export class TangentArcToObject extends GeometrySceneObject implements ITangentArcToObject {
  private flipped = false;

  constructor(public target: QualifiedSceneObject) {
    super();
  }

  flip(): this {
    this.flipped = true;
    return this;
  }

  build() {
    const plane = this.sketch.getPlane();
    const startPoint = this.getCurrentPosition();
    const startTangent = this.sketch.getTangentAt(this);
    const targetShape = this.target.toQualifiedShape();

    const solver = createConstraintSolver(false);
    const result = solver.getTangentArcFromPointTangent(plane, startPoint, startTangent, targetShape, this.flipped);

    for (let i = 0; i < result.edges.length; i++) {
      this.setState(`edge-${i}`, result.edges[i]);
    }

    if (result.edges.length > 0) {
      const lastEdge = result.edges[result.edges.length - 1];
      const localStart = plane.worldToLocal(lastEdge.getFirstVertex().toPoint());
      const localEnd = plane.worldToLocal(lastEdge.getLastVertex().toPoint());

      this.setState('start', Vertex.fromPoint2D(localStart));
      this.setState('end', Vertex.fromPoint2D(localEnd));

      if (result.endTangent) {
        this.setTangent(result.endTangent);
      }
      this.setCurrentPosition(localEnd);
    }

    this.addShapes(result.edges);
  }

  compareTo(other: TangentArcToObject): boolean {
    if (!(other instanceof TangentArcToObject)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return this.target.compareTo(other.target) && this.flipped === other.flipped;
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'tarc-to-object';
  }

  serialize() {
    return { flipped: this.flipped };
  }
}
