import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { requireShapes } from "../common/operand-check.js";

export class Subtract2D extends GeometrySceneObject {
  constructor(public target1: GeometrySceneObject, public target2: GeometrySceneObject) {
    super();
  }

  override validate() {
    requireShapes(this.target1, "first operand", "subtract2d");
    requireShapes(this.target2, "second operand", "subtract2d");
  }

  private collectEdges(target: GeometrySceneObject): Map<Edge, SceneObject> {
    const edges = new Map<Edge, SceneObject>();
    for (const shape of target.getShapes()) {
      if (shape instanceof Edge) {
        edges.set(shape, target);
      } else if (shape instanceof Wire) {
        for (const edge of shape.getEdges()) {
          edges.set(edge, target);
        }
      }
    }
    return edges;
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.sketch.getPlane();
    const baseEdgeMap = this.collectEdges(this.target1);
    const toolEdgeMap = this.collectEdges(this.target2);

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

    for (const [edge, owner] of baseEdgeMap) {
      owner.removeShape(edge, this);
    }

    for (const [edge, owner] of toolEdgeMap) {
      owner.removeShape(edge, this);
    }

    this.addShapes(newEdges);
  }

  override getDependencies(): SceneObject[] {
    return [this.target1, this.target2];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const t1 = (remap.get(this.target1) as GeometrySceneObject) || this.target1;
    const t2 = (remap.get(this.target2) as GeometrySceneObject) || this.target2;
    return new Subtract2D(t1, t2);
  }

  compareTo(other: Subtract2D): boolean {
    if (!(other instanceof Subtract2D)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.target1.compareTo(other.target1) || !this.target2.compareTo(other.target2)) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "subtract2d";
  }

  serialize() {
    return {};
  }
}
