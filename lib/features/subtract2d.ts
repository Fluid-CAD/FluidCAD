import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { EdgeTargetArg, GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { requireShapes } from "../common/operand-check.js";

export class Subtract2D extends GeometrySceneObject {
  constructor(public target1: EdgeTargetArg, public target2: EdgeTargetArg) {
    super();
  }

  override validate() {
    if (this.target1 instanceof SceneObject) {
      requireShapes(this.target1, "first operand", "subtract2d");
    }
    if (this.target2 instanceof SceneObject) {
      requireShapes(this.target2, "second operand", "subtract2d");
    }
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.sketch.getPlane();
    const baseEdgeMap = this.resolveEdgeTargets([this.target1]);
    const toolEdgeMap = this.resolveEdgeTargets([this.target2]);

    const baseFaces = FaceMaker2.getRegions(Array.from(baseEdgeMap.keys()), plane);
    const toolFaces = FaceMaker2.getRegions(Array.from(toolEdgeMap.keys()), plane);

    if (baseFaces.length === 0 || toolFaces.length === 0) {
      return;
    }

    const baseCompound = ShapeOps.makeCompoundRaw(baseFaces.map(f => f.getShape()));
    const toolCompound = ShapeOps.makeCompoundRaw(toolFaces.map(f => f.getShape()));

    const result = BooleanOps.cutShapesRaw(baseCompound, toolCompound);
    const resultFaces = Explorer.findShapes(result, Explorer.getOcShapeType("face"))
      .map(f => Face.fromTopoDSFace(Explorer.toFace(f)));

    const newEdges = resultFaces.flatMap(face => face.getEdges());

    // Remove through the sketch so every holder of the instance (real
    // owner, lazy accessors, select statements) records the removal.
    for (const edge of baseEdgeMap.keys()) {
      this.sketch.removeShape(edge, this);
    }

    for (const edge of toolEdgeMap.keys()) {
      this.sketch.removeShape(edge, this);
    }

    // Surviving stretches keep their source roles; new pieces are boolean cuts.
    const inputEdges = [...baseEdgeMap.keys(), ...toolEdgeMap.keys()];
    const unmatched = this.recoverEdgeRoles(newEdges, inputEdges);
    for (const edge of unmatched) {
      edge.setProvenance('boolean-result');
    }

    this.addShapes(newEdges);
  }

  override getDependencies(): SceneObject[] {
    return GeometrySceneObject.sceneObjectTargets([this.target1, this.target2]);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const [t1, t2] = GeometrySceneObject.remapEdgeTargets([this.target1, this.target2], remap);
    return new Subtract2D(t1, t2);
  }

  compareTo(other: Subtract2D): boolean {
    if (!(other instanceof Subtract2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    return GeometrySceneObject.compareEdgeTargets(
      [this.target1, this.target2],
      [other.target1, other.target2],
    );
  }

  getType(): string {
    return "subtract2d";
  }

  serialize() {
    return {};
  }
}
