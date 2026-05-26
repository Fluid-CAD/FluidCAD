import { GeometrySceneObject } from "./geometry.js";
import { SceneObject } from "../../common/scene-object.js";
import { Vertex } from "../../common/vertex.js";
import { QualifiedSceneObject } from "./constraints/qualified-geometry.js";
import { solveTangentArcRadiusToObject } from "../../oc/constraints/geometric/tangent-arc-radius-to-object.js";

export class TangentArcRadiusToObject extends GeometrySceneObject {
  constructor(public radius: number, public target: QualifiedSceneObject) {
    super();
  }

  build() {
    const plane = this.sketch.getPlane();
    const startPoint = this.getCurrentPosition();
    const startTangent = this.sketch.getTangentAt(this);
    const targetShape = this.target.toQualifiedShape();

    const result = solveTangentArcRadiusToObject(
      plane,
      startPoint,
      startTangent,
      this.radius,
      targetShape
    );

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

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedObject = remap.get(this.target.object) || this.target.object;
    const target = new QualifiedSceneObject(remappedObject, this.target.qualifier);
    return new TangentArcRadiusToObject(this.radius, target);
  }

  compareTo(other: TangentArcRadiusToObject): boolean {
    if (!(other instanceof TangentArcRadiusToObject)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.radius === other.radius && this.target.compareTo(other.target);
  }

  getType(): string {
    return 'tarc';
  }

  getUniqueType(): string {
    return 'tarc-radius-to-object';
  }

  serialize() {
    return { radius: this.radius };
  }
}
