import { SceneObject } from "../common/scene-object.js";
import { Face, Shape } from "../common/shapes.js";
import { ExtrudeOptions } from "./extrude-options.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { SelectSceneObject } from "./select.js";
import { FaceMaker } from "../core/2d/face-maker.js";
import { FaceQuery } from "../oc/face-query.js";
import { FaceOps } from "../oc/face-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Extrudable } from "../helpers/types.js";

export class ExtrudeToFace extends ExtrudeBase {
  constructor(
    public extrudable: Extrudable,
    public face: SceneObject | 'first-face' | 'last-face',
    public sceneObjects: SceneObject[]) {

    super();
  }

  build() {
    const targetFace = this.getFace();
    const isPlanar = FaceQuery.isPlanarFace(targetFace);

    console.log("Target face:", targetFace);

    let solids: Shape[] = [];

    const wires = this.extrudable.getGeometries();
    const plane = this.extrudable.getPlane();
    const faces = FaceMaker.getFaces(wires, plane);

    console.log("Extruding faces:", faces);

    for (const startFace of faces) {
      if (isPlanar && FaceQuery.areFacePlanesParallel(startFace, targetFace)) {
        const extrusion = this.createSimpleExtrude(startFace, targetFace);
        for (const s of extrusion) {
          solids.push(s);
        }
      }
      else {
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

    if (this.getFusionScope() === 'none' || this.sceneObjects.length === 0) {
      this.addShapes(solids);
      return;
    }

    if (solids.length > 0) {
      const fusionResult = fuseWithSceneObjects(this.sceneObjects, solids);
      solids = fusionResult.extrusions;

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

    const sourceConvertedPlane = FaceOps.getPlane(sourceFace);
    const extruder = new Extruder([sourceFace], sourceConvertedPlane, distance, this.getDraft(), 0);
    const extrusions = extruder.extrude();

    let splitTargetFace: Face;
    if (isPlanar) {
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
    if (this.face instanceof SelectSceneObject) {
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
      face: typeof (this.face) === 'string' ? this.face : 'selection'
    }
  }
}
