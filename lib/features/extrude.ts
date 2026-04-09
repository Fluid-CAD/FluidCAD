import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { Extrudable } from "../helpers/types.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Face } from "../common/face.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ExtrudeThroughAll } from "./infinite-extrude.js";

export class Extrude extends ExtrudeBase {
  constructor(public distance: number, extrudable?: Extrudable) {
    super(extrudable);
  }

  build(context: BuildSceneObjectContext) {
    const plane = this.extrudable.getPlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const faces = pickedFaces ?? FaceMaker2.getRegions(
      this.extrudable.getGeometries(),
      plane,
      this.getDrill()
    );

    if (this._operationMode === 'remove') {
      this.buildRemove(faces, plane, context);
    } else if (this._symmetric) {
      this.buildSymmetric(faces, plane, context);
    } else {
      this.buildAdd(faces, plane, context);
    }
  }

  private buildAdd(faces: Face[], plane: any, context: BuildSceneObjectContext) {
    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());

    const extruder = new Extruder(faces, plane, this.distance, this.getDraft(), this.getEndOffset());
    let extrusions = extruder.extrude();

    this.setState('start-faces', extruder.getStartFaces());
    this.setState('end-faces', extruder.getEndFaces());
    this.setState('side-faces', extruder.getSideFaces());
    this.setState('internal-faces', extruder.getInternalFaces());

    this.extrudable.removeShapes(this);

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

  private buildSymmetric(faces: Face[], plane: any, context: BuildSceneObjectContext) {
    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());

    const extruder1 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions1 = extruder1.extrude();
    const startFaces = extruder1.getEndFaces();

    const extruder2 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
    const extrusions2 = extruder2.extrude();
    const endFaces = extruder2.getEndFaces();

    const preFusionInternalFaces = [
      ...extruder1.getInternalFaces(),
      ...extruder2.getInternalFaces(),
    ];

    const all = [...extrusions1, ...extrusions2];
    const { result: extrusions } = BooleanOps.fuse(all);

    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];
    for (const solid of extrusions) {
      const allFaces = Explorer.findFacesWrapped(solid);
      for (const f of allFaces) {
        const isStart = startFaces.some(sf => f.getShape().IsSame(sf.getShape()));
        const isEnd = endFaces.some(ef => f.getShape().IsSame(ef.getShape()));
        if (!isStart && !isEnd) {
          const isInternal = preFusionInternalFaces.some(pf => f.getShape().IsSame(pf.getShape()));
          if (isInternal) {
            internalFaces.push(f as Face);
          } else {
            sideFaces.push(f as Face);
          }
        }
      }
    }

    this.setState('start-faces', startFaces);
    this.setState('end-faces', endFaces);
    this.setState('side-faces', sideFaces);
    this.setState('internal-faces', internalFaces);

    this.extrudable.removeShapes(this);

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

  private buildRemove(faces: Face[], plane: any, context: BuildSceneObjectContext) {
    const scope = this.resolveFusionScope(context.getSceneObjects());

    let toolShapes: any[];
    const isThroughAll = this.distance === 0;

    if (this._symmetric) {
      // Symmetric cut: create tool centered on sketch plane
      if (isThroughAll) {
        const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, true, true);
        toolShapes = extrudeThroughAll.build();
      } else {
        const extruder1 = new Extruder(faces, plane, -this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions1 = extruder1.extrude();
        const extruder2 = new Extruder(faces, plane, this.distance / 2, this.getDraft(), this.getEndOffset());
        const extrusions2 = extruder2.extrude();
        const all = [...extrusions1, ...extrusions2];
        const { result } = BooleanOps.fuse(all);
        toolShapes = result;
      }
    } else if (isThroughAll) {
      const extrudeThroughAll = new ExtrudeThroughAll(this.extrudable, false, true);
      toolShapes = extrudeThroughAll.build();
    } else {
      const distance = -this.distance;
      const extruder = new Extruder(faces, plane, distance, this.getDraft(), this.getEndOffset());
      toolShapes = extruder.extrude();
    }

    this.extrudable.removeShapes(this);

    cutWithSceneObjects(scope, toolShapes, plane, this.distance, this);
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
    if (this._symmetric) {
      return 'extrude-symmetric';
    }
    if (this._operationMode === 'remove') {
      return 'cut-by-distance';
    }
    return 'extrude-by-distance';
  }

  serialize() {
    return {
      extrudable: this.extrudable.serialize(),
      distance: this.distance,
      operationMode: this._operationMode !== 'add' ? this._operationMode : undefined,
      symmetric: this._symmetric || undefined,
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
