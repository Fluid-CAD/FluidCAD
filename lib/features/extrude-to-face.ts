import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Face, Shape } from "../common/shapes.js";
import { ExtrudeBase } from "./extrude-base.js";
import { Extruder } from "./simple-extruder.js";
import { fuseWithSceneObjects, cutWithSceneObjects } from "../helpers/scene-helpers.js";
import { FaceQuery } from "../oc/face-query.js";
import { FaceOps } from "../oc/face-ops.js";
import { BooleanOps } from "../oc/boolean-ops.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { Explorer } from "../oc/explorer.js";
import { Extrudable } from "../helpers/types.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { ThinFaceMaker } from "../oc/thin-face-maker.js";
import { Plane } from "../math/plane.js";
import { Point } from "../math/point.js";

export class ExtrudeToFace extends ExtrudeBase {
  constructor(
    public face: SceneObject | 'first-face' | 'last-face',
    source?: Extrudable | SceneObject) {

    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const allSceneObjects = context.getSceneObjects();
    const sceneObjects = this.resolveFusionScope(allSceneObjects);
    const plane = this.getSourcePlane();

    const pickedFaces = this.resolvePickedFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    const targetFace = this.getFace(allSceneObjects);
    const isPlanar = FaceQuery.isPlanarFace(targetFace);

    let solids: Shape[] = [];
    const allStartFaces: Face[] = [];
    const allEndFaces: Face[] = [];
    const allSideFaces: Face[] = [];
    const allInternalFaces: Face[] = [];

    let faces: Face[];
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;

    if (this.isFaceSourced()) {
      if (this.isThin()) {
        throw new Error("thin() is not supported with a face-sourced extrude");
      }
      faces = pickedFaces ?? this.getSourceFaces();
    } else if (this.isThin()) {
      const thinResult = ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]);
      faces = thinResult.faces;
      inwardEdges = thinResult.inwardEdges;
      outwardEdges = thinResult.outwardEdges;
    } else {
      faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane);
    }

    const allCapFaces: Face[] = [];

    for (const startFace of faces) {
      if (isPlanar && FaceQuery.areFacePlanesParallel(startFace, targetFace)) {
        const { shapes, extruder } = this.createSimpleExtrude(startFace, targetFace, plane);
        for (const s of shapes) {
          solids.push(s);
        }

        if (inwardEdges && inwardEdges.length > 0) {
          const result = this.reclassifyThinFaces(
            [...extruder.getSideFaces(), ...extruder.getInternalFaces()],
            extruder.getStartFaces(), plane, inwardEdges, outwardEdges || []
          );
          allStartFaces.push(...extruder.getStartFaces());
          allEndFaces.push(...extruder.getEndFaces());
          allSideFaces.push(...result.sideFaces);
          allInternalFaces.push(...result.internalFaces);
          allCapFaces.push(...result.capFaces);
        } else {
          allStartFaces.push(...extruder.getStartFaces());
          allEndFaces.push(...extruder.getEndFaces());
          allSideFaces.push(...extruder.getSideFaces());
          allInternalFaces.push(...extruder.getInternalFaces());
        }
      }
      else {
        console.log("Creating advanced extrude for face:");
        const advancedShapes = this.createAdvancedExtrude(startFace, targetFace, isPlanar, plane);

        for (const shape of advancedShapes) {
          solids.push(shape);
        }
      }
    }

    this.setState('start-faces', allStartFaces);
    this.setState('end-faces', allEndFaces);
    this.setState('side-faces', allSideFaces);
    this.setState('internal-faces', allInternalFaces);
    this.setState('cap-faces', allCapFaces);

    this.getSource()?.removeShapes(this);

    if (this.face instanceof SceneObject) {
      this.face.removeShapes(this);
    }

    if (this._operationMode === 'remove') {
      const scope = this.resolveFusionScope(allSceneObjects);
      cutWithSceneObjects(scope, solids, plane, 0, this);
      return;
    }

    if (sceneObjects.length === 0) {
      this.addShapes(solids);
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, solids);

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (modifiedShape.object) {
        modifiedShape.object.removeShape(modifiedShape.shape, this);
      }
    }

    this.addShapes(fusionResult.newShapes);
  }

  private createAdvancedExtrude(sourceFace: Face, targetFace: Face, isPlanar: boolean, sketchPlane: Plane): Shape[] {
    const targetDistance = this.computeSignedDistanceToFace(targetFace, sketchPlane);

    let distance = targetDistance;

    if (isPlanar) {
      distance *= 1.5;
    }

    const extruder = new Extruder([sourceFace], sketchPlane, distance, this.getDraft(), 0);
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
      const dir = this.getSourcePlane().normal.reverse();
      return FaceQuery.makeInfinitePlanarFace(targetFace, endOffset, dir);
    }

    return FaceQuery.makeInfinitePlanarFace(targetFace);
  }

  private resizeCylindricalFace(targetFace: Face): Face {
    return FaceQuery.makeInfiniteCylindricalFace(targetFace, this.getEndOffset());
  }

  /**
   * Computes the signed distance from the sketch plane to the farthest
   * bounding-box corner of the target face, measured along the sketch
   * plane normal. This ensures the extrusion direction is always
   * consistent with the sketch plane orientation.
   */
  private computeSignedDistanceToFace(targetFace: Face, sketchPlane: Plane): number {
    const bbox = ShapeOps.getBoundingBox(targetFace);
    const corners = [
      new Point(bbox.minX, bbox.minY, bbox.minZ),
      new Point(bbox.maxX, bbox.minY, bbox.minZ),
      new Point(bbox.minX, bbox.maxY, bbox.minZ),
      new Point(bbox.minX, bbox.minY, bbox.maxZ),
      new Point(bbox.maxX, bbox.maxY, bbox.minZ),
      new Point(bbox.maxX, bbox.minY, bbox.maxZ),
      new Point(bbox.minX, bbox.maxY, bbox.maxZ),
      new Point(bbox.maxX, bbox.maxY, bbox.maxZ),
    ];

    let maxDistance = 0;
    for (const corner of corners) {
      const d = sketchPlane.signedDistanceToPoint(corner);
      if (Math.abs(d) > Math.abs(maxDistance)) {
        maxDistance = d;
      }
    }

    return maxDistance;
  }

  private splitShapesByFace(extrusions: Shape[], targetFace: Face): Shape[] {
    const result: Shape[] = [];

    const sourcePlane = this.getSourcePlane();

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

  private createSimpleExtrude(startFace: Face, targetFace: Face, sketchPlane: Plane): { shapes: Shape[]; extruder: Extruder } {
    const targetPlane = FaceQuery.getSurfacePlane(targetFace);
    const distance = sketchPlane.signedDistanceToPoint(targetPlane.origin);
    const extruder = new Extruder([startFace], sketchPlane, distance, this.getDraft(), this.getEndOffset());
    const shapes = extruder.extrude();
    return { shapes, extruder };
  }

  private getFace(sceneObjects: SceneObject[]): Face {
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
      return this.getFirstOrLastFace(sceneObjects, 'first');
    }
    else if (this.face === 'last-face') {
      return this.getFirstOrLastFace(sceneObjects, 'last');
    }
    else {
      throw new Error("Invalid face parameter");
    }
  }

  private getFirstOrLastFace(sceneObjects: SceneObject[], mode: 'first' | 'last'): Face {
    const plane = this.getSourcePlane();
    const source = this.getSource();
    const allFaces: Face[] = [];

    for (const obj of sceneObjects) {
      if (obj === source) {
        continue;
      }
      for (const shape of obj.getShapes()) {
        const faces = Explorer.findFacesWrapped(shape);
        for (const face of faces) {
          allFaces.push(face as Face);
        }
      }
    }

    const result = FaceQuery.findFaceByDistance(allFaces, plane, mode);
    if (!result) {
      throw new Error(`No face found for '${mode}-face' extrusion`);
    }
    return result;
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    const source = this.getSource();
    if (source) {
      deps.push(source);
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
    const source = this.getSource();
    const remapped = source ? (remap.get(source) || source) : undefined;
    return new ExtrudeToFace(newFace, remapped).syncWith(this);
  }

  compareTo(other: ExtrudeToFace): boolean {
    if (!(other instanceof ExtrudeToFace)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    const thisSource = this.getSource();
    const otherSource = other.getSource();
    if (!thisSource !== !otherSource) {
      return false;
    }
    if (thisSource && otherSource && !thisSource.compareTo(otherSource)) {
      return false;
    }

    if (typeof (this.face) !== typeof (other.face)) {
      return false;
    }

    if (this.face instanceof SceneObject && other.face instanceof SceneObject && !this.face.compareTo(other.face)) {
      return false;
    }

    if (this.face !== other.face) {
      return false;
    }

    return true;
  }

  override getUniqueType(): string {
    if (this._operationMode === 'remove') {
      return 'cut';
    }
    return 'extrude-to-face';
  }

  serialize() {
    return {
      sheptType: 'wire',
      extrudable: this.getSource()?.serialize(),
      draft: this.getDraft(),
      endOffset: this.getEndOffset(),
      face: typeof (this.face) === 'string' ? this.face : 'selection',
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
