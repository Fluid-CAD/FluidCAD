import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { Sketch } from "./2d/sketch.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Extrudable } from "../helpers/types.js";
import { ExtrudeBase } from "./extrude-base.js";
import { mod } from "three/tsl";

export class Extrude extends ExtrudeBase {
  constructor(
    private extrudable: Extrudable,
    public distance: number) {
    super();
  }

  build(context: BuildSceneObjectContext) {
    const sketchShapes = this.extrudable.getGeometries();

    let sceneObjects = context.getSceneObjects();

    if (this.parentId) {
      sceneObjects.filter(so => so.id !== this.parentId);
    }

    const plane = this.extrudable.getPlane();

    const faces = FaceMaker.getFaces(sketchShapes, this.extrudable.getPlane(), this.getDrill());
    console.log("Extruding faces::", faces);

    const extruder = new Extruder(faces, plane, this.distance, this.getDraft(), this.getEndOffset());
    let extrusions = extruder.extrude();

    this.setState('start-faces', extruder.getStartFaces());
    this.setState('end-faces', extruder.getEndFaces());
    this.setState('side-faces', extruder.getSideFaces());

    this.extrudable.removeShapes(this)

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

  override clone(): SceneObject[] {
    const extrudableClones = this.extrudable.clone();
    const extrudable = extrudableClones.find(c => c instanceof Sketch) as Sketch;
    console.log("Extrude::clone extrudable clone:", extrudable);
    const extrude = new Extrude(extrudable, this.distance).syncWith(this);
    const r = [...extrudableClones, extrude];
    console.log("Extrude::clone created:", r);
    return r;
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
      fusionScope: this.getFusionScope(),
    }
  }
}
