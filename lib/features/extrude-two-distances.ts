import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape, Solid } from "../common/shapes.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { rad } from "../helpers/math-helpers.js";
import { Plane } from "../math/plane.js";
import { ExtrudeBase } from "./extrude-base.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Vector3d } from "../math/vector3d.js";
import { Matrix4 } from "../math/matrix4.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { ExtrudeOps } from "../oc/extrude-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Extrudable } from "../helpers/types.js";

export class ExtrudeTwoDistances extends ExtrudeBase {

  constructor(
    public distance1: number,
    public distance2: number) {

    super();
  }

  build(context: BuildSceneObjectContext) {
    let solids: Shape[] = [];

    const sceneObjects = context.getSceneObjects();

    const wires = this.extrudable.getGeometries();
    const faces = FaceMaker.getFaces(wires, this.extrudable.getPlane());
    console.log("Extruding faces:", faces);

    const plane = this.extrudable.getPlane();
    const draft = this.getDraft();

    if (draft) {
      let upVec = plane.normal.multiply(this.distance1);
      let downVec = plane.normal.multiply(-this.distance2);

      console.log("Up vec:", new Vector3d(upVec.x, upVec.y, upVec.z));
      console.log("Down vec:", new Vector3d(downVec.x, downVec.y, downVec.z));

      for (const face of faces) {
        let { solid: upSolid, firstFace: upFirstFace, lastFace: upLastFace } = this.doExtrude(face, upVec);
        console.log("Up solid:", upSolid);
        let { solid: downSolid, firstFace: downFirstFace, lastFace: downLastFace } = this.doExtrude(face, downVec);
        console.log("Down solid:", downSolid);

        let [angle1, angle2] = draft;
        console.log("Draft angles:", angle1, angle2);

        upSolid = this.applyDraft(angle1, upSolid, upFirstFace, upLastFace, plane);
        console.log("Drafted up solid:", upSolid);

        downSolid = this.applyDraft(angle2, downSolid, downFirstFace, downLastFace, plane.reverse());
        console.log("Drafted down solid:", downSolid);

        const fused = BooleanOps.fuseShapes(upSolid, downSolid);
        console.log("Fused solid:", fused);

        solids.push(fused as Solid);
      }
    }
    else {
      const totalDistance = this.distance1 + this.distance2;
      console.log("Total distance:", totalDistance);
      let vec = plane.normal.multiply(totalDistance);
      const translateVec = plane.normal.multiply(-this.distance2);

      for (const face of faces) {
        let { solid } = this.doExtrude(face, vec);
        const translated = ShapeOps.transform(solid, Matrix4.fromTranslationVector(translateVec));

        solids.push(translated);
      }
    }

    this.extrudable.removeShapes(this);

    if (this.getFusionScope() !== 'none' && solids.length > 0 && sceneObjects?.length > 0) {
      const fusionResult = fuseWithSceneObjects(sceneObjects, solids);
      solids = fusionResult.extrusions;

      for (const modifiedShape of fusionResult.modifiedShapes) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(solids);
  }

  private applyDraft(angle: number, solid: Shape, firstFace: Shape, lastFace: Shape, plane: Plane): Shape {
    return ExtrudeOps.applyDraftOnSideFaces(solid, firstFace, lastFace, plane, rad(angle));
  }

  private doExtrude(shape: Shape, vector: Vector3d) {
    const { solid: rawSolid, firstFace, lastFace } = ExtrudeOps.makePrismFromVec(shape, vector);
    const solid = ShapeOps.cleanShape(rawSolid);

    return {
      solid,
      firstFace,
      lastFace
    };
  }

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new ExtrudeTwoDistances(this.distance1, this.distance2).syncWith(this) as ExtrudeTwoDistances;
    if (this.extrudable) {
      copy.target((remap.get(this.extrudable) || this.extrudable) as Extrudable);
    }
    return copy;
  }

  compareTo(other: ExtrudeTwoDistances): boolean {
    if (!(other instanceof ExtrudeTwoDistances)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.distance1 !== other.distance1 || this.distance2 !== other.distance2) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'extrude-by-two-distance';
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance1: this.distance1,
      distance2: this.distance2
    }
  }
}
