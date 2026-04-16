import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { ExtrudeBase } from "./extrude-base.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { Extruder } from "./simple-extruder.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";

export class ExtrudeTwoDistances extends ExtrudeBase {

  constructor(
    public distance1: number,
    public distance2: number,
    extrudable?: Extrudable) {

    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    let faces: Face[];
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    if (this.isThin()) {
      const thinResult = ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]);
      faces = thinResult.faces;
      inwardEdges = thinResult.inwardEdges;
      outwardEdges = thinResult.outwardEdges;
    } else {
      faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());
    }

    const extruder1 = new Extruder(faces, plane, this.distance1, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();
    const startFaces = extruder1.getEndFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();
    const endFaces = extruder2.getEndFaces();

    const preFusionInternalFaces = [
      ...extruder1.getInternalFaces(),
      ...extruder2.getInternalFaces(),
    ];

    const all = [...extrusions1, ...extrusions2];
    const { result: extrusions } = BooleanOps.fuse(all);

    const remainingFaces: Face[] = [];
    for (const solid of extrusions) {
      const allFaces = Explorer.findFacesWrapped(solid);
      for (const f of allFaces) {
        const isStart = startFaces.some(sf => f.getShape().IsSame(sf.getShape()));
        const isEnd = endFaces.some(ef => f.getShape().IsSame(ef.getShape()));
        if (!isStart && !isEnd) {
          remainingFaces.push(f as Face);
        }
      }
    }

    let sideFaces: Face[];
    let internalFaces: Face[];
    let capFaces: Face[] = [];

    if (inwardEdges && inwardEdges.length > 0) {
      const result = this.reclassifyThinFaces(
        remainingFaces, [...startFaces, ...endFaces], plane, inwardEdges, outwardEdges || []
      );
      sideFaces = result.sideFaces;
      internalFaces = result.internalFaces;
      capFaces = result.capFaces;
    } else {
      sideFaces = [];
      internalFaces = [];
      for (const f of remainingFaces) {
        const isInternal = preFusionInternalFaces.some(pf => f.getShape().IsSame(pf.getShape()));
        if (isInternal) {
          internalFaces.push(f);
        } else {
          sideFaces.push(f);
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);
    this.setState('internal-faces', internalFaces);
    this.setState('cap-faces', capFaces);

    this.extrudable.removeShapes(this);

    if (this._operationMode === 'remove') {
      const scope = this.resolveFusionScope(context.getSceneObjects());
      cutWithSceneObjects(scope, extrusions, plane, this.distance1 + this.distance2, this);
      return;
    }

    if (extrusions.length === 0 || sceneObjects.length === 0) {
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
    if (this._operationMode === 'remove') {
      return 'cut';
    }
    return 'extrude-by-two-distance';
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance1: this.distance1,
      distance2: this.distance2,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
