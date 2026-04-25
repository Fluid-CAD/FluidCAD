import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude } from "../core/interfaces.js";
import { LazyVertex } from "./lazy-vertex.js";
import { Point2DLike } from "../math/point.js";
import { Plane } from "../math/plane.js";
import { normalizePoint2D } from "../helpers/normalize.js";
import { FaceOps } from "../oc/face-ops.js";
import { FaceMaker2 } from "../oc/face-maker2.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { Matrix4 } from "../math/matrix4.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { getOC } from "../oc/init.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import type { TopAbs_ShapeEnum } from "occjs-wrapper";

/** A 3D op's classified face buckets. Each is empty if the op doesn't produce that category. */
export type ClassifiedFaces = {
  startFaces: Face[];
  endFaces: Face[];
  sideFaces: Face[];
  internalFaces: Face[];
  capFaces: Face[];
};

function dedupEdgesByMap(edges: Edge[]): Edge[] {
  if (edges.length === 0) {
    return [];
  }
  const oc = getOC();
  const seen = new oc.TopTools_MapOfShape();
  const result: Edge[] = [];
  for (const edge of edges) {
    if (seen.Add(edge.getShape())) {
      result.push(edge);
    }
  }
  seen.delete();
  return result;
}

// Dedup `edges` by TShape pointer while also excluding any edge that shares a
// TShape with one in `excluded`. Single TopTools_MapOfShape pre-seeded with the
// excluded set; Add returns false for duplicates and for already-excluded edges.
function dedupEdgesByMapExcluding(edges: Edge[], excluded: Edge[]): Edge[] {
  if (edges.length === 0) {
    return [];
  }
  const oc = getOC();
  const map = new oc.TopTools_MapOfShape();
  for (const e of excluded) {
    map.Add(e.getShape());
  }
  const result: Edge[] = [];
  for (const edge of edges) {
    if (map.Add(edge.getShape())) {
      result.push(edge);
    }
  }
  map.delete();
  return result;
}

export abstract class ExtrudeBase extends SceneObject implements IExtrude {
  protected _extrudable: Extrudable | null = null;
  protected _faceSource: SceneObject | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _drill?: boolean = true;
  protected _picking: boolean = false;
  protected _pickPoints: LazyVertex[] = [];
  protected _thin?: [number] | [number, number];

  constructor(source?: Extrudable | SceneObject) {
    super();
    if (source) {
      if (source.isExtrudable()) {
        this._extrudable = source as Extrudable;
      } else {
        this._faceSource = source;
      }
    }
  }

  get extrudable(): Extrudable {
    return this._extrudable;
  }

  get faceSource(): SceneObject | null {
    return this._faceSource;
  }

  isFaceSourced(): boolean {
    return this._faceSource !== null;
  }

  getSource(): SceneObject | null {
    return this._extrudable ?? this._faceSource;
  }

  getSourcePlane(): Plane | null {
    if (this._extrudable) {
      return this._extrudable.getPlane();
    }
    const faces = this.getSourceFaces();
    return faces.length > 0 ? faces[0].getPlane() : null;
  }

  getSourceFaces(): Face[] {
    if (!this._faceSource) {
      return [];
    }
    return this._faceSource.getShapes()
      .flatMap(s => s.getSubShapes('face'))
      .filter((f): f is Face => f instanceof Face);
  }

  startFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('start-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('start-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('start-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  endFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('end-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('end-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('end-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  startEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('start-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'start-edges', 'start-faces');
        const transform = parent.getTransform();
        const originalEdges = transform
          ? this.getClassifiedEdges(this, 'start-edges', 'start-faces')
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  endEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('end-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'end-edges', 'end-faces');
        const transform = parent.getTransform();
        const originalEdges = transform
          ? this.getClassifiedEdges(this, 'end-edges', 'end-faces')
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges);
      }, this);
  }

  sideFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('side-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('side-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('side-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  sideEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('side-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const classified = parent.getState('side-edges') as Edge[] | undefined;
        if (classified !== undefined) {
          return this.resolveEdges(classified, args);
        }
        // Fallback for peer ops that haven't called classifyExtrudeEdges: derive on the fly.
        const sideFaces = parent.getState('side-faces') as Face[] || [];
        const startFaces = parent.getState('start-faces') as Face[] || [];
        const endFaces = parent.getState('end-faces') as Face[] || [];
        const excludedEdges = [...startFaces, ...endFaces].flatMap(f => f.getEdges());
        const edges = dedupEdgesByMapExcluding(sideFaces.flatMap(f => f.getEdges()), excludedEdges);
        return this.resolveEdges(edges, args);
      }, this);
  }

  /**
   * Returns the section edges created by a cut operation.
   * Only meaningful when operationMode is 'remove'.
   */
  edges(...indices: number[]): SceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = parent.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) {
          return edges;
        }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      }, this);
  }

  internalFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('internal-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('internal-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('internal-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  internalEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('internal-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'internal-edges', 'internal-faces');
        return this.resolveEdges(edges, args);
      }, this);
  }

  capFaces(...args: number[] | FaceFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('cap-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('cap-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState('cap-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces);
      }, this);
  }

  capEdges(...args: number[] | EdgeFilterBuilder[]): SceneObject {
    const suffix = this.buildSuffix('cap-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'cap-edges', 'cap-faces');
        return this.resolveEdges(edges, args);
      }, this);
  }

  /**
   * Read edges for a classification category, preferring the pre-computed
   * state key (set by `classifyExtrudeEdges` during build) and falling back
   * to deriving from the corresponding face-category state (for peer ops that
   * haven't opted into the unified classification step yet).
   */
  private getClassifiedEdges(source: SceneObject, edgeKey: string, faceKey: string): Edge[] {
    const classified = source.getState(edgeKey) as Edge[] | undefined;
    if (classified !== undefined) {
      return classified;
    }
    const faces = source.getState(faceKey) as Face[] || [];
    return dedupEdgesByMap(faces.flatMap(f => f.getEdges()));
  }

  /**
   * Remap the state-stored face category arrays through a fusion's tool-side
   * history so each face reference points at the actual post-fusion face in
   * the final solid. Call after `fuseWithSceneObjects` returns a `toolHistory`.
   */
  protected remapClassifiedFaces(history: ShapeHistory) {
    const keys = ['start-faces', 'end-faces', 'side-faces', 'internal-faces', 'cap-faces'];
    for (const key of keys) {
      const faces = this.getState(key) as Face[] | undefined;
      if (faces && faces.length > 0) {
        this.setState(key, ShapeHistoryTracker.remapFaces(faces, history));
      }
    }
  }

  /**
   * Record every face/edge of the given shapes as additions on this operation.
   * Used by 3D ops in the "no scene fusion" path — when the tools land
   * unchanged in the scene, every face/edge is brand new from this op's POV.
   */
  protected recordShapeFacesAndEdgesAsAdditions(shapes: Shape[]) {
    const oc = getOC();
    const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
    const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
    for (const shape of shapes) {
      for (const raw of Explorer.findShapes(shape.getShape(), FACE)) {
        this.recordAddedFace(Face.fromTopoDSFace(Explorer.toFace(raw)), this);
      }
      for (const raw of Explorer.findShapes(shape.getShape(), EDGE)) {
        this.recordAddedEdge(Edge.fromTopoDSEdge(Explorer.toEdge(raw)), this);
      }
    }
  }

  /**
   * Shared post-extrude bookkeeping: store classified face state, fuse with
   * the scene (recording history + remapping classification), and finalize
   * with edge classification. Caller is responsible for removing source
   * shapes (they vary across ops — Revolve also removes the axis, etc.)
   * BEFORE calling this.
   */
  protected finalizeAndFuse(
    shapes: Shape[],
    classified: ClassifiedFaces,
    context: BuildSceneObjectContext,
    fuseOpts?: { glue?: 'full' | 'shift' },
  ) {
    const p = context.getProfiler();
    const sceneObjects = this.resolveFusionScope(context.getSceneObjects());

    this.setState('start-faces', classified.startFaces);
    this.setState('end-faces', classified.endFaces);
    this.setState('side-faces', classified.sideFaces);
    this.setState('internal-faces', classified.internalFaces);
    this.setState('cap-faces', classified.capFaces);

    if (shapes.length === 0 || sceneObjects.length === 0) {
      this.addShapes(shapes);
      p.record('Record additions', () => this.recordShapeFacesAndEdgesAsAdditions(shapes));
      p.record('Classify edges', () => this.classifyExtrudeEdges());
      return;
    }

    const fusionResult = fuseWithSceneObjects(sceneObjects, shapes, {
      ...fuseOpts,
      recordHistoryFor: this,
      profiler: p,
    });

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }
      modifiedShape.object.removeShape(modifiedShape.shape, this);
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      p.record('Remap classified faces', () => this.remapClassifiedFaces(fusionResult.toolHistory!));
    }
    p.record('Classify edges', () => this.classifyExtrudeEdges());
  }

  /**
   * One-shot edge classification: derive start/end/side/internal/cap edges
   * from the already-classified face arrays in state and store them as
   * `start-edges`, `end-edges`, `side-edges`, `internal-edges`, `cap-edges`.
   *
   * Call this once after face classification (and after any post-fusion
   * face remapping) so that the selection accessors can just read the
   * pre-computed arrays instead of re-deriving on every access. Matches
   * the classification step from the spec: "Classify the new edges and
   * faces created by the operation".
   *
   * Side edges are the edges of side faces minus any edge that's also on
   * a start/end face (those already belong to start-edges / end-edges).
   */
  protected classifyExtrudeEdges() {
    const startFaces = this.getState('start-faces') as Face[] || [];
    const endFaces = this.getState('end-faces') as Face[] || [];
    const sideFaces = this.getState('side-faces') as Face[] || [];
    const internalFaces = this.getState('internal-faces') as Face[] || [];
    const capFaces = this.getState('cap-faces') as Face[] || [];

    const startEdges = dedupEdgesByMap(startFaces.flatMap(f => f.getEdges()));
    const endEdges = dedupEdgesByMap(endFaces.flatMap(f => f.getEdges()));

    const sideEdges = dedupEdgesByMapExcluding(
      sideFaces.flatMap(f => f.getEdges()),
      [...startEdges, ...endEdges],
    );

    const internalEdges = dedupEdgesByMap(internalFaces.flatMap(f => f.getEdges()));
    const capEdges = dedupEdgesByMap(capFaces.flatMap(f => f.getEdges()));

    this.setState('start-edges', startEdges);
    this.setState('end-edges', endEdges);
    this.setState('side-edges', sideEdges);
    this.setState('internal-edges', internalEdges);
    this.setState('cap-edges', capEdges);
  }

  private buildSuffix(prefix: string, args: any[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private resolveFaces<T extends Shape>(shapes: Face[], args: number[] | FaceFilterBuilder[],
    transform: Matrix4 = null,
    originalShapes: Face[] = null): T[] {
    if (args.length === 0) {
      return new ShapeFilter(shapes).apply() as T[];
    }

    if (args.some(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as T[];
    }

    let filters = args as FaceFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
    }
    return new ShapeFilter(shapes, ...filters).apply() as T[];
  }

  private resolveEdges<T extends Shape>(shapes: Edge[], args: number[] | EdgeFilterBuilder[],
    transform: Matrix4 = null,
    originalShapes: Edge[] = null): T[] {
    if (args.length === 0) {
      return new ShapeFilter(shapes).apply() as T[];
    }

    if (args.some(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as T[];
    }

    let filters = args as EdgeFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
    }
    return new ShapeFilter(shapes, ...filters).apply() as T[];
  }

  draft(value: number | [number, number]): this {
    this._draft = value;
    return this;
  }

  endOffset(value: number): this {
    this._endOffset = value;
    return this;
  }

  drill(value: boolean = true): this {
    this._drill = value;
    return this;
  }

  thin(offset1: number, offset2?: number): this {
    this._thin = offset2 !== undefined ? [offset1, offset2] : [offset1];
    return this;
  }

  isThin(): boolean {
    return this._thin !== undefined;
  }

  getThinOffsets(): [number] | [number, number] | undefined {
    return this._thin;
  }

  protected serializePickFields() {
    const plane = this.getSourcePlane();
    return {
      picking: this.isPicking() || undefined,
      pickPoints: this.isPicking()
        ? this._pickPoints.map(p => { const pt = p.asPoint2D(); return [pt.x, pt.y]; })
        : undefined,
      trigger: this.isThin() ? undefined : 'region-picking' as const,
      pickPlane: plane ? {
        origin: plane.origin,
        xDirection: plane.xDirection,
        yDirection: plane.yDirection,
        normal: plane.normal,
      } : undefined,
    };
  }

  pick(...points: Point2DLike[]): this {
    this._picking = true;
    this._pickPoints = points.map(p => normalizePoint2D(p));
    return this;
  }

  isPicking(): boolean {
    return this._picking;
  }

  getPickPoints(): LazyVertex[] {
    return this._pickPoints;
  }

  /**
   * Resolves pick mode: partitions sketch into cells via CellsBuilder,
   * classifies which cells are selected, adds meta shapes for all cells + edges,
   * and returns the selected faces to extrude.
   * Returns null if not in pick mode.
   */
  protected resolvePickedFaces(plane: Plane): Face[] | null {
    if (!this.isPicking()) {
      return null;
    }

    const sketchShapes = this.extrudable.getGeometries();
    const cells = FaceMaker2.getRegions(sketchShapes, plane, false);

    if (cells.length === 0) {
      return [];
    }

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

      for (const edge of cell.getEdges()) {
        edge.markAsMetaShape('pick-edge');
        this.addShape(edge);
      }
    }

    return selectedCells;
  }

  override clean(allObjects: SceneObject[]): void {
    if (!this.isPicking()) {
      return;
    }

    const lastObject = allObjects[allObjects.length - 1];
    if (lastObject !== this) {
      this.removeMetaShapes(lastObject);
    }
  }

  removeMetaShapes(removedBy: SceneObject): void {
    for (const shape of this.getAddedShapes()) {
      if (shape.isMetaShape()) {
        this.removeShape(shape, removedBy);
      }
    }
  }

  getDraft(): [number, number] {
    const draft = this._draft;
    if (!draft) {
      return null;
    }

    return draft instanceof Array ? draft : [draft, draft];
  }

  getEndOffset(): number | undefined {
    return this._endOffset;
  }

  getDrill(): boolean {
    return this._drill;
  }

  protected syncWith(other: ExtrudeBase) {
    this._draft = other._draft;
    this._endOffset = other._endOffset;
    this._fusionScope = other._fusionScope;
    this._operationMode = other._operationMode;
    this._symmetric = other._symmetric;
    this._picking = other._picking;
    this._pickPoints = other._pickPoints;
    this._thin = other._thin;
    this._drill = other._drill;
    return this;
  }

  /**
   * Reclassifies faces for thin open-profile extrusions into side, internal, and cap faces.
   * Uses 2D midpoint projection (onto sketch plane) to match reference face edges to
   * the inward/outward wire edges, then IsPartner within the solid to classify faces.
   */
  protected reclassifyThinFaces(
    remainingFaces: Face[],
    referenceFaces: Face[],
    plane: Plane,
    inwardEdges: Edge[],
    outwardEdges: Edge[]
  ): { sideFaces: Face[]; internalFaces: Face[]; capFaces: Face[] } {
    // Project edge midpoints to 2D on the sketch plane for height-independent matching
    const to2D = (edge: Edge) => plane.worldToLocal(EdgeOps.getEdgeMidPointRaw(edge.getShape()));

    const inwardMids = inwardEdges.map(to2D);
    const outwardMids = outwardEdges.map(to2D);

    // Find reference face edges matching inward/outward in 2D
    const solidInwardEdges: Edge[] = [];
    const solidOutwardEdges: Edge[] = [];

    for (const rf of referenceFaces) {
      for (const rfe of rf.getEdges()) {
        const rfeMid = to2D(rfe);
        if (inwardMids.some(mp => rfeMid.distanceTo(mp) < 1e-4)) {
          solidInwardEdges.push(rfe);
        } else if (outwardMids.some(mp => rfeMid.distanceTo(mp) < 1e-4)) {
          solidOutwardEdges.push(rfe);
        }
      }
    }

    // Classify remaining faces using IsPartner within the solid
    const sideFaces: Face[] = [];
    const internalFaces: Face[] = [];
    const capFaces: Face[] = [];

    for (const f of remainingFaces) {
      const faceEdges = f.getEdges();
      const isInward = solidInwardEdges.length > 0 && faceEdges.some(fe =>
        solidInwardEdges.some(ie => fe.getShape().IsPartner(ie.getShape()))
      );
      const isOutward = solidOutwardEdges.length > 0 && faceEdges.some(fe =>
        solidOutwardEdges.some(oe => fe.getShape().IsPartner(oe.getShape()))
      );

      if (isInward) {
        internalFaces.push(f);
      } else if (isOutward) {
        sideFaces.push(f);
      } else {
        capFaces.push(f);
      }
    }

    return { sideFaces, internalFaces, capFaces };
  }

  compareTo(other: ExtrudeBase): boolean {
    if (!super.compareTo(other)) {
      return false;
    }

    if (this._endOffset !== other._endOffset
      || this._drill !== other._drill) {
      return false;
    }

    if (this._picking !== other._picking) {
      return false;
    }

    if (this._pickPoints.length !== other._pickPoints.length) {
      return false;
    }

    for (let i = 0; i < this._pickPoints.length; i++) {
      if (!this._pickPoints[i].compareTo(other._pickPoints[i])) {
        return false;
      }
    }

    const thisThin = this._thin;
    const otherThin = other._thin;
    if ((thisThin === undefined) !== (otherThin === undefined)) {
      return false;
    }
    if (thisThin && otherThin) {
      if (thisThin.length !== otherThin.length) {
        return false;
      }
      for (let i = 0; i < thisThin.length; i++) {
        if (thisThin[i] !== otherThin[i]) {
          return false;
        }
      }
    }

    let thisDraft = this._draft || [0, 0];
    let otherDraft = other._draft || [0, 0];

    thisDraft = this._draft instanceof Array ? this._draft : [this._draft, this._draft];
    otherDraft = other._draft instanceof Array ? other._draft : [other._draft, other._draft];

    if (thisDraft[0] !== otherDraft[0] || thisDraft[1] !== otherDraft[1]) {
      return false;
    }

    return true;
  }

  getType(): string {
    return this._operationMode === "remove" ? "cut" : "extrude";
  }
}
