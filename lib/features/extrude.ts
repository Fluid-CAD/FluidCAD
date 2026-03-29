import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { Extrudable } from "../helpers/types.js";
import { ExtrudeBase } from "./extrude-base.js";
import { getOC } from "../oc/init.js";
import { Explorer } from "../oc/explorer.js";
import { FaceOps } from "../oc/face-ops.js";
import { Face } from "../common/face.js";
import { Plane } from "../math/plane.js";

export class Extrude extends ExtrudeBase {
  constructor(public distance: number, extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const sketchShapes = this.extrudable.getGeometries();

    let sceneObjects = context.getSceneObjects();

    if (this.parentId) {
      sceneObjects.filter(so => so.id !== this.parentId);
    }

    const plane = this.extrudable.getPlane();

    if (this.isPicking()) {
      this.buildWithPicking(context, sceneObjects, plane);
      return;
    }

    const faces = FaceMaker.getFaces(sketchShapes, this.extrudable.getPlane(), this.getDrill());
    console.log("Extruding faces::", faces);

    this.extrudeAndFuse(faces, plane, sceneObjects);
  }

  private buildWithPicking(context: BuildSceneObjectContext, sceneObjects: SceneObject[], plane: Plane) {
    const sketchShapes = this.extrudable.getGeometries();
    const oc = getOC();

    // First create faces from the sketch wires (without fusing/drilling),
    // then feed them into CellsBuilder to partition overlapping regions
    const sketchFaces = FaceMaker.getFaces(sketchShapes, plane, false);

    if (sketchFaces.length === 0) {
      console.log('CellsBuilder: No faces from sketch wires');
      return;
    }

    const cellsBuilder = new oc.BOPAlgo_CellsBuilder();

    const argsList = new oc.TopTools_ListOfShape();
    for (const face of sketchFaces) {
      argsList.Append(face.getShape());
    }
    cellsBuilder.SetArguments(argsList);

    const progress = new oc.Message_ProgressRange();
    cellsBuilder.Perform(progress);

    if (cellsBuilder.HasErrors()) {
      console.error('CellsBuilder: Perform() reported errors');
      cellsBuilder.delete();
      argsList.delete();
      progress.delete();
      return;
    }

    // Get all cells as a compound shape, then extract faces
    cellsBuilder.AddAllToResult(0, false);
    cellsBuilder.MakeContainers();
    const resultShape = cellsBuilder.Shape();

    const rawFaces = Explorer.findShapes(resultShape, Explorer.getOcShapeType("face"));
    const cells: Face[] = rawFaces.map(f => Face.fromTopoDSFace(oc.TopoDS.Face(f)));

    console.log('CellsBuilder: Found', cells.length, 'face cells');

    // Classify cells by pick points
    const pickPoints = this.getPickPoints();
    const selectedCells: Face[] = [];

    for (const cell of cells) {
      let isSelected = false;
      let pickPoint: [number, number] | null = null;
      for (const lazyPt of pickPoints) {
        const pt2d = lazyPt.asPoint2D();
        const pt3d = plane.localToWorld(pt2d);
        if (FaceOps.isPointInsideFace(pt3d, cell)) {
          isSelected = true;
          pickPoint = [pt2d.x, pt2d.y];
          break;
        }
      }

      if (isSelected) {
        cell.markAsMetaShape('pick-region-selected');
        cell.metaData = { pickPoint };
        selectedCells.push(cell);
      } else {
        cell.markAsMetaShape('pick-region');
      }
      this.addShape(cell);
    }

    // If we have selected cells, extrude them
    if (selectedCells.length > 0) {
      this.extrudeAndFuse(selectedCells, plane, sceneObjects);
    }

    // Cleanup
    cellsBuilder.delete();
    argsList.delete();
    progress.delete();
  }

  private extrudeAndFuse(faces: Face[], plane: any, sceneObjects: SceneObject[]) {
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
      fusionScope: this.getFusionScope(),
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
