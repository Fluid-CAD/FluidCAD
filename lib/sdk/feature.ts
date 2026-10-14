import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Face } from "../common/face.js";
import { Edge } from "../common/edge.js";
import { Plane } from "../math/plane.js";
import { Axis } from "../math/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { AnchoredLazyVertex } from "../features/anchored-vertex.js";
import { Locations } from "../features/locations.js";
import { Matrix4 } from "../math/matrix4.js";
import { Point } from "../math/point.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { OccScope } from "../oc/occ-scope.js";
import { BuildScope } from "../common/build-scope.js";
import { SceneDisposal } from "../rendering/scene-disposal.js";
import { cutWithSceneObjects, fuseWithSceneObjects } from "../helpers/scene-helpers.js";
import { ShapeHistory } from "../common/shape-history-tracker.js";
import { ClassifiedBucketRemapper, ClassifiedBuckets, ToolImageCarrier, type NamedBucket } from "../features/classified-buckets.js";
import { LazySelectionSceneObject } from "../features/lazy-scene-object.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ShapeFilter } from "../filters/filter.js";
import { applyBucketFilters } from "../filters/bucket-scope.js";
import type { ISceneObject, ISelection } from "../core/interfaces.js";
import type { SceneParserContext } from "../index.js";
import { FeatureInputs, type FeatureValues } from "./feature-inputs.js";
import { FeatureCall, type FeatureOperation } from "./call-shape.js";
import type { FeatureParams, ValuesOf } from "./feature-params.js";
import { FeatureKey } from "./feature-key.js";
import { FeatureNamespaces } from "./feature-namespaces.js";
import {
  FeatureBucketSet, type BucketAccessors, type EdgeBucketName, type FaceBucketName, type FeatureBucketBrand,
  type FeatureBucketSpecs, type NamedBuckets,
} from "./feature-buckets.js";
import type { BucketDef, SubShapeKind } from "../common/bucket-defs.js";
import { getOC } from "../oc/init.js";
import type { TopAbs_ShapeEnum } from "ocjs-fluidcad";

/** What `buildTool()` and a modifier's `build()` are handed: the scene as it stands before the feature. */
export type FeatureBuildContext = BuildSceneObjectContext;

/**
 * The standard buckets a feature fills, by accessor name — what
 * `s.endFaces()`, `s.sideEdges(0)` and the editor's picks read back. Each is
 * optional; a bucket left out is empty. A feature names its own buckets
 * beside them once its class declares them (`Feature.with(params, { buckets })`).
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
 * What `Feature.with(params, { buckets })` returns: an abstract `Feature`
 * whose values are typed by `params`, which it carries as `static params`,
 * with one accessor method per custom bucket it declares (`tipFaces()`),
 * and `setBuckets()` taking those names too. It carries the declarations as
 * `static buckets`.
 */
export type FeatureWith<P extends FeatureParams, B extends FeatureBucketSpecs = {}> =
  (abstract new (values: ValuesOf<P>) => Feature<ValuesOf<P>, keyof B & string> & BucketAccessors<B> & FeatureBucketBrand<B>)
  & { readonly params: P; readonly buckets: B };

/** What `Feature.with(params, options)` takes after the values. */
export type FeatureWithOptions<B extends FeatureBucketSpecs = FeatureBucketSpecs> = {
  /**
   * The feature's named buckets, by accessor name — each ends in `Faces` or
   * `Edges`, which says what it holds: `{ tipFaces: {}, boreEdges: { label:
   * 'Bore Rims' } }`. A declaration holds only an optional `label`, the
   * words the editor's menus use; what a bucket holds is described in the
   * package's `docs/` pages. Each custom name becomes a method
   * (`g.tipFaces()`), filled with `setBuckets()`; a declared `tipEdges` left
   * out of `setBuckets()` is the edges of `tipFaces`. A standard name is
   * declared only to relabel it, and makes no method.
   */
  buckets?: B;
};

/** What `setBuckets()` keeps while a build collects them: the standard buckets and the custom ones, by name. */
type DeclaredBuckets = FeatureBuckets & { [name: string]: Shape[] | Plane | undefined };

/**
 * @internal What a feature class's metadata tells the class itself, once a
 * builder registered it: the label its timeline rows read, and the
 * operations its statements may choose, with the default one.
 */
export type FeatureRegistration = {
  label: string;
  operations: readonly FeatureOperation[];
  defaultOperation: FeatureOperation | null;
};

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
 *   operation the statement chose — `.add()` fuses them into the solids in
 *   scope, `.new()` keeps them apart, `.remove()` cuts them, `.scope(...)`
 *   narrows the solids — records the history, and carries the buckets
 *   {@link setBuckets} named across the fusion. A statement that chooses
 *   none applies the feature's default operation: `add` when its metadata
 *   offers it (or offers no operations), else the first it lists. A repeat's
 *   copy is the tool moved, read from the same references.
 * - **Modifier.** Override `build(ctx)` and change the scene's solids
 *   directly, the way `fillet()` and `draft()` do. A repeat's copy is
 *   rebuilt from copies of the references.
 *
 * Subclasses declare `static id` (`'standoff'`): the timeline type and the
 * cache's unique type — keyed by the package when an installed package
 * defines the class (`@acme/feature-tests:standoff`). They declare no constructor of their own — the
 * framework constructs features from values alone. A subclass declares its
 * values by extending {@link Feature.with}, which types `this.values` from
 * them, and `defineFeature()` turns it into the builder a model calls.
 */
export abstract class Feature<V extends FeatureValues = FeatureValues, N extends string = never> extends SceneObject {

  /** The feature's plain id (`'standoff'`); never one of the engine's own types (`SceneTypes`). */
  static id: string;

  /** What each registered feature class's metadata says of it (see {@link Feature.register}). */
  private static readonly registrations = new WeakMap<Function, FeatureRegistration>();

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
   *   static id = 'standoff';
   *   buildTool() {
   *     const { height } = this.values;   // a number
   *   }
   * }
   * ```
   *
   * The second argument declares the feature's named buckets
   * (see {@link FeatureWithOptions}): each custom name becomes an accessor
   * method on the base, read like `endFaces()`, and a name `setBuckets()`
   * fills. They are checked here, so a bad declaration fails where the
   * module loads.
   *
   * ```js
   * class Gear extends Feature.with({ … }, {
   *   buckets: {
   *     tipFaces: {},
   *     tipEdges: { label: 'Tooth Tips' },   // derived from tipFaces
   *   },
   * }) { … }
   * ```
   *
   * Every evaluation of the module makes a new base and a new class; the
   * cache compares features by id, never by class, so that costs nothing.
   */
  static with<const P extends FeatureParams, const B extends FeatureBucketSpecs = {}>(params: P, options?: FeatureWithOptions<B>): FeatureWith<P, B> {
    if (!FeatureCall.isPlainObject(params)) {
      throw new Error("Feature.with() takes the feature's values by name, such as { height: { type: 'length', default: 10 } }");
    }
    const buckets = Feature.bucketsOption(options);
    const frozen = Feature.frozenCopy(params);
    abstract class FeatureWithParams extends Feature {
      static readonly params = frozen;
      static readonly buckets = buckets;
    }
    FeatureBucketSet.of(FeatureWithParams, 'Feature.with()');
    return FeatureWithParams as unknown as FeatureWith<P, B>;
  }

  /** The buckets `Feature.with()`'s options declare, frozen — none when left out — refusing any other option. */
  private static bucketsOption(options: unknown): FeatureBucketSpecs {
    if (options === undefined) {
      return Object.freeze({});
    }
    if (!FeatureCall.isPlainObject(options)) {
      throw new Error("Feature.with(): the second argument holds the feature's options, such as { buckets: { tipFaces: {} } }");
    }
    for (const option of Object.keys(options)) {
      if (option !== 'buckets') {
        throw new Error(`Feature.with(): unknown option '${option}' — the options are: buckets`);
      }
    }
    return options.buckets === undefined ? Object.freeze({}) : Feature.frozenCopy(options.buckets) as FeatureBucketSpecs;
  }

  /**
   * @internal Tell a feature class what its metadata says of it:
   * `registerBuilder` gives the class its label, which its timeline rows
   * read, and its operations — a statement without an operation chain
   * applies the default one, and one that chooses an operation the feature
   * doesn't offer fails to build. The class's bucket declarations are
   * checked here too — a plain subclass declares them as `static buckets`.
   */
  static register(featureClass: Function, registration: FeatureRegistration): void {
    FeatureBucketSet.of(featureClass);
    Feature.registrations.set(featureClass, Object.freeze({ ...registration, operations: Object.freeze([...registration.operations]) }));
  }

  private static readonly FACE_KEYS: readonly (readonly [FaceBucketName, string])[] = FeatureBucketSet.STANDARD_FACES;

  private static readonly EDGE_KEYS: readonly (readonly [EdgeBucketName, string])[] = FeatureBucketSet.STANDARD_EDGES;

  private readonly inputs: FeatureInputs;

  /** The buckets declared so far in this build — see {@link setBuckets}. */
  private declared: DeclaredBuckets = {};

  /** True while `buildTool()` runs: declared buckets wait for the base to place them. */
  private collectingTool = false;

  /** The operation the statement's last operation chain chose, or null when it left it to the default. */
  private chosenOperation: FeatureOperation | null = null;

  constructor(values: V) {
    super();
    this.inputs = FeatureInputs.from(Feature.idOf(this.constructor as typeof Feature), values);
    // A class constructed without a builder (the plain-subclass style, a
    // test) gets its bucket accessors here, its declarations checked.
    FeatureBucketSet.of(this.constructor);
    // A statement without an operation chain applies the feature's default,
    // as hole() cuts without a .remove(). A class no builder registered adds.
    const operation = Feature.registrations.get(this.constructor)?.defaultOperation ?? null;
    if (operation !== null) {
      this._operationMode = operation;
      this._fusionScope = operation === 'new' ? 'none' : 'all';
    }
  }

  /**
   * The feature's type: its class's catalog key — the plain id it declares
   * (`standoff`), or for a class an installed package defines, the package
   * and that id (`@acme/feature-tests:standoff`, see `FeatureNamespaces`).
   * Refuses a class without a `static id`.
   */
  static idOf(featureClass: { id?: unknown; name?: string }): string {
    return FeatureNamespaces.keyOf(featureClass, Feature.plainIdOf(featureClass));
  }

  /** The `static id` a feature class declares (`standoff`), refusing a class without one. */
  static plainIdOf(featureClass: { id?: unknown; name?: string }): string {
    const id = featureClass.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${featureClass.name || 'A Feature subclass'} needs a static id — the feature's type, such as 'standoff'`);
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
   * What the dialog's preview (its "ghost") draws while the values are being
   * typed, built from the values alone — the scene is never changed. A tool
   * draws the solids {@link buildTool} returns, which the dialog colours by
   * the operation: green for what an add or a new adds, red for what a remove
   * cuts. A modifier draws nothing unless it overrides this to return the
   * shapes its preview shows; returning null means no preview.
   *
   * The preview frees every shape returned here once it is drawn — except
   * one the scene itself holds — so return shapes built here.
   */
  ghost(ctx: FeatureBuildContext): Shape[] | null {
    if (!this.isTool()) {
      return null;
    }
    this.collectingTool = true;
    let shapes: Shape[];
    try {
      shapes = this.buildTool(ctx);
    } finally {
      this.collectingTool = false;
    }
    // The build's own refusal, so the dialog says what the row will.
    if (Array.isArray(shapes) && shapes.length > 0) {
      this.refuseStrayMembers(shapes);
    }
    return shapes;
  }

  /**
   * @internal The preview's shapes ({@link ghost}), and every shape its build
   * declared in a bucket on the way: all of them the preview's to free, as
   * nothing keeps them. Null when the feature draws no preview.
   */
  buildPreview(ctx: FeatureBuildContext): { shapes: Shape[]; scratch: Shape[] } | null {
    this.declared = {};
    try {
      const shapes = BuildScope.run(this, ctx, () => this.ghost(ctx));
      if (shapes === null || shapes === undefined) {
        return null;
      }
      if (!Array.isArray(shapes)) {
        throw new Error(`${this.getType()}: ghost() returns the shapes to draw, or null for no preview`);
      }
      return { shapes, scratch: this.declaredMembers() };
    } finally {
      this.declared = {};
    }
  }

  /**
   * Whether a feature class has a preview to draw: a tool always does, a
   * modifier when it overrides {@link ghost}.
   */
  static previews(featureClass: Function): boolean {
    const prototype = featureClass.prototype as Feature;
    return prototype.build === Feature.prototype.build || prototype.ghost !== Feature.prototype.ghost;
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

  /**
   * Run raw OpenCascade code (`fluidcad/sdk/occt`) in a scope that frees
   * what it makes: every object constructed through `scope.oc`, and what
   * `scope.track()` hands it, is released when `fn` returns or throws —
   * except what `fn` returns or `scope.keep()`s, and never a shape the
   * scene holds. Use it inside `buildTool()`, `build()` and `ghost()`:
   *
   * ```js
   * buildTool() {
   *   return this.occ(({ oc, track }) => {
   *     const maker = new oc.BRepPrimAPI_MakeCylinder(2, 10);   // freed with the scope
   *     return [ShapeFactory.fromShape(track(maker.Shape()))];  // the wrapper is returned, so kept
   *   });
   * }
   * ```
   *
   * The binding can't free every internal allocation even so — its
   * `delete()` skips C++ destructors — see `fluidcad/sdk/occt`.
   */
  protected occ<T>(fn: (scope: OccScope) => T): T {
    return OccScope.run(fn, { survivors: () => this.heldShapes() });
  }

  /**
   * Every shape the scene holds that this build could reach: the scene
   * objects its build context sees, the feature's own, and its references
   * with everything they depend on.
   */
  private heldShapes(): Set<Shape> {
    return SceneDisposal.collectShapes(this.heldObjects());
  }

  /** The objects whose shapes {@link heldShapes} collects. */
  private heldObjects(): SceneObject[] {
    const objects = new Set<SceneObject>(BuildScope.contextOf(this)?.getSceneObjects() ?? []);
    objects.add(this);
    const pending: SceneObject[] = [...this.inputs.references()];
    while (pending.length > 0) {
      const ref = pending.pop()!;
      if (!objects.has(ref)) {
        objects.add(ref);
        pending.push(...ref.getDependencies());
      }
    }
    return [...objects];
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
   * axis's (`'z'`), a picked edge's (`axis(<edge>)`), a connector's — its Z
   * axis through its origin (`bolt`, `bolt.instance(2)`) — where it stands
   * now, a repeat's copy included.
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

  /**
   * The frame a location value stands on, where it stands now — a repeat's
   * copy moves the tool the feature builds there, not the location: its
   * origin is the location, its Z points out of the material. A connector
   * gives its own frame; an anchor its face's normal (`e.endFaces().center()`),
   * its circle's axis or its edge's tangent; a sketch point its sketch's
   * plane; a vertex named by an edge's end (`e.endEdges(0).start()`) that
   * edge's tangent there.
   */
  protected frameOf(ref: ISceneObject): Plane {
    if (Locations.kindsOf(ref).length === 0) {
      throw new Error(`${this.getType()}: ${Feature.describeReference(ref)} is not a location — declare the value as a connector, point or anchor picker`);
    }
    return Locations.frameOf(ref);
  }

  /**
   * Whether a value's element is a location — a connector, a point, an
   * anchor — which {@link frameOf} reads; a value of several kinds
   * (`['solid', 'connector']`) tells its elements apart by it.
   */
  protected isLocation(ref: ISceneObject): boolean {
    return Locations.kindsOf(ref).length > 0;
  }

  /** The world position a location value names: a connector's origin, a point, an anchor. */
  protected pointOf(ref: ISceneObject): Point {
    if (Locations.kindsOf(ref).length === 0) {
      throw new Error(`${this.getType()}: ${Feature.describeReference(ref)} is not a location — declare the value as a connector, point or anchor picker`);
    }
    return Locations.pointOf(ref);
  }

  private static describeReference(ref: ISceneObject): string {
    return ref instanceof SceneObject ? `a ${ref.getType()}` : 'the value';
  }

  /**
   * Name the feature's buckets: the standard ones, and those its class
   * declares (`Feature.with(params, { buckets })`). A tool names sub-shapes
   * of the solids `buildTool()` returns; the base moves them with a repeat's
   * copy and carries them across the fusion — a custom bucket keeps what the
   * final solid still carries of it. A modifier names its final geometry.
   * Standard edge buckets left out are derived from the faces, and so is a
   * declared `xEdges` left out, from `xFaces`. Calls accumulate.
   *
   * What it can't keep is refused as the feature's build error: a name that
   * is no bucket of the feature, a value that is not a list, a member of the
   * wrong kind, and — for a tool — a member that is no face or edge of the
   * solids it returned.
   *
   * A remove's standard buckets are what its cut made, classified as
   * `cut()` classifies them — its rims as start, end or internal edges (see
   * {@link FeatureBuckets.startPlane}), its walls as internal faces — and
   * the standard members named are not kept. Its custom buckets follow the
   * cut: each member becomes what the cut left of it, so a pocket's
   * `floorFaces` is the pocket floor, faced out of the material; a member
   * the cut removed entirely (a floor it went right through) is dropped.
   */
  protected setBuckets(buckets: FeatureBuckets & NamedBuckets<N>): void {
    this.bucketSet().checkFilled(buckets, this.getType(), FeatureKey.calleeOf(this.getType()));
    this.declared = { ...this.declared, ...buckets };
    if (!this.collectingTool) {
      this.applyBuckets(this.declared);
    }
  }

  build(context: FeatureBuildContext): void {
    const refusal = this.operationRefusal();
    if (refusal) {
      throw new Error(refusal);
    }
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
    this.refuseStrayMembers(tools);

    let buckets = this.declared;
    const transform = context.getTransform();
    if (transform) {
      ({ tools, buckets } = p.record('Move tool', () => Feature.moveTool(tools, buckets, transform, this.bucketNames())));
    }

    this.consumeReferences();

    if (this._operationMode === 'remove') {
      p.record('Cut', () => this.cutTool(tools, buckets, context));
    } else {
      p.record('Fuse', () => this.fuseTool(tools, buckets, context));
    }
  }

  override add(): this {
    this.chosenOperation = 'add';
    return super.add();
  }

  override new(): this {
    this.chosenOperation = 'new';
    return super.new();
  }

  override remove(): this {
    this.chosenOperation = 'remove';
    return super.remove();
  }

  /**
   * Why the operation the statement chose can't build, or null: a feature
   * whose metadata lists its operations builds only those. A statement that
   * chose none applies the default, and a feature that lists none (or that
   * no builder registered) takes any.
   */
  private operationRefusal(): string | null {
    const registration = Feature.registrations.get(this.constructor);
    const chosen = this.chosenOperation;
    if (!registration || chosen === null || registration.operations.length === 0 || registration.operations.includes(chosen)) {
      return null;
    }
    const callee = FeatureKey.calleeOf(this.getType());
    return `${callee}(): .${chosen}() is not an operation this feature offers — it offers ${FeatureCall.listed(registration.operations)}; `
      + `'${registration.defaultOperation}' is its default and needs no chain`;
  }

  /**
   * Take the references off the screen from this feature on, without taking
   * them from anything that reads them after: a face selection's highlight
   * goes, but the selection stays readable — a repeat's copies read it
   * again. Sketches, planes and axes go the same way, as they do for every
   * feature, and so do the selection an anchor stands on and the sketch a
   * point is drawn in. A referenced feature, solid or connector is read,
   * never consumed, so it stays.
   */
  protected consumeReferences(): void {
    for (const ref of this.inputs.references()) {
      Feature.hideForDisplay(ref, this);
      if (ref instanceof AnchoredLazyVertex) {
        // The selection an anchor stands on only located it: its highlight goes too.
        Feature.hideForDisplay(ref.getSourceSelection(), this);
      }
      // A sketch a point stands in leaves the screen, as a hole's does.
      Locations.sketchOf(ref)?.removeShapes(this);
    }
  }

  /** Take one reference off the screen from `consumer` on, leaving it readable. */
  private static hideForDisplay(ref: SceneObject, consumer: SceneObject): void {
    if (ref.consumedForDisplayOnly()) {
      ref.removeShapes(consumer);
    } else if (ref.isLazy() || ref.isSelection()) {
      ref.removeShapesFromDisplay(consumer);
    }
  }

  private fuseTool(tools: Shape[], buckets: DeclaredBuckets, context: FeatureBuildContext): void {
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

  /**
   * Cut the tools out of the solids in scope. The cut classifies what it
   * made into the standard buckets, from the start plane alone; the custom
   * buckets follow the tool's members through it — each becomes what the
   * cut left of it — and a declared edge bucket left out is the edges of
   * its face sibling as it ended up.
   */
  private cutTool(tools: Shape[], buckets: DeclaredBuckets, context: FeatureBuildContext): void {
    const stock = this.resolveFusionStock(context.getSceneObjects()).filter(held => held.holder !== this);
    const plane = buckets.startPlane ?? null;
    const named = this.namedBuckets(buckets);
    // The cut classifies by the sign of its distance alone: a negative one
    // sweeps along the plane's normal, the way the tool grows. It follows
    // the custom members only — a feature that names none tracks nothing.
    const cut = cutWithSceneObjects(stock, tools, plane, plane ? -1 : 0, this, {
      recordHistoryFor: this,
      trackTool: named.flatMap(bucket => bucket.members ?? []),
    });
    ClassifiedBuckets.writeNamed(this, named, new ToolImageCarrier(cut.toolImages));
  }

  /** Write `buckets` to the state as they are, deriving the edge buckets they leave out. */
  private applyBuckets(buckets: DeclaredBuckets): void {
    for (const [name, key] of Feature.FACE_KEYS) {
      this.setState(key, buckets[name] ?? []);
    }
    ClassifiedBuckets.classifyEdges(this);
    for (const [name, key] of Feature.EDGE_KEYS) {
      if (buckets[name]) {
        this.setState(key, buckets[name]);
      }
    }
    ClassifiedBuckets.writeNamed(this, this.namedBuckets(buckets), null);
  }

  /** Write the tool's `buckets` and carry them across the fusion `history` recorded. */
  private carryBuckets(buckets: DeclaredBuckets, history: ShapeHistory, finalShapes: Shape[]): void {
    for (const [name, key] of Feature.FACE_KEYS) {
      this.setState(key, buckets[name] ?? []);
    }
    ClassifiedBuckets.remapAcrossFusion(this, history, finalShapes);

    const declaredEdges = Feature.EDGE_KEYS.filter(([name]) => buckets[name]);
    const named = this.namedBuckets(buckets);
    if (declaredEdges.length === 0 && named.length === 0) {
      return;
    }
    const remapper = new ClassifiedBucketRemapper(history, finalShapes);
    try {
      for (const [name, key] of declaredEdges) {
        this.setState(key, remapper.remapEdges(buckets[name]!));
      }
      ClassifiedBuckets.writeNamed(this, named, remapper);
    } finally {
      remapper.dispose();
    }
  }

  /** This feature's declared buckets (see {@link FeatureBucketSet}). */
  private bucketSet(): FeatureBucketSet {
    return FeatureBucketSet.of(this.constructor);
  }

  /** Every bucket the feature may name, by accessor: the standard ones, then its class's custom ones. */
  private bucketNames(): string[] {
    return [...Feature.FACE_KEYS, ...Feature.EDGE_KEYS].map(([name]) => name as string).concat(this.bucketSet().customNames());
  }

  /** Every member the build named so far, in {@link bucketNames} order. */
  private declaredMembers(): Shape[] {
    return this.bucketNames().flatMap(name => (this.declared[name] ?? []) as Shape[]);
  }

  /** The class's custom buckets with what `buckets` names of them, as `ClassifiedBuckets.writeNamed` writes them. */
  private namedBuckets(buckets: DeclaredBuckets): NamedBucket[] {
    return this.bucketSet().defs().map(def => ({
      key: def.key,
      kind: def.kind,
      members: buckets[def.accessor] as Shape[] | undefined,
      deriveFrom: def.deriveFromFaceKey,
    }));
  }

  /**
   * Refuse a tool's member that is no face or edge of the solids
   * `buildTool()` returned (CB6): the base moves and fuses those solids, and
   * a member of any other shape would be lost on the way, silently. What the
   * build made is freed first — never a shape the scene holds.
   */
  private refuseStrayMembers(tools: Shape[]): void {
    const oc = getOC();
    const held = new oc.TopTools_IndexedMapOfShape();
    let refusal: string | null = null;
    try {
      for (const tool of tools) {
        oc.TopExp.MapShapes(tool.getShape(), oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum, held);
        oc.TopExp.MapShapes(tool.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, held);
      }
      for (const name of this.bucketNames()) {
        const at = ((this.declared[name] ?? []) as Shape[]).findIndex(member => held.FindIndex(member.getShape()) === 0);
        if (at >= 0) {
          const kind = FeatureBucketSet.kindOf(name);
          refusal = `${this.getType()}: setBuckets() ${name}[${at}] is not ${kind === 'face' ? 'a face' : 'an edge'} `
            + `of the solids buildTool() returned — name ${kind}s of the shapes you return`;
          break;
        }
      }
    } finally {
      held.delete();
    }
    if (refusal) {
      SceneDisposal.releaseDetached([...tools, ...this.declaredMembers()], this.heldObjects());
      throw new Error(refusal);
    }
  }

  /**
   * The tools moved by a repeat's clone transform, with every bucket member
   * — each of `names` — swapped for its image and the start plane moved along.
   */
  private static moveTool(tools: Shape[], buckets: DeclaredBuckets, matrix: Matrix4, names: string[]): { tools: Shape[]; buckets: DeclaredBuckets } {
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

    const out: DeclaredBuckets = {};
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
    copy.chosenOperation = this.chosenOperation;
    return copy;
  }

  /**
   * The base checks (operation, scope, transform), then the values. The type
   * is compared by id, never by class: a workspace module is evaluated anew
   * on every render, so the same feature arrives as a new class each time.
   * An operation the metadata stopped (or started) offering is a change too,
   * though the statement reads the same.
   */
  override compareTo(other: SceneObject): boolean {
    if (!(other instanceof Feature) || other.getType() !== this.getType()) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.operationRefusal() !== other.operationRefusal()) {
      return false;
    }
    return this.inputs.equals(other.inputs);
  }

  getType(): string {
    return Feature.idOf(this.constructor as typeof Feature);
  }

  /**
   * The label its metadata gives the feature ("Bolt circle"), or for a
   * feature no builder registered, its plain id's last segment capitalized:
   * `standoff` reads as Standoff.
   */
  override getDisplayType(): string {
    const label = Feature.registrations.get(this.constructor)?.label;
    if (label !== undefined) {
      return label;
    }
    const name = FeatureKey.calleeOf(this.getType());
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  serialize() {
    return this.inputs.serialize();
  }

  /**
   * The buckets the editor addresses the feature through: its class's custom
   * buckets first, in declaration order — the author named them on purpose —
   * then the standard ones in their usual order, a declared label on any.
   */
  override bucketDefs(kind: SubShapeKind): BucketDef[] {
    const set = this.bucketSet();
    const standard = super.bucketDefs(kind).map(def => (set.has(def.accessor) ? { ...def, label: set.labelOf(def.accessor) } : def));
    return [...set.defs(kind), ...standard];
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
        const originalFaces = transform ? (this.bucketOrigin().getState(key) as Face[] || []) : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  private edgeSelection(key: string, args: EdgeArgs): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(Feature.suffix(key, args)),
      (parent) => {
        const edges = parent.getState(key) as Edge[] || [];
        const transform = parent.getTransform();
        const originalEdges = transform ? (this.bucketOrigin().getState(key) as Edge[] || []) : null;
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
