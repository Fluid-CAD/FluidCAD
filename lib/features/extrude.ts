import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Extrudable } from "../helpers/types.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";

export class Extrude extends ExtrudeBase {
  constructor(public distance: number, extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    let sceneObjects = context.getSceneObjects();

    if (this.parentId) {
      sceneObjects.filter(so => so.id !== this.parentId);
    }

    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null) {
      if (pickedFaces.length > 0) {
        this.extrudeAndFuse(pickedFaces, plane, sceneObjects);
      }
      return;
    }

    const sketchShapes = this.extrudable.getGeometries();
    const faces = FaceMaker2.getRegions(sketchShapes, this.extrudable.getPlane(), this.getDrill());
    console.log('Extrude: Generated faces count:', faces.length);
    this.extrudeAndFuse(faces, plane, sceneObjects);
    this.extrudable.removeShapes(this);
  }

  private extrudeAndFuse(faces: Face[], plane: any, sceneObjects: SceneObject[]) {
    const extruder = new Extruder(faces, plane, this.distance, this.getDraft(), this.getEndOffset());
    let extrusions = extruder.extrude();

    this.setState('start-faces', extruder.getStartFaces());
    this.setState('end-faces', extruder.getEndFaces());
    this.setState('side-faces', extruder.getSideFaces());

    console.log('Extrude: Generated extrusions count:', extrusions.length);

    console.log('Extrude: Fusion scope:', this.getFusionScope());
    if (this.getFusionScope() === 'none' || extrusions.length === 0 || sceneObjects?.length === 0) {
      this.addShapes(extrusions);
      return;
    }

    console.log('::: Extrusions to fuse count:', extrusions.length);

    const fusionResult = fuseWithSceneObjects(sceneObjects, extrusions);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }

      modifiedShape.object.removeShape(modifiedShape.shape, this)
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
    return new Extrude(this.distance, extrudable).syncWith(this);
  }

  compareTo(other: Extrude): boolean {
    if (!(other instanceof Extrude)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    if (this.distance !== other.distance) {
      return false;
    }

    return true;
  }

  getUniqueType(): string {
    return 'extrude-by-distance';
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance: this.distance,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
