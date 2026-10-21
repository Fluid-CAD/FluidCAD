import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Edge, Face, Shape } from "../common/shapes.js";
import { ExtrudeBase } from "./extrude-base.js";
import { disposeBuildTemporaries } from "./build-temporaries.js";
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
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { FaceReach } from "../oc/face-reach.js";
import { mmTol } from "../units/tolerance.js";

export class ExtrudeToFace extends ExtrudeBase {
  constructor(
    public face: SceneObject | 'first-face' | 'last-face',
    source?: Extrudable | SceneObject,
    private faceFilters: FaceFilterBuilder[] = []) {

    super(source);
  }

  build(context: BuildSceneObjectContext) {
    const allSceneObjects = context.getSceneObjects();
    const sceneObjects = this.resolveFusionScope(allSceneObjects);
    const plane = this.getSourcePlane();

    const pickedFaces = this.resolveRegionFaces(plane);
    if (pickedFaces !== null && pickedFaces.length === 0) {
      return;
    }

    let solids: Shape[] = [];
    const allStartFaces: Face[] = [];
    const allEndFaces: Face[] = [];
    const allSideFaces: Face[] = [];
    const allInternalFaces: Face[] = [];

    let faces: Face[];
    let inwardEdges: Edge[] | undefined;
    let outwardEdges: Edge[] | undefined;
    // The profile faces this build made for itself (regions, thin
    // profiles): freed with the tool solids once the fuse has consumed
    // them. Picked or source faces belong to the feature that holds them.
    let builtFaces: Face[] = [];

    if (this.isFaceSourced()) {
      if (this.isThin()) {
        throw new Error("thin() is not supported with a face-sourced extrude");
      }
      faces = pickedFaces ?? this.getSourceFaces();
    } else if (this.isThin()) {
      const thinResult = ThinFaceMaker.make(this.extrudable.getGeometries(), plane, this._thin[0], this._thin[1]);
      faces = thinResult.faces;
      builtFaces = faces;
      inwardEdges = thinResult.inwardEdges;
      outwardEdges = thinResult.outwardEdges;
    } else {
      faces = pickedFaces ?? FaceMaker2.getRegions(this.extrudable.getGeometries(), plane, this.getDrill());
      builtFaces = pickedFaces ? [] : faces;
    }

    // 'first-face' / 'last-face' are found by sweeping the profile, so the
    // profile comes first. The face they pick is this build's wrapper; a
    // selected face stays its selection's.
    const targetFace = this.getFace(allSceneObjects, faces);
    const ownsTargetFace = !(this.face instanceof SceneObject);
    const isPlanar = FaceQuery.isPlanarFace(targetFace);

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

    try {
      if (this._operationMode === 'remove') {
        try {
          cutWithSceneObjects(this.resolveFusionStock(allSceneObjects), solids, plane, 0, this, { recordHistoryFor: this });
        } finally {
          // The tool solids never reach the scene, and the cut records its
          // own internal faces over the tool's.
          for (const shape of solids) shape.dispose();
          for (const face of allInternalFaces) face.dispose();
        }
        this.setFinalShapes(this.getShapes());
        return;
      }

      if (sceneObjects.length === 0) {
        this.addShapes(solids);
        this.recordShapeFacesAndEdgesAsAdditions(solids);
        this.classifyExtrudeEdges();
        this.setFinalShapes(this.getShapes());
        return;
      }

      const fusionResult = fuseWithSceneObjects(this.resolveFusionStock(allSceneObjects), solids, {
        recordHistoryFor: this,
      });

      for (const modifiedShape of fusionResult.modifiedShapes) {
        if (modifiedShape.object) {
          modifiedShape.object.removeShape(modifiedShape.shape, this, modifiedShape.successors);
        }
      }

      this.addShapes(fusionResult.newShapes);

      if (fusionResult.toolHistory) {
        this.remapClassifiedBuckets(fusionResult.toolHistory, fusionResult.newShapes);
      } else {
        this.classifyExtrudeEdges();
      }
      this.setFinalShapes(this.getShapes());
    } finally {
      // The profile faces this build made and the tool solids a fuse
      // consumed: whatever the state still reaches (an unfused solid) stays.
      disposeBuildTemporaries(this, [...builtFaces, ...solids, ...(ownsTargetFace ? [targetFace] : [])]);
    }
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
      } else if (surfaceType === 'cone') {
        splitTargetFace = this.resizeConicalFace(targetFace);
      } else {
        splitTargetFace = targetFace;
      }
    }

    try {
      return this.splitShapesByFace(extrusions, splitTargetFace);
    } finally {
      if (splitTargetFace !== targetFace) splitTargetFace.dispose();
    }
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

  private resizeConicalFace(targetFace: Face): Face {
    return FaceQuery.makeInfiniteConicalFace(targetFace, this.getEndOffset());
  }

  /**
   * Computes the signed distance from the sketch plane to the farthest
   * bounding-box corner of the target face, measured along the sketch
   * plane normal. A target with any extent in front of the plane extrudes
   * along the sketch normal; only a target lying entirely behind the plane
   * extrudes backwards. A target straddling the plane — a cylinder
   * surrounding the sketch, a crossing plane — is reachable both ways, and
   * must not flip direction just because its far wall is deeper behind the
   * sketch than in front.
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

    let forward = 0;
    let backward = 0;
    for (const corner of corners) {
      const d = sketchPlane.signedDistanceToPoint(corner);
      if (d > forward) {
        forward = d;
      }
      if (d < backward) {
        backward = d;
      }
    }

    return forward > 0 ? forward : backward;
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

  private getFace(sceneObjects: SceneObject[], profile: Face[]): Face {
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
      return this.getFirstOrLastFace(sceneObjects, 'first', profile);
    }
    else if (this.face === 'last-face') {
      return this.getFirstOrLastFace(sceneObjects, 'last', profile);
    }
    else {
      throw new Error("Invalid face parameter");
    }
  }

  /**
   * The nearest ('first') or farthest ('last') face the extrusion runs
   * into along the sketch normal. The profile is swept past every
   * candidate and only the faces that sweep actually encloses count; a
   * face beside the path, however close its centre, never stops the
   * extrusion. Among faces met at the same distance a planar one wins:
   * it ends the extrusion with a plain prism.
   */
  private getFirstOrLastFace(sceneObjects: SceneObject[], mode: 'first' | 'last', profile: Face[]): Face {
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

    let candidates: Face[] = allFaces;
    if (this.faceFilters.length > 0) {
      candidates = new ShapeFilter(allFaces, ...this.faceFilters).apply() as Face[];
    }

    let best: Face | null = null;
    try {
      best = this.pickReachedFace(candidates, plane, mode, profile);
    } finally {
      for (const face of allFaces) {
        if (face !== best) face.dispose();
      }
    }

    if (!best) {
      throw new Error(`No face found for '${mode}-face' extrusion`);
    }
    return best;
  }

  private pickReachedFace(candidates: Face[], plane: Plane, mode: 'first' | 'last', profile: Face[]): Face | null {
    if (candidates.length === 0 || profile.length === 0) {
      return null;
    }

    // Sweep past the farthest candidate corner ahead of the plane.
    let reach = 0;
    for (const face of candidates) {
      for (const corner of ShapeOps.boundingBoxCorners(ShapeOps.getBoundingBox(face))) {
        reach = Math.max(reach, plane.signedDistanceToPoint(corner));
      }
    }
    const same = mmTol(1e-5);
    if (reach <= same) {
      return null;
    }

    const sweep = new FaceReach(profile, plane, reach * 1.1 + mmTol(1), this.getDraft());
    try {
      let best: Face | null = null;
      let bestDistance = mode === 'first' ? Infinity : -Infinity;
      let bestPlanar = false;
      for (const face of candidates) {
        const hit = sweep.measure(face);
        if (!hit) {
          continue;
        }
        const distance = mode === 'first' ? hit.entry : hit.exit;
        const closer = mode === 'first' ? distance < bestDistance - same : distance > bestDistance + same;
        const tied = Math.abs(distance - bestDistance) <= same;
        const planar = FaceQuery.isPlanarFace(face);
        if (closer || (tied && planar && !bestPlanar)) {
          best = face;
          bestDistance = distance;
          bestPlanar = planar;
        }
      }
      return best;
    } finally {
      sweep.dispose();
    }
  }

  override getDependencies(): SceneObject[] {
    return [...this.getSourceDependencies()];
  }

  // The up-to-face selection bounds the extrusion against a body that is NOT
  // rebuilt per clone. It must still be copied (build consumes the original
  // selection's shapes via removeShapes), so a clone re-resolves the faces —
  // but as a boundary: traversing into its producer would drag the whole base
  // body chain into every repeat instance, which then re-extrudes the base
  // over the previous instances' results (one hole left instead of N).
  // Face-filter `.from(obj)` references aren't listed at all: FilterBuilder
  // remap falls back to the original object, which is the body the boundary
  // should resolve against.
  override getBoundaryDependencies(): SceneObject[] {
    return this.face instanceof SceneObject ? [this.face] : [];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const newFace = this.face instanceof SceneObject
      ? (remap.get(this.face) || this.face)
      : this.face;
    const source = this.getSource();
    const remapped = source ? (remap.get(source) || source) : undefined;
    const remappedFilters = this.faceFilters.map(f => f.remap(remap) as FaceFilterBuilder);
    return new ExtrudeToFace(newFace, remapped, remappedFilters).syncWith(this);
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

    if (this.face instanceof SceneObject) {
      if (!(other.face instanceof SceneObject)) {
        return false;
      }
      if (!this.face.compareTo(other.face)) {
        return false;
      }
    } else {
      if (this.face !== other.face) {
        return false;
      }
    }

    if (this.faceFilters.length !== other.faceFilters.length) {
      return false;
    }

    for (let i = 0; i < this.faceFilters.length; i++) {
      if (!this.faceFilters[i].equals(other.faceFilters[i])) {
        return false;
      }
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
      faceFilterCount: this.faceFilters.length,
      thin: this._thin,
      ...this.serializePickFields(),
    }
  }
}
