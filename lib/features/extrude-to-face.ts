import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Face, Shape } from "../common/shapes.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { SelectSceneObject } from "./select.js";
import { FaceQuery } from "../oc/face-query.js";
import { FaceOps } from "../oc/face-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";

export class ExtrudeToFace extends ExtrudeBase {
  constructor(
    public face: SceneObject | 'first-face' | 'last-face',
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

    const targetFace = this.getFace();
    const isPlanar = FaceQuery.isPlanarFace(targetFace);

    let solids: Shape[] = [];

    const faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane);

    for (const startFace of faces) {
      if (isPlanar && FaceQuery.areFacePlanesParallel(startFace, targetFace)) {
        const extrusion = this.createSimpleExtrude(startFace, targetFace);
        for (const s of extrusion) {
          solids.push(s);
        }
      }
      else {
        console.log("Creating advanced extrude for face:");
        const shapes = this.createAdvancedExtrude(startFace, targetFace, isPlanar);

        for (const shape of shapes) {
          solids.push(shape);
        }
      }
    }

    this.extrudable.removeShapes(this);

    if (this.face instanceof SelectSceneObject) {
      this.face.removeShapes(this);
    }

    if (this.getFusionScope() === 'none' || sceneObjects.length === 0) {
      this.addShapes(solids);
      return;
    }

    if (solids.length > 0) {
      const fusionResult = fuseWithSceneObjects(sceneObjects, solids);
      // solids = fusionResult.extrusions;

      for (const modifiedShape of fusionResult.modifiedShapes) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(solids);
  }

  private createAdvancedExtrude(sourceFace: Face, targetFace: Face, isPlanar: boolean): Shape[] {
    const targetDistance = FaceQuery.findFarthestCornerDistanceFromFace(targetFace, sourceFace);

    let distance = targetDistance;

    if (isPlanar) {
      distance *= 1.5;
    }

    const sourcePlane = FaceOps.getPlane(sourceFace);
    const extruder = new Extruder([sourceFace], sourcePlane, distance, this.getDraft(), 0);
    const extrusions = extruder.extrude();

    let splitTargetFace: Face;
    if (isPlanar) {
      console.log("Resizing planar target face for splitting");
      splitTargetFace = this.resizePlanarFace(targetFace);
    } else {
      const surfaceType = FaceQuery.getSurfaceType(targetFace);
      if (surfaceType === 'cylinder') {
        splitTargetFace = this.resizeCylindricalFace(targetFace);
      } else {
        splitTargetFace = targetFace;
      }
    }

    const splitShapes = this.splitShapesByFace(extrusions, splitTargetFace);

    return splitShapes;
  }

  private resizePlanarFace(targetFace: Face): Face {
    const endOffset = this.getEndOffset();
    if (endOffset) {
      const dir = this.extrudable.getPlane().normal.reverse();
      return FaceQuery.makeInfinitePlanarFace(targetFace, endOffset, dir);
    }

    return FaceQuery.makeInfinitePlanarFace(targetFace);
  }

  private resizeCylindricalFace(targetFace: Face): Face {
    return FaceQuery.makeInfiniteCylindricalFace(targetFace, this.getEndOffset());
  }

  private splitShapesByFace(extrusions: Shape[], targetFace: Face): Shape[] {
    const result: Shape[] = [];

    const sourcePlane = this.extrudable.getPlane();

    for (const shape of extrusions) {
      const solids = BooleanOps.splitShape(shape, targetFace);

      if (solids.length === 1) {
        result.push(ShapeOps.cleanShape(solids[0]));
      } else {
        let keep: Shape = null;
        for (const s of solids) {
          const faces = Explorer.findFacesWrapped(s);
          if (faces.some(f => FaceOps.faceOnPlaneWrapped(f, sourcePlane))) {
            keep = s;
            break;
          }
        }

        if (!keep) {
          throw new Error("Could not find modified shape with source face");
        }

        result.push(ShapeOps.cleanShape(keep));
      }
    }

    return result;
  }

  private createSimpleExtrude(startFace: Face, targetFace: Face): Shape[] {
    const distance = FaceQuery.getSignedPlaneDistance(startFace, targetFace);
    const plane = FaceQuery.getSurfacePlane(startFace);
    const extruder = new Extruder([startFace], plane, distance, this.getDraft(), this.getEndOffset());
    return extruder.extrude();
  }

  private getFace(): Face {
    if (this.face instanceof SceneObject) {
      const selection = this.face.getShapes();
      if (selection.length === 0) {
        throw new Error("Selection is empty");
      }
      else if (selection.length > 1) {
        throw new Error("Selection has more than one shape");
      }

      const shape = selection[0];
      if (!(shape instanceof Face)) {
        throw new Error("Selection is not a face");
      }

      return shape;
    }
    else if (this.face === 'first-face') {
      return this.getFirstFace();
    }
    else if (this.face === 'last-face') {
      return this.getLastFace();
    }
    else {
      throw new Error("Invalid face parameter");
    }
  }

  getLastFace(): Face {
    throw new Error("Method not implemented.");
  }

  getFirstFace(): Face {
    throw new Error("Method not implemented.");
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.extrudable) {
      deps.push(this.extrudable);
    }
    if (this.face instanceof SceneObject) {
      deps.push(this.face);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const newFace = this.face instanceof SceneObject
      ? (remap.get(this.face) || this.face)
      : this.face;
    const extrudable = this.extrudable
      ? (remap.get(this.extrudable) || this.extrudable) as Extrudable
      : undefined;
    return new ExtrudeToFace(newFace, extrudable).syncWith(this);
  }

  compareTo(other: ExtrudeToFace): boolean {
    if (!(other instanceof ExtrudeToFace)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (!this.extrudable.compareTo(other.extrudable)) {
      return false;
    }

    if (this.face instanceof SceneObject && other.face instanceof SceneObject && !this.face.compareTo(other.face)) {
      return false;
    }

    return true;
  }

  override getUniqueType(): string {
    return 'extrude-to-face';
  }

  serialize() {
    return {
      sheptType: 'wire',
      extrudable: this.extrudable.serialize(),
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      face: typeof (this.face) === 'string' ? this.face : 'selection',
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
    }
  }
}
