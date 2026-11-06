import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { LazySelectionSceneObject } from "./lazy-scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { IExtrude } from "../core/interfaces.js";
import { GeometrySceneObject } from "./2d/geometry.js";
import { Plane } from "../math/plane.js";
import { SketchRegion } from "./2d/regions/region-builder.js";
import { declaredNameOf, sourceRegionContext } from "./2d/regions/source-regions.js";
import { resolveRegions } from "./2d/regions/region-match.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { applyBucketFilters } from "../filters/bucket-scope.js";
import { Matrix4 } from "../math/matrix4.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { type NumberParam, resolveParam } from "../core/param.js";
import { ShapeHistory, ShapeHistoryTracker } from "../common/shape-history-tracker.js";
import { ClassifiedBucketRemapper, ClassifiedBuckets, FusedEdgeBuckets } from "./classified-buckets.js";
import { disposeBuildTemporaries } from "./build-temporaries.js";
import { fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { mmTol } from "../units/tolerance.js";

/** A 3D op's classified face buckets. Each is empty if the op doesn't produce that category. */
export type ClassifiedFaces = {
  startFaces: Face[];
  endFaces: Face[];
  sideFaces: Face[];
  internalFaces: Face[];
  capFaces: Face[];
};

/** One region of the source in the feature's payload — the picker reads these. */
type SerializedRegion = { key: string; index: number; name: string | null; selected: boolean };

export abstract class ExtrudeBase extends SceneObject implements IExtrude {
  protected _extrudable: Extrudable | null = null;
  protected _faceSource: SceneObject | null = null;
  protected _draft?: number | [number, number];
  protected _endOffset?: number;
  protected _drill?: boolean = true;
  protected _regionPicking: boolean = false;
  protected _regionNames: string[] = [];
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

  /**
   * Dependency tail for cloning: if the source is a sketch-bound geometry
   * primitive, return its containing `Sketch` so cloneWithTransform pulls
   * the sketch in too. The sketch's clone-mode build path then carries
   * correctly-transformed shapes onto cloned children, and the cloned
   * primitive retains a `Sketch` parent for plane resolution. Otherwise
   * return the source as-is.
   */
  protected getSourceDependencies(): SceneObject[] {
    const source = this.getSource();
    if (!source) {
      return [];
    }
    if (source instanceof GeometrySceneObject) {
      const sketch = source.sketch;
      if (sketch) {
        return [sketch];
      }
    }
    return [source];
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

  startFaces(...args: number[] | FaceFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('start-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('start-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.bucketOrigin().getState('start-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  endFaces(...args: number[] | FaceFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('end-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('end-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.bucketOrigin().getState('end-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  startEdges(...args: number[] | EdgeFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('start-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'start-edges', 'start-faces');
        const transform = parent.getTransform();
        const originalEdges = transform
          ? this.getClassifiedEdges(this.bucketOrigin(), 'start-edges', 'start-faces')
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges, parent);
      }, this, args);
  }

  endEdges(...args: number[] | EdgeFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('end-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'end-edges', 'end-faces');
        const transform = parent.getTransform();
        const originalEdges = transform
          ? this.getClassifiedEdges(this.bucketOrigin(), 'end-edges', 'end-faces')
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges, parent);
      }, this, args);
  }

  sideFaces(...args: number[] | FaceFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('side-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('side-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.bucketOrigin().getState('side-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  sideEdges(...args: number[] | EdgeFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('side-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const classified = parent.getState('side-edges') as Edge[] | undefined;
        if (classified !== undefined) {
          return this.resolveEdges(classified, args, null, null, parent);
        }
        // Fallback for peer ops that haven't called classifyExtrudeEdges: derive on the fly.
        const sideFaces = parent.getState('side-faces') as Face[] || [];
        const startFaces = parent.getState('start-faces') as Face[] || [];
        const endFaces = parent.getState('end-faces') as Face[] || [];
        const excludedEdges = [...startFaces, ...endFaces].flatMap(f => f.getEdges());
        const edges = ClassifiedBuckets.distinctExcluding(sideFaces.flatMap(f => f.getEdges()), excludedEdges);
        return this.resolveEdges(edges, args, null, null, parent);
      }, this, args);
  }

  /**
   * Returns the section edges created by a cut operation.
   * Only meaningful when operationMode is 'remove'.
   */
  edges(...indices: number[]): LazySelectionSceneObject {
    const suffix = indices.length > 0 ? `section-edges-${indices.join('-')}` : 'section-edges';
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = parent.getState('section-edges') as Edge[] || [];
        if (indices.length === 0) {
          return edges;
        }
        return indices.filter(i => i >= 0 && i < edges.length).map(i => edges[i]);
      }, this, indices);
  }

  internalFaces(...args: number[] | FaceFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('internal-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('internal-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.bucketOrigin().getState('internal-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  internalEdges(...args: number[] | EdgeFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('internal-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'internal-edges', 'internal-faces');
        return this.resolveEdges(edges, args, null, null, parent);
      }, this, args);
  }

  capFaces(...args: number[] | FaceFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('cap-faces', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const faces = parent.getState('cap-faces') as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.bucketOrigin().getState('cap-faces') as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  capEdges(...args: number[] | EdgeFilterBuilder[]): LazySelectionSceneObject {
    const suffix = this.buildSuffix('cap-edges', args);
    return new LazySelectionSceneObject(`${this.generateUniqueName(suffix)}`,
      (parent) => {
        const edges = this.getClassifiedEdges(parent, 'cap-edges', 'cap-faces');
        return this.resolveEdges(edges, args, null, null, parent);
      }, this, args);
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
    return ClassifiedBuckets.edgesOfFaces(faces);
  }

  /** Carry the classified buckets across a fusion — see {@link ClassifiedBuckets.remapAcrossFusion}. */
  protected remapClassifiedBuckets(history: ShapeHistory, finalShapes: Shape[]) {
    const replaced = ClassifiedBuckets.remapAcrossFusion(this, history, finalShapes);
    // The as-built bucket wrappers the remap replaced, and the history it
    // read through: whatever the state no longer reaches was this build's alone.
    disposeBuildTemporaries(this, [...replaced, ...ShapeHistoryTracker.shapesOf(history)]);
  }

  /** Record every face/edge of the given shapes as additions — see {@link ClassifiedBuckets.recordAdditions}. */
  protected recordShapeFacesAndEdgesAsAdditions(shapes: Shape[]) {
    ClassifiedBuckets.recordAdditions(this, shapes);
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
    fuseOpts?: { glue?: 'full' | 'shift'; skipSimplify?: boolean; validateResult?: boolean },
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

    const fusionResult = fuseWithSceneObjects(this.resolveFusionStock(context.getSceneObjects()), shapes, {
      ...fuseOpts,
      recordHistoryFor: this,
      profiler: p,
    });

    for (const modifiedShape of fusionResult.modifiedShapes) {
      if (!modifiedShape.object) {
        continue;
      }
      modifiedShape.object.removeShape(modifiedShape.shape, this, modifiedShape.successors);
    }

    this.addShapes(fusionResult.newShapes);

    if (fusionResult.toolHistory) {
      p.record('Remap classified buckets', () => this.remapClassifiedBuckets(fusionResult.toolHistory!, fusionResult.newShapes));
    } else {
      p.record('Classify edges', () => this.classifyExtrudeEdges());
    }

    // The fuse consumed the tool solids, and the remap replaced the as-built
    // bucket faces and read the tool history through: whatever the state no
    // longer reaches was this build's alone.
    p.record('Dispose build temporaries', () => disposeBuildTemporaries(this, [
      ...shapes,
      ...classified.startFaces, ...classified.endFaces, ...classified.sideFaces,
      ...classified.internalFaces, ...classified.capFaces,
      ...(fusionResult.toolHistory ? ShapeHistoryTracker.shapesOf(fusionResult.toolHistory) : []),
    ]));
  }

  /** Derive the edge buckets from the face buckets — see {@link ClassifiedBuckets.classifyEdges}. */
  protected classifyExtrudeEdges(remapped?: FusedEdgeBuckets) {
    ClassifiedBuckets.classifyEdges(this, remapped);
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
    originalShapes: Face[] = null,
    owner: SceneObject = this): T[] {
    if (args.length === 0) {
      return new ShapeFilter(ClassifiedBucketRemapper.distinct(shapes)).apply() as T[];
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
    return applyBucketFilters(shapes, filters, owner) as unknown as T[];
  }

  private resolveEdges<T extends Shape>(shapes: Edge[], args: number[] | EdgeFilterBuilder[],
    transform: Matrix4 = null,
    originalShapes: Edge[] = null,
    owner: SceneObject = this): T[] {
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
    return applyBucketFilters(shapes, filters, owner) as unknown as T[];
  }

  draft(value: NumberParam | [NumberParam, NumberParam]): this {
    if (Array.isArray(value)) {
      this._draft = [resolveParam(value[0]), resolveParam(value[1])];
    } else {
      this._draft = resolveParam(value);
    }
    return this;
  }

  endOffset(value: NumberParam): this {
    this._endOffset = resolveParam(value);
    return this;
  }

  drill(value: boolean = true): this {
    this._drill = value;
    return this;
  }

  thin(offset1: NumberParam, offset2?: NumberParam): this {
    const o1 = resolveParam(offset1);
    this._thin = offset2 !== undefined ? [o1, resolveParam(offset2)] : [o1];
    return this;
  }

  isThin(): boolean {
    return this._thin !== undefined;
  }

  getThinOffsets(): [number] | [number, number] | undefined {
    return this._thin;
  }

  protected serializePickFields() {
    const regions = this.getState('regions') as SerializedRegion[] | undefined;
    return {
      regionPicking: this.isRegionPicking() || undefined,
      regionNames: this.isRegionPicking() ? [...this._regionNames] : undefined,
      regions: this.isRegionPicking() ? regions ?? [] : undefined,
    };
  }

  /**
   * Restrict the operation to particular regions of the sketch, by the names
   * their `region()` declarations gave them inside the sketch callback. With
   * no arguments the operation makes nothing and lists every region.
   */
  region(...names: string[]): this {
    this._regionPicking = true;
    this._regionNames = names;
    return this;
  }

  isRegionPicking(): boolean {
    return this._regionPicking;
  }

  getRegionNames(): string[] {
    return this._regionNames;
  }

  /**
   * The regions of the source sketch. A primitive passed straight to the
   * operation (`extrude(10, c)`) reads the declarations of the sketch it
   * belongs to.
   */
  protected buildSourceRegions(plane: Plane): SketchRegion[] {
    return sourceRegionContext(this.extrudable, plane).regions;
  }

  /**
   * Resolves region mode: partitions the sketch into its regions, resolves
   * the named declarations against them, adds every region and its edges as
   * meta shapes for the pick overlay (selected ones marked), and returns the
   * faces to build. Returns null when the operation is not in region mode.
   * Names that do not resolve become the feature's error; what did resolve
   * still builds.
   */
  protected resolveRegionFaces(plane: Plane): Face[] | null {
    if (!this.isRegionPicking()) {
      return null;
    }
    if (!this._extrudable) {
      this.setError('region() needs a sketch source — a face-sourced operation has no sketch regions');
      return [];
    }

    const context = sourceRegionContext(this.extrudable, plane);
    const { regions, declarations, labels } = context;
    if (!context.sketch && this._regionNames.length > 0) {
      this.setError('region() needs a sketch source — the profile is not inside a sketch, so it declares no regions');
    }
    const requests = this._regionNames.map(name => ({ name }));
    const { selected, problems } = resolveRegions(requests, regions, declarations, labels);
    if (problems.length > 0) {
      this.setError(problems.join('\n'));
    }

    this.setState('regions', regions.map((region): SerializedRegion => ({
      key: region.key,
      index: region.index,
      name: declaredNameOf(declarations, region.items),
      selected: selected.includes(region),
    })));

    for (const region of regions) {
      const cell = region.face;
      const isSelected = selected.includes(region);
      cell.markAsMetaShape(isSelected ? 'pick-region-selected' : 'pick-region');
      cell.metaData = { key: region.key, index: region.index };
      this.addShape(cell);

      for (const edge of cell.getEdges()) {
        edge.markAsMetaShape('pick-edge');
        this.addShape(edge);
      }
    }

    return selected.map(region => region.face);
  }

  override clean(allObjects: SceneObject[]): void {
    if (!this.isRegionPicking()) {
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
    this._regionPicking = other._regionPicking;
    this._regionNames = other._regionNames;
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
        const midTol = mmTol(1e-4);
        if (inwardMids.some(mp => rfeMid.distanceTo(mp) < midTol)) {
          solidInwardEdges.push(rfe);
        } else if (outwardMids.some(mp => rfeMid.distanceTo(mp) < midTol)) {
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

    if (this._regionPicking !== other._regionPicking) {
      return false;
    }

    if (this._regionNames.length !== other._regionNames.length) {
      return false;
    }

    for (let i = 0; i < this._regionNames.length; i++) {
      if (this._regionNames[i] !== other._regionNames[i]) {
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
