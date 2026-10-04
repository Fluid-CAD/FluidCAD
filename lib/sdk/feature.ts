import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Plane } from "../math/plane.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { Matrix4 } from "../math/matrix4.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { cutWithSceneObjects, fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { ShapeHistory } from "../common/shape-history-tracker.js";
import { ClassifiedBucketRemapper, ClassifiedBuckets } from "../features/classified-buckets.js";
import { LazySelectionSceneObject } from "../features/lazy-scene-object.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { applyBucketFilters } from "../filters/bucket-scope.js";
import type { ISceneObject, ISelection } from "../core/interfaces.js";
import type { SceneParserContext } from "../index.js";
import { FeatureInputs, type FeatureValues } from "./feature-inputs.js";
import { FeatureCall } from "./call-shape.js";
import type { FeatureParams, ValuesOf } from "./feature-params.js";

/** What `buildTool()` and a modifier's `build()` are handed: the scene as it stands before the feature. */
export type FeatureBuildContext = BuildSceneObjectContext;

/**
 * The standard buckets a feature fills, by accessor name — what
 * `s.endFaces()`, `s.sideEdges(0)` and the editor's picks read back. Each is
 * optional; a bucket left out is empty.
 */
export type FeatureBuckets = {
  startFaces?: Face[];
  endFaces?: Face[];
  sideFaces?: Face[];
  internalFaces?: Face[];
  capFaces?: Face[];
  /** Left out, an edge bucket is derived from the faces: a start face's edges are start edges, and so on. */
  startEdges?: Edge[];
  endEdges?: Edge[];
  sideEdges?: Edge[];
  internalEdges?: Edge[];
  capEdges?: Edge[];
  /**
   * The plane a tool starts on, its normal pointing the way the tool grows.
   * A remove reads it to tell the rims of the cut apart — where the tool
   * enters the material are start edges, those at its far end end edges — as
   * `cut()` does from its sketch plane. Without it every rim is internal.
   */
  startPlane?: Plane;
};

/** A `Feature` subclass: the one constructor signature the framework calls. */
export type FeatureClass<V extends FeatureValues = FeatureValues> = (new (values: V) => Feature<V>) & { id: string };

/**
 * What `Feature.with(params)` returns: an abstract `Feature` whose values
 * are typed by `params`, which it carries as `static params`.
 */
export type FeatureWith<P extends FeatureParams> =
  (abstract new (values: ValuesOf<P>) => Feature<ValuesOf<P>>) & { readonly params: P };

type FaceBucketName = 'startFaces' | 'endFaces' | 'sideFaces' | 'internalFaces' | 'capFaces';
type EdgeBucketName = 'startEdges' | 'endEdges' | 'sideEdges' | 'internalEdges' | 'capEdges';
type FaceArgs = (number | FaceFilterBuilder)[];
type EdgeArgs = (number | EdgeFilterBuilder)[];

/**
 * The base of every custom feature: a class built from one object of named
 * values, and a builder that makes it (`registerBuilder`).
 *
 * The base derives what a scene object must get right from those values, so
 * a forgotten field can never leave the cache serving stale geometry: two
 * statements match when their values match (scalars by value, references by
 * their own `compareTo`), a feature depends on every reference it holds, and
 * a repeat's copy is the same class constructed from the same values.
 *
 * Two authoring styles:
 *
 * - **Tool.** Implement {@link buildTool}: return the solids the feature adds
 *   or removes, built where the references stand. The base applies the
 *   operation the statement chose — `.add()` (the default) fuses them into
 *   the solids in scope, `.new()` keeps them apart, `.remove()` cuts them,
 *   `.scope(...)` narrows the solids — records the history, and carries the
 *   buckets {@link setBuckets} named across the fusion. A repeat's copy is
 *   the tool moved, read from the same references.
 * - **Modifier.** Override `build(ctx)` and change the scene's solids
 *   directly, the way `fillet()` and `draft()` do. A repeat's copy is
 *   rebuilt from copies of the references.
 *
 * Subclasses declare `static id` (`'acme.standoff'`): the timeline type and
 * the cache's unique type. They declare no constructor of their own — the
 * framework constructs features from values alone. A subclass declares its
 * values by extending {@link Feature.with}, which types `this.values` from
 * them, and `defineFeature()` turns it into the builder a model calls.
 */
export abstract class Feature<V extends FeatureValues = FeatureValues> extends SceneObject {

  /** The feature's type: namespaced for custom features (`'acme.standoff'`). */
  static id: string;

  /** Each registered feature class's label, as its timeline row reads (see {@link getDisplayType}). */
  private static readonly labels = new WeakMap<Function, string>();

  /**
   * A base for a feature class that declares its values: the class extends
   * it, and `this.values` is typed from `params` — a length is a number, a
   * select one of its options' values, a face picker's value a selection.
   * The base carries `params` as `static params`, where `defineFeature()`
   * reads them.
   *
   * ```js
   * class Standoff extends Feature.with({
   *   face: { picker: 'face', surface: 'planar' },
   *   height: { type: 'length', default: 10, min: 0 },
   * }) {
   *   static id = 'acme.standoff';
   *   buildTool() {
   *     const { height } = this.values;   // a number
   *   }
   * }
   * ```
   *
   * Every evaluation of the module makes a new base and a new class; the
   * cache compares features by id, never by class, so that costs nothing.
   */
  static with<const P extends FeatureParams>(params: P): FeatureWith<P> {
    if (!FeatureCall.isPlainObject(params)) {
      throw new Error("Feature.with() takes the feature's values by name, such as { height: { type: 'length', default: 10 } }");
    }
    const frozen = Feature.frozenCopy(params);
    abstract class FeatureWithParams extends Feature {
      static readonly params = frozen;
    }
    return FeatureWithParams as unknown as FeatureWith<P>;
  }

  /**
   * @internal Name a feature class for the timeline: `registerBuilder` gives
   * the class its metadata's label.
   */
  static label(featureClass: Function, label: string): void {
    Feature.labels.set(featureClass, label);
  }

  private static readonly FACE_KEYS: [FaceBucketName, string][] = [
    ['startFaces', 'start-faces'], ['endFaces', 'end-faces'], ['sideFaces', 'side-faces'],
    ['internalFaces', 'internal-faces'], ['capFaces', 'cap-faces'],
  ];

  private static readonly EDGE_KEYS: [EdgeBucketName, string][] = [
    ['startEdges', 'start-edges'], ['endEdges', 'end-edges'], ['sideEdges', 'side-edges'],
    ['internalEdges', 'internal-edges'], ['capEdges', 'cap-edges'],
  ];

  private readonly inputs: FeatureInputs;

  /** The buckets declared so far in this build — see {@link setBuckets}. */
  private declared: FeatureBuckets = {};

  /** True while `buildTool()` runs: declared buckets wait for the base to place them. */
  private collectingTool = false;

  constructor(values: V) {
    super();
    this.inputs = FeatureInputs.from(Feature.idOf(this.constructor as typeof Feature), values);
  }

  /** The `static id` of a feature class, refusing a class without one. */
  static idOf(featureClass: { id?: unknown; name?: string }): string {
    const id = featureClass.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${featureClass.name || 'A Feature subclass'} needs a static id — the feature's type, such as 'acme.standoff'`);
    }
    return id;
  }

  /** The values the feature was constructed from, frozen. */
  get values(): Readonly<V> {
    return this.inputs.values as Readonly<V>;
  }

  /**
   * Tool style: the solids this feature adds or removes, built where the
   * references stand — a repeat moves them. Declare their buckets with
   * {@link setBuckets} before returning. Modifier-style features override
   * `build()` instead and leave this alone.
   */
  buildTool(_ctx: FeatureBuildContext): Shape[] {
    throw new Error(`${this.getType()}: implement buildTool(ctx) to return the feature's solids, or override build(ctx) for a feature that changes the scene's solids directly`);
  }

  /** Whether the feature is tool style: it leaves `build()` to the base. */
  isTool(): boolean {
    return this.build === Feature.prototype.build;
  }

  /**
   * Add the feature to the scene the builder runs in, after any reference
   * that is not there yet — an accessor written inline (`e.endFaces()`)
   * exists for this call alone, and must build before the feature reads it.
   * Returns the feature, for the builder to return.
   */
  addTo(context: SceneParserContext): this {
    for (const ref of this.inputs.references()) {
      if (ref.isLazy()) {
        for (const dep of ref.getDependencies()) {
          context.addSceneObject(dep);
        }
      }
      context.addSceneObject(ref);
    }
    context.addSceneObject(this);
    return this;
  }

  /** Every shape a reference holds now (its solids, its selected faces or edges, its sketch's wires). */
  protected shapesOf(ref: ISceneObject | ISceneObject[]): Shape[] {
    return Feature.referenceList(ref, this.getType()).flatMap(obj => obj.getShapes());
  }

  /** Every face a reference holds: a face selection's faces, a solid's faces. */
  protected facesOf(ref: ISceneObject | ISceneObject[]): Face[] {
    return this.shapesOf(ref).flatMap(shape => shape.getSubShapes('face')) as Face[];
  }

  /** Every edge a reference holds: an edge selection's edges, a face's or a solid's edges. */
  protected edgesOf(ref: ISceneObject | ISceneObject[]): Edge[] {
    return this.shapesOf(ref).flatMap(shape => shape.isEdge() ? [shape] : shape.getSubShapes('edge')) as Edge[];
  }

  /**
   * The axis an axis value stands for: an `axis()` statement's, a world
   * axis's (`'z'`), a picked edge's (`axis(<edge>)`) — where it stands now,
   * a repeat's copy included.
   */
  protected axisOf(ref: ISceneObject): Axis {
    if (!(ref instanceof AxisObjectBase)) {
      throw new Error(`${this.getType()}: ${Feature.describeReference(ref)} is not an axis — declare the value as an axis picker`);
    }
    return ref.getAxis();
  }

  /** The plane a plane value stands for: a `plane()` statement's, an origin plane's (`'xy'`), a picked face's. */
  protected planeOf(ref: ISceneObject): Plane {
    if (!(ref instanceof PlaneObjectBase)) {
      throw new Error(`${this.getType()}: ${Feature.describeReference(ref)} is not a plane — declare the value as a plane picker`);
    }
    return ref.getPlane();
  }

  private static describeReference(ref: ISceneObject): string {
    return ref instanceof SceneObject ? `a ${ref.getType()}` : 'the value';
  }

  /**
   * Name the feature's buckets. A tool names sub-shapes of the solids
   * `buildTool()` returns; the base moves them with a repeat's copy and
   * carries them across the fusion. A modifier names its final geometry.
   * Edge buckets left out are derived from the faces. Calls accumulate.
   *
   * A remove keeps none of the tool's faces: the cut classifies what it
   * made — its rims as start, end or internal edges (see
   * {@link FeatureBuckets.startPlane}), its walls as internal faces — as
   * `cut()` does.
   */
  protected setBuckets(buckets: FeatureBuckets): void {
    this.declared = { ...this.declared, ...buckets };
    if (!this.collectingTool) {
      this.applyBuckets(this.declared);
    }
  }

  build(context: FeatureBuildContext): void {
    const p = context.getProfiler();
    this.declared = {};
    this.collectingTool = true;
    let tools: Shape[];
    try {
      tools = p.record('Build tool', () => this.buildTool(context));
    } finally {
      this.collectingTool = false;
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error(`${this.getType()}: buildTool() returned no shapes`);
    }

    let buckets = this.declared;
    const transform = context.getTransform();
    if (transform) {
      ({ tools, buckets } = p.record('Move tool', () => Feature.moveTool(tools, buckets, transform)));
    }

    this.consumeReferences();

    if (this._operationMode === 'remove') {
      p.record('Cut', () => this.cutTool(tools, buckets, context));
    } else {
      p.record('Fuse', () => this.fuseTool(tools, buckets, context));
    }
  }

  /**
   * Take the references off the screen from this feature on, without taking
   * them from anything that reads them after: a face selection's highlight
   * goes, but the selection stays readable — a repeat's copies read it
   * again. Sketches, planes and axes go the same way, as they do for every
   * feature. A referenced feature or solid is read, never consumed, so it
   * stays.
   */
  protected consumeReferences(): void {
    for (const ref of this.inputs.references()) {
      if (ref.consumedForDisplayOnly()) {
        ref.removeShapes(this);
      } else if (ref.isLazy() || ref.isSelection()) {
        ref.removeShapesFromDisplay(this);
      }
    }
  }

  private fuseTool(tools: Shape[], buckets: FeatureBuckets, context: FeatureBuildContext): void {
    const stock = this.resolveFusionStock(context.getSceneObjects()).filter(held => held.holder !== this);
    if (stock.length === 0) {
      this.addShapes(tools);
      ClassifiedBuckets.recordAdditions(this, tools);
      this.applyBuckets(buckets);
      return;
    }

    const fusion = fuseWithSceneObjects(stock, tools, { recordHistoryFor: this, profiler: context.getProfiler() });
    for (const modified of fusion.modifiedShapes) {
      if (!modified.object) {
        continue;
      }
      modified.object.removeShape(modified.shape, this, modified.successors);
    }
    this.addShapes(fusion.newShapes);

    if (!fusion.toolHistory) {
      // The tools landed as they were: the buckets name the final shapes.
      this.applyBuckets(buckets);
      return;
    }
    this.carryBuckets(buckets, fusion.toolHistory, fusion.newShapes);
  }

  private cutTool(tools: Shape[], buckets: FeatureBuckets, context: FeatureBuildContext): void {
    const stock = this.resolveFusionStock(context.getSceneObjects()).filter(held => held.holder !== this);
    const plane = buckets.startPlane ?? null;
    // The cut classifies by the sign of its distance alone: a negative one
    // sweeps along the plane's normal, the way the tool grows.
    cutWithSceneObjects(stock, tools, plane, plane ? -1 : 0, this, { recordHistoryFor: this });
  }

  /** Write `buckets` to the state as they are, deriving the edge buckets they leave out. */
  private applyBuckets(buckets: FeatureBuckets): void {
    for (const [name, key] of Feature.FACE_KEYS) {
      this.setState(key, buckets[name] ?? []);
    }
    ClassifiedBuckets.classifyEdges(this);
    for (const [name, key] of Feature.EDGE_KEYS) {
      if (buckets[name]) {
        this.setState(key, buckets[name]);
      }
    }
  }

  /** Write the tool's `buckets` and carry them across the fusion `history` recorded. */
  private carryBuckets(buckets: FeatureBuckets, history: ShapeHistory, finalShapes: Shape[]): void {
    for (const [name, key] of Feature.FACE_KEYS) {
      this.setState(key, buckets[name] ?? []);
    }
    ClassifiedBuckets.remapAcrossFusion(this, history, finalShapes);

    const declaredEdges = Feature.EDGE_KEYS.filter(([name]) => buckets[name]);
    if (declaredEdges.length === 0) {
      return;
    }
    const remapper = new ClassifiedBucketRemapper(history, finalShapes);
    try {
      for (const [name, key] of declaredEdges) {
        this.setState(key, remapper.remapEdges(buckets[name]!));
      }
    } finally {
      remapper.dispose();
    }
  }

  /**
   * The tools moved by a repeat's clone transform, with every bucket member
   * swapped for its image and the start plane moved along.
   */
  private static moveTool(tools: Shape[], buckets: FeatureBuckets, matrix: Matrix4): { tools: Shape[]; buckets: FeatureBuckets } {
    const names = [...Feature.FACE_KEYS, ...Feature.EDGE_KEYS].map(([name]) => name);
    const members = names.flatMap(name => (buckets[name] ?? []) as Shape[]);
    const images = new Map<Shape, Shape>();
    const moved = tools.map(tool => {
      const tracked = ShapeOps.transformTracking(tool, matrix, members);
      tracked.images.forEach((image, i) => {
        if (image && !images.has(members[i])) {
          images.set(members[i], image);
        }
      });
      return tracked.shape;
    });

    const out: FeatureBuckets = {};
    for (const name of names) {
      const bucket = buckets[name] as Shape[] | undefined;
      if (bucket) {
        (out as Record<string, Shape[]>)[name] = bucket.map(member => images.get(member)).filter(image => image !== undefined);
      }
    }
    if (buckets.startPlane) {
      out.startPlane = buckets.startPlane.applyMatrix(matrix);
    }
    return { tools: moved, buckets: out };
  }

  /** The references a value holds, refusing anything that is not one. */
  private static referenceList(ref: ISceneObject | ISceneObject[], type: string): SceneObject[] {
    const list = Array.isArray(ref) ? ref : [ref];
    for (const entry of list) {
      if (!(entry instanceof SceneObject)) {
        throw new Error(`${type}: expected a scene object reference, got ${entry === null ? 'null' : typeof entry}`);
      }
    }
    return list as SceneObject[];
  }

  /** A deep copy of plain data, frozen: later changes to the author's object never reach the class. */
  private static frozenCopy<T>(value: T): T {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(entry => Feature.frozenCopy(entry))) as T;
    }
    if (FeatureCall.isPlainObject(value)) {
      return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Feature.frozenCopy(entry)]))) as T;
    }
    return value;
  }

  /** Every reference the feature holds, lists flattened. */
  override getDependencies(): SceneObject[] {
    return this.inputs.references();
  }

  /**
   * A tool reads its references where they stand and moves its own solids
   * (see build), so a repeat copies none of them — copying the face a
   * standoff stands on would copy the plate with it. A modifier is rebuilt
   * from its references, so they are copied.
   */
  override getCloneDependencies(): SceneObject[] {
    return this.isTool() ? [] : this.getDependencies();
  }

  /**
   * The same class constructed from the same values — a modifier's
   * references swapped for their copies, a tool's kept (see
   * getCloneDependencies) — with the operation the statement chose. The
   * clone machinery sets the copy's transform and clone source itself.
   */
  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const FeatureType = this.constructor as FeatureClass;
    const copy = new FeatureType(this.isTool() ? this.inputs.values : this.inputs.remapped(remap));
    copy._operationMode = this._operationMode;
    copy._fusionScope = this._fusionScope;
    copy._symmetric = this._symmetric;
    return copy;
  }

  /**
   * The base checks (operation, scope, transform), then the values. The type
   * is compared by id, never by class: a workspace module is evaluated anew
   * on every render, so the same feature arrives as a new class each time.
   */
  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Feature) || other.getType() !== this.getType()) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    return this.inputs.equals(other.inputs);
  }

  getType(): string {
    return Feature.idOf(this.constructor as typeof Feature);
  }

  /**
   * The label its metadata gives the feature ("Bolt circle"), or for a
   * feature no builder registered, its id's last segment capitalized:
   * `acme.standoff` reads as Standoff.
   */
  override getDisplayType(): string {
    const label = Feature.labels.get(this.constructor);
    if (label !== undefined) {
      return label;
    }
    const name = this.getType().split('.').pop()!;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  serialize() {
    return this.inputs.serialize();
  }

  /** The faces the feature starts from — the ones on the face or plane it grows from. */
  startFaces(...args: FaceArgs): ISelection {
    return this.faceSelection('start-faces', args);
  }

  /** The faces at the far end of the feature. */
  endFaces(...args: FaceArgs): ISelection {
    return this.faceSelection('end-faces', args);
  }

  /** The faces around the feature, between its start and its end. */
  sideFaces(...args: FaceArgs): ISelection {
    return this.faceSelection('side-faces', args);
  }

  /** The faces inside the feature: the walls of its holes, or a cut's walls. */
  internalFaces(...args: FaceArgs): ISelection {
    return this.faceSelection('internal-faces', args);
  }

  /** The faces closing an open feature off. */
  capFaces(...args: FaceArgs): ISelection {
    return this.faceSelection('cap-faces', args);
  }

  /** The edges of the start faces — where a fused feature meets the solid it grew from. */
  startEdges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('start-edges', args);
  }

  /** The edges of the end faces. */
  endEdges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('end-edges', args);
  }

  /** The side faces' edges that are neither start nor end edges. */
  sideEdges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('side-edges', args);
  }

  /** The edges of the internal faces. */
  internalEdges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('internal-edges', args);
  }

  /** The edges of the cap faces. */
  capEdges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('cap-edges', args);
  }

  /** Every edge a remove created: its rims and the creases between its walls. */
  edges(...args: EdgeArgs): ISelection {
    return this.edgeSelection('section-edges', args);
  }

  private faceSelection(key: string, args: FaceArgs): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(Feature.suffix(key, args)),
      (parent) => {
        const faces = parent.getState(key) as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform ? (this.getState(key) as Face[] || []) : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  private edgeSelection(key: string, args: EdgeArgs): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(Feature.suffix(key, args)),
      (parent) => {
        const edges = parent.getState(key) as Edge[] || [];
        const transform = parent.getTransform();
        const originalEdges = transform ? (this.getState(key) as Edge[] || []) : null;
        return this.resolveEdges(edges, args, transform, originalEdges, parent);
      }, this, args);
  }

  private static suffix(key: string, args: unknown[]): string {
    if (args.length === 0) {
      return key;
    }
    return `${key}-${args.map(a => typeof a === 'number' ? a : 'f').join('-')}`;
  }

  /**
   * Indices pick from the bucket (a copy's index follows the original's
   * member); filters run over the bucket with the feature's solids in scope.
   * A start or end face re-homed onto the solid it grew from may stand in a
   * bucket twice, so a bare read lists it once.
   */
  private resolveFaces(shapes: Face[], args: FaceArgs, transform: Matrix4 | null,
                       originalShapes: Face[] | null, owner: SceneObject): Face[] {
    if (args.length === 0) {
      return new ShapeFilter(ClassifiedBucketRemapper.distinct(shapes)).apply() as Face[];
    }
    if (args.every(a => typeof a === 'number')) {
      let filters = (args as number[]).map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Face[];
    }
    let filters = args.filter(a => a instanceof FaceFilterBuilder) as FaceFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as FaceFilterBuilder);
    }
    return applyBucketFilters(shapes, filters, owner) as Face[];
  }

  private resolveEdges(shapes: Edge[], args: EdgeArgs, transform: Matrix4 | null,
                       originalShapes: Edge[] | null, owner: SceneObject): Edge[] {
    if (args.length === 0) {
      return new ShapeFilter(shapes).apply() as Edge[];
    }
    if (args.every(a => typeof a === 'number')) {
      let filters = (args as number[]).map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
      if (transform) {
        filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
      }
      return new ShapeFilter(shapes, ...filters).apply() as Edge[];
    }
    let filters = args.filter(a => a instanceof EdgeFilterBuilder) as EdgeFilterBuilder[];
    if (transform) {
      filters = filters.map(f => f.transform(transform) as EdgeFilterBuilder);
    }
    return applyBucketFilters(shapes, filters, owner) as Edge[];
  }
}
