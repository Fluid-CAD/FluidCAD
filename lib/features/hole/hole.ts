import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Vector3d } from "../../math/vector3d.js";
import { Matrix4 } from "../../math/matrix4.js";
import { FaceFilterBuilder } from "../../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../../filters/edge/edge-filter.js";
import { ShapeFilter } from "../../filters/filter.js";
import { applyBucketFilters } from "../../filters/bucket-scope.js";
import { IHole, ISceneObject, ISelection } from "../../core/interfaces.js";
import { cutWithSceneObjects } from "../../helpers/scene-helpers.js";
import { throughAllLength } from "../../helpers/through-all.js";
import { heldSolidsOf, liveSolidsFrom, type HeldSolid } from "../../helpers/live-solids.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { AnchoredLazyVertex } from "../anchored-vertex.js";
import { SketchPointVertex } from "../sketch-point-ref.js";
import { SolvedPoint } from "../2d/solved/point.js";
import type { Sketch } from "../2d/sketch.js";
import { Connector } from "../connector.js";
import { PointResolver } from "../point-resolver.js";
import { buildOrthonormalFrame } from "../shape-anchor.js";
import type { FastenerFit } from "./fastener-tables.js";
import {
  buildHoleTool,
  fastenedAxis,
  resolveHoleDimensions,
  type HoleDimensions,
  type HoleFastenerSpec,
  type HoleSpec,
  type HoleStyleSpec,
} from "./hole-profile.js";

/** The objects a hole can be placed at. */
export type HolePlacement = Connector | LazyVertex | SolvedPoint;

export function isHolePlacement(value: unknown): value is HolePlacement {
  return value instanceof Connector || value instanceof LazyVertex || value instanceof SolvedPoint;
}

const DIMENSIONS_STATE_KEY = 'hole-dimensions';
const FRAMES_STATE_KEY = 'hole-frames';
const FASTEN_DIMENSIONS_STATE_KEY = 'hole-fasten-dimensions';

/** The classification buckets a cut leaves on its caller — a fastened hole joins its two cuts' buckets. */
const CUT_STATE_KEYS = ['section-edges', 'start-edges', 'end-edges', 'internal-edges', 'internal-faces'];

/**
 * `.fasten([pitch[, depth[, tipAngle]]])`: the tapped hole cut into the next
 * solid along the hole axis, past the ones the clearance hole cuts.
 */
export interface HoleFastenSpec {
  /** The thread pitch (mm) or threads per inch; null is the coarse pitch. */
  pitch: number | null;
  /** Blind depth from the face the hole enters the solid through; null is through all. */
  depth: number | null;
  /** Drill point included angle below a blind depth; null is a flat bottom. */
  tipAngle: number | null;
}

/**
 * The frame a placement stands on: origin on the surface, normal pointing
 * out of the material (a connector's Z, a face normal, a sketch plane's
 * normal). The hole runs opposite the normal.
 */
export function placementFrame(placement: HolePlacement): Plane {
  if (placement instanceof Connector) {
    return placement.getFrame();
  }
  if (placement instanceof AnchoredLazyVertex) {
    return placement.getAnchorFrame();
  }
  const ref = placement instanceof SolvedPoint ? placement.start() : placement;
  if (ref instanceof SketchPointVertex) {
    const plane = ref.getPlane();
    if (!plane) {
      throw new Error("hole(): the sketch point has no built sketch plane");
    }
    return new Plane(PointResolver.toWorld(ref), plane.xDirection, plane.normal);
  }
  return buildOrthonormalFrame(PointResolver.toWorld(ref), Vector3d.unitZ(), {});
}

/** The sketch a placement's point is drawn in; null for a connector, an anchor or a free point. */
function placementSketch(placement: HolePlacement): Sketch | null {
  const ref = placement instanceof SolvedPoint ? placement.start() : placement;
  return ref instanceof SketchPointVertex ? ref.getSketch() : null;
}

/**
 * A fastener hole cut into the scope solids at one or more placements. The
 * geometry is one revolved tool per placement (countersink or counterbore,
 * bore, drill point), removed in a single cut with kernel history so the
 * rims and walls classify like a `cut()`.
 */
export class Hole extends SceneObject implements IHole {
  private _fastener: HoleFastenerSpec | null = null;
  private _style: HoleStyleSpec | null = null;
  private _depth: number | null = null;
  private _tipAngle: number | null = null;
  private _fasten: HoleFastenSpec | null = null;

  constructor(
    readonly size: number | string,
    readonly placements: HolePlacement[],
  ) {
    super();
    this._operationMode = 'remove';
  }

  clearance(fit: FastenerFit = 'normal'): this {
    if (fit !== 'close' && fit !== 'normal' && fit !== 'loose') {
      throw new Error(`hole(): .clearance() takes 'close', 'normal' or 'loose' (got ${String(fit)})`);
    }
    this._fastener = { type: 'clearance', fit };
    return this;
  }

  tapped(pitch: number | null = null): this {
    if (pitch !== null && (typeof pitch !== 'number' || !Number.isFinite(pitch) || pitch <= 0)) {
      throw new Error(`hole(): .tapped() takes the thread pitch (mm) or threads per inch (got ${String(pitch)})`);
    }
    this._fastener = { type: 'tapped', pitch };
    return this;
  }

  counterbore(diameter: number | null = null, depth: number | null = null): this {
    this._style = { kind: 'counterbore', diameter, depth };
    return this;
  }

  countersink(diameter: number | null = null, angle: number | null = null): this {
    this._style = { kind: 'countersink', diameter, angle };
    return this;
  }

  depth(distance: number, tipAngle: number | null = null): this {
    this._depth = distance;
    this._tipAngle = tipAngle;
    return this;
  }

  fasten(pitch: number | 'coarse' | null = null, depth: number | null = null, tipAngle: number | null = null): this {
    if ((pitch as unknown) instanceof SceneObject) {
      throw new Error("hole(): .fasten() takes no solid — the tapped hole goes into the next solid along the hole axis; pass the pitch, depth and tip angle only");
    }
    // 'coarse' (or null) holds the pitch slot for a depth: the size's coarse pitch.
    const threadPitch = pitch === 'coarse' ? null : pitch;
    if (threadPitch !== null && (typeof threadPitch !== 'number' || !Number.isFinite(threadPitch) || threadPitch <= 0)) {
      throw new Error(`hole(): .fasten() takes the thread pitch (mm), threads per inch or 'coarse' (got ${String(pitch)})`);
    }
    if (depth !== null && (typeof depth !== 'number' || !Number.isFinite(depth) || depth <= 0)) {
      throw new Error(`hole(): .fasten() takes a positive blind depth after the pitch (got ${String(depth)})`);
    }
    if (tipAngle !== null && depth === null) {
      throw new Error("hole(): .fasten() takes a tip angle only with a blind depth — a through tapped hole has no drill point");
    }
    this._fasten = { pitch: threadPitch, depth, tipAngle };
    return this;
  }

  get fastener(): HoleFastenerSpec | null {
    return this._fastener;
  }

  get style(): HoleStyleSpec | null {
    return this._style;
  }

  get blindDepth(): number | null {
    return this._depth;
  }

  get tipAngle(): number | null {
    return this._tipAngle;
  }

  get fastenSpec(): HoleFastenSpec | null {
    return this._fasten;
  }

  /**
   * The tapped hole `.fasten()` cuts into the mating solid: the statement's
   * size at its tap drill, through all or to its blind depth. Null without
   * the chain.
   */
  private fastenDimensions(): HoleDimensions | null {
    if (!this._fasten) {
      return null;
    }
    if (typeof this.size !== 'string') {
      throw new Error("hole(): .fasten() needs a fastener size such as 'M6' — the mating hole is tapped for that fastener");
    }
    if (this._fastener?.type === 'tapped') {
      throw new Error("hole(): .fasten() goes with a clearance hole — the tapped hole is the one it cuts into the mating solid");
    }
    return resolveHoleDimensions({
      size: this.size,
      fastener: { type: 'tapped', pitch: this._fasten.pitch },
      style: null,
      depth: this._fasten.depth,
      tipAngle: this._fasten.tipAngle,
    }, this.getUnit());
  }

  /** The statement's options as the profile resolver reads them. */
  spec(): HoleSpec {
    return { size: this.size, fastener: this._fastener, style: this._style, depth: this._depth, tipAngle: this._tipAngle };
  }

  /** The resolved numbers the last build cut with (the file's unit). */
  getDimensions(): HoleDimensions | null {
    return (this.getState(DIMENSIONS_STATE_KEY) as HoleDimensions | undefined) ?? null;
  }

  /** The resolved numbers of the tapped hole the last build cut into the `.fasten()` solid. */
  getFastenDimensions(): HoleDimensions | null {
    return (this.getState(FASTEN_DIMENSIONS_STATE_KEY) as HoleDimensions | undefined) ?? null;
  }

  /** The placement frames the last build cut at, after the clone transform. */
  getFrames(): Plane[] {
    return (this.getState(FRAMES_STATE_KEY) as Plane[] | undefined) ?? [];
  }

  override validate() {
    if (this.placements.length === 0) {
      throw new Error("hole() needs at least one placement — a connector, a sketch point such as s.geometries.c.center(), or a face/edge anchor such as e.endFaces().center()");
    }
    for (const placement of this.placements) {
      if (!isHolePlacement(placement)) {
        throw new Error("hole() placements must be connectors, sketch points or anchored vertices");
      }
    }
    // Table and option errors surface on the row before any geometry runs.
    resolveHoleDimensions(this.spec(), this.getUnit());
    this.fastenDimensions();
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const dims = resolveHoleDimensions(this.spec(), this.getUnit());
    const fastenDims = this.fastenDimensions();
    const transform = context.getTransform();

    // Every placement is read where it stands and moved with THIS object's
    // clone transform — a repeated hole must not clone its connector (whose
    // copy never moves) nor its sketch; it reads the seed's frames instead.
    const frames = p.record('Resolve placements', () => this.placements.map(placement => {
      const frame = placementFrame(placement);
      return transform ? frame.applyMatrix(transform) : frame;
    }));

    for (const placement of this.placements) {
      if (placement instanceof AnchoredLazyVertex) {
        // The anchor existed only to locate the point; its selection's
        // highlight must not linger. Connectors stay.
        placement.consumeFor(this);
        continue;
      }
      // A sketch the hole is placed on leaves the screen like an extruded
      // one: for display only, so later features can still read it.
      placementSketch(placement)?.removeShapes(this);
    }

    // Classification reads one plane: the first placement's, facing the
    // way a cut's sketch plane does (the tool travels opposite the normal).
    const first = frames[0];
    const cutPlane = Plane.fromPointAndNormal(first.origin, first.normal);

    if (fastenDims) {
      p.record('Cut fastened', () => this.cutFastened(context, dims, fastenDims, frames, cutPlane));
    } else {
      const stock = this.resolveFusionStock(context.getSceneObjects()).filter(held => held.holder !== this);
      const stockSolids = stock.map(held => held.solid);
      const tools: Shape[] = p.record('Build tools', () => frames.map(frame => {
        const direction = frame.normal.normalize().negate();
        const length = dims.depth ?? throughAllLength(stockSolids, [], Plane.fromPointAndNormal(frame.origin, direction));
        return buildHoleTool(frame.origin, direction, dims, length);
      }));
      p.record('Cut', () => cutWithSceneObjects(stock, tools, cutPlane, dims.depth ?? 0, this, { recordHistoryFor: this }));
    }

    this.setState(DIMENSIONS_STATE_KEY, dims);
    this.setState(FRAMES_STATE_KEY, frames);
    this.setState(FASTEN_DIMENSIONS_STATE_KEY, fastenDims);
  }

  /**
   * A fastened hole, read off each placement's axis (see fastenedAxis): the
   * clearance hole cuts the scoped solids, or the solid the hole sits on,
   * and the tapped hole goes into the next solid the axis enters. Each cut
   * runs against its own solids only, so a through tool reaching past them
   * leaves the rest alone. The tapped holes are cut first, one solid at a
   * time — a through bore starts at its placement, a blind one where the
   * axis enters the solid, its depth measured from there — then the
   * clearance holes. Their walls and rims are bucketed clearance first.
   */
  private cutFastened(
    context: BuildSceneObjectContext, dims: HoleDimensions, fastenDims: HoleDimensions, frames: Plane[], cutPlane: Plane,
  ): void {
    const scope = this.getFusionScope();
    const explicit = scope instanceof SceneObject || Array.isArray(scope);
    // Every solid an axis may meet, by solid — the scope's are followed to
    // wherever the features before left them (see liveSolidsOf).
    const scoped = explicit ? this.resolveFusionStock(context.getSceneObjects()) : null;
    const held = new Map<Shape, HeldSolid>();
    for (const entry of [...(scoped ?? []), ...heldSolidsOf(context.getSceneObjects())]) {
      if (entry.holder !== this && !held.has(entry.solid)) {
        held.set(entry.solid, entry);
      }
    }
    const scopedSolids = scoped ? scoped.map(entry => entry.solid) : null;
    const axes = frames.map(frame =>
      fastenedAxis([...held.keys()], scopedSolids, frame.origin, frame.normal.normalize().negate()));
    if (axes.some(axis => axis.tapped === null)) {
      const past = explicit ? 'the scoped solids' : 'the solid the hole sits on';
      throw new Error(`hole(): .fasten() finds no solid along the hole axis past ${past} — the tapped hole goes into the next solid the axis enters`);
    }

    const tapBuckets = this.cutGrouped(frames, axes.map(axis => [axis.tapped!]), held, cutPlane, fastenDims.depth ?? 0,
      (frame, direction, solids, i) => fastenDims.depth === null
        ? buildHoleTool(frame.origin, direction, fastenDims,
          throughAllLength(solids, [], Plane.fromPointAndNormal(frame.origin, direction)))
        : buildHoleTool(frame.origin.add(direction.multiply(axes[i].entry)), direction, fastenDims, fastenDims.depth));
    // A solid one placement tapped may be one another clears: the clearance
    // groups read their solids where the tapped cuts left them.
    const clearanceBuckets = this.cutGrouped(frames, axes.map(axis => axis.clearance), held, cutPlane, dims.depth ?? 0,
      (frame, direction, solids) => buildHoleTool(frame.origin, direction, dims,
        dims.depth ?? throughAllLength(solids, [], Plane.fromPointAndNormal(frame.origin, direction))));

    CUT_STATE_KEYS.forEach((key, i) => this.setState(key, [...clearanceBuckets[i], ...tapBuckets[i]]));
  }

  /**
   * One cut per distinct solid set: the placements whose `targets` match
   * cut those solids — read where they are now — with the tools `toolFor`
   * builds. Returns the cuts' classification buckets, joined in
   * {@link CUT_STATE_KEYS} order.
   */
  private cutGrouped(
    frames: Plane[], targets: Shape[][], held: Map<Shape, HeldSolid>, cutPlane: Plane, distance: number,
    toolFor: (frame: Plane, direction: Vector3d, solids: Shape[], index: number) => Shape,
  ): Shape[][] {
    const groups = new Map<string, { solids: Shape[]; indices: number[] }>();
    const ids = new Map<Shape, number>();
    const idOf = (solid: Shape): number => {
      if (!ids.has(solid)) {
        ids.set(solid, ids.size);
      }
      return ids.get(solid)!;
    };
    targets.forEach((solids, i) => {
      const key = solids.map(idOf).join(',');
      const group = groups.get(key) ?? { solids, indices: [] };
      group.indices.push(i);
      groups.set(key, group);
    });
    const buckets: Shape[][] = CUT_STATE_KEYS.map(() => []);
    for (const { solids, indices } of groups.values()) {
      const stock = solids.flatMap(solid => liveSolidsFrom(held.get(solid)!));
      const stockSolids = stock.map(entry => entry.solid);
      const tools = indices.map(i => {
        const frame = frames[i];
        return toolFor(frame, frame.normal.normalize().negate(), stockSolids, i);
      });
      cutWithSceneObjects(stock, tools, cutPlane, distance, this, { recordHistoryFor: this });
      CUT_STATE_KEYS.forEach((key, k) => buckets[k].push(...((this.getState(key) as Shape[] | undefined) ?? [])));
    }
    return buckets;
  }

  private buildSuffix(prefix: string, args: unknown[]): string {
    if (args.length === 0) {
      return prefix;
    }
    const key = args.map(a => typeof a === 'number' ? a : 'f').join('-');
    return `${prefix}-${key}`;
  }

  private faceSelection(prefix: string, key: string, args: (number | FaceFilterBuilder)[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.buildSuffix(prefix, args)),
      (parent) => {
        const faces = parent.getState(key) as Face[] || [];
        const transform = parent.getTransform();
        const originalFaces = transform
          ? (this.getState(key) as Face[] || [])
          : null;
        return this.resolveFaces(faces, args, transform, originalFaces, parent);
      }, this, args);
  }

  private edgeSelection(prefix: string, key: string, args: (number | EdgeFilterBuilder)[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.buildSuffix(prefix, args)),
      (parent) => {
        const edges = parent.getState(key) as Edge[] || [];
        const transform = parent.getTransform();
        const originalEdges = transform
          ? (this.getState(key) as Edge[] || [])
          : null;
        return this.resolveEdges(edges, args, transform, originalEdges, parent);
      }, this, args);
  }

  /**
   * Indices pick from the bucket (a mirrored copy's index follows the
   * mirrored member); filters run over the bucket with the hole's as-built
   * solids in scope, so `edge().convex()` reads adjacency there.
   */
  private resolveEdges(shapes: Edge[], args: (number | EdgeFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Edge[] = null,
                       owner: SceneObject = this): Edge[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new EdgeFilterBuilder().atIndex(i, shapes, originalShapes));
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

  private resolveFaces(shapes: Face[], args: (number | FaceFilterBuilder)[],
                       transform: Matrix4 = null, originalShapes: Face[] = null,
                       owner: SceneObject = this): Face[] {
    if (args.length === 0) {
      return shapes;
    }

    if (args.every(a => typeof a === 'number')) {
      const indices = args as number[];
      let filters = indices.map(i => new FaceFilterBuilder().atIndex(i, shapes, originalShapes));
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

  /** The walls the cut created — the cylinder, the counterbore step, the countersink cone, the drill point. */
  faces(...args: (number | FaceFilterBuilder)[]): ISelection {
    return this.faceSelection('faces', 'internal-faces', args);
  }

  /** Every edge the cut created: the rims on the surface and the creases inside. */
  edges(...args: (number | EdgeFilterBuilder)[]): ISelection {
    return this.edgeSelection('edges', 'section-edges', args);
  }

  /** The rims where the hole meets the surface it enters. */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection {
    return this.edgeSelection('start-edges', 'start-edges', args);
  }

  /** The rims at the bottom of a blind hole, or where a through hole leaves the solid. */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection {
    return this.edgeSelection('end-edges', 'end-edges', args);
  }

  /** The edges between the hole's own walls: where a countersink or a drill point meets the bore, and the walls' seams. */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection {
    return this.edgeSelection('internal-edges', 'internal-edges', args);
  }

  override scope(...objects: ISceneObject[]): this {
    return super.scope(...objects);
  }

  /**
   * Placements are read, never rebuilt: a repeat clone reads the seed's
   * frames and applies its own transform (see build), so nothing is
   * traversed or copied into the clone set.
   */
  override getDependencies(): SceneObject[] {
    return [];
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Hole(this.size, this.placements);
    copy._fastener = this._fastener;
    copy._style = this._style;
    copy._depth = this._depth;
    copy._tipAngle = this._tipAngle;
    copy._fasten = this._fasten;
    copy._fusionScope = this._fusionScope;
    copy._operationMode = this._operationMode;
    return copy;
  }

  compareTo(other: Hole): boolean {
    if (!(other instanceof Hole) || !super.compareTo(other)) {
      return false;
    }
    if (this.size !== other.size || this._depth !== other._depth || this._tipAngle !== other._tipAngle) {
      return false;
    }
    if (JSON.stringify(this._fastener) !== JSON.stringify(other._fastener)
      || JSON.stringify(this._style) !== JSON.stringify(other._style)) {
      return false;
    }
    if (JSON.stringify(this._fasten) !== JSON.stringify(other._fasten)) {
      return false;
    }
    if (this.placements.length !== other.placements.length) {
      return false;
    }
    return this.placements.every((placement, i) => placement.compareTo(other.placements[i] as any));
  }

  getType(): string {
    return 'hole';
  }

  serialize() {
    return {
      size: this.size,
      fastener: this._fastener,
      style: this._style,
      depth: this._depth,
      tipAngle: this._tipAngle,
      fasten: this._fasten
        ? {
          pitch: this._fasten.pitch, depth: this._fasten.depth, tipAngle: this._fasten.tipAngle,
          dimensions: this.getFastenDimensions(),
        }
        : null,
      dimensions: this.getDimensions(),
      frames: this.getFrames().map(frame => ({
        origin: frame.origin.toArray(),
        normal: frame.normal.toArray(),
      })),
    };
  }
}
