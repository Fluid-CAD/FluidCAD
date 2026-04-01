import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeBase } from "./extrude-base.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { Extruder } from "./simple-extruder.js";

export class ExtrudeTwoDistances extends ExtrudeBase {

  constructor(
    public distance1: number,
    public distance2: number,
    extrudable?: Extrudable) {

    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = context.getSceneObjects();
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());
    console.log("Extruding faces:", faces);

    const extruder1 = new Extruder(faces, plane, this.distance1, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();
    const startFaces = extruder1.getStartFaces();
    const sideFaces1 = extruder1.getSideFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();
    const endFaces = extruder2.getEndFaces();
    const sideFaces2 = extruder2.getSideFaces();

    const all = [...extrusions1, ...extrusions2];
    const { result: extrusions } = BooleanOps.fuse(all);

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', [...sideFaces1, ...sideFaces2]);

    this.extrudable.removeShapes(this);

    if (this.getFusionScope() === 'none' || extrusions.length === 0 || sceneObjects?.length === 0) {
      this.addShapes(extrusions);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, extrusions);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }

      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.newShapes);
  }

  override getDependencies(): SceneObject[] {
    return this.extrudable ? [this.extrudable] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new ExtrudeTwoDistances(this.distance1, this.distance2, extrudable).syncWith(this);
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
      distance2: this.distance2,
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
