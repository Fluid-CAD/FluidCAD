import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Vector3d } from "../../math/vector3d.js";
import { IHole, ISceneObject, ISelection } from "../../core/interfaces.js";
import { cutWithSceneObjects } from "../../helpers/scene-helpers.js";
import { throughAllLength } from "../../helpers/through-all.js";
import { LazySelectionSceneObject } from "../lazy-scene-object.js";
import { LazyVertex } from "../lazy-vertex.js";
import { AnchoredLazyVertex } from "../anchored-vertex.js";
import { SketchPointVertex } from "../sketch-point-ref.js";
import { SolvedPoint } from "../2d/solved/point.js";
import { Connector } from "../connector.js";
import { PointResolver } from "../point-resolver.js";
import { buildOrthonormalFrame } from "../shape-anchor.js";
import type { FastenerFit } from "./fastener-tables.js";
import {
  buildHoleTool,
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

  /** The statement's options as the profile resolver reads them. */
  spec(): HoleSpec {
    return { size: this.size, fastener: this._fastener, style: this._style, depth: this._depth, tipAngle: this._tipAngle };
  }

  /** The resolved numbers the last build cut with (the file's unit). */
  getDimensions(): HoleDimensions | null {
    return (this.getState(DIMENSIONS_STATE_KEY) as HoleDimensions | undefined) ?? null;
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
  }

  build(context: BuildSceneObjectContext) {
    const p = context.getProfiler();
    const dims = resolveHoleDimensions(this.spec(), this.getUnit());
    const transform = context.getTransform();

    // Every placement is read where it stands and moved with THIS object's
    // clone transform — a repeated hole must not clone its connector (whose
    // copy never moves) nor its sketch; it reads the seed's frames instead.
    const frames = p.record('Resolve placements', () => this.placements.map(placement => {
      const frame = placementFrame(placement);
      return transform ? frame.applyMatrix(transform) : frame;
    }));

    const scope = this.resolveFusionScope(context.getSceneObjects());
    const stock = scope.flatMap(obj => obj.getShapes({}, 'solid'));

    const tools: Shape[] = p.record('Build tools', () => frames.map(frame => {
      const direction = frame.normal.normalize().negate();
      const length = dims.depth ?? throughAllLength(stock, [], Plane.fromPointAndNormal(frame.origin, direction));
      return buildHoleTool(frame.origin, direction, dims, length);
    }));

    for (const placement of this.placements) {
      if (placement instanceof AnchoredLazyVertex) {
        // The anchor existed only to locate the point; its selection's
        // highlight must not linger. Connectors and sketch points stay.
        placement.consumeFor(this);
      }
    }

    // Classification reads one plane: the first placement's, facing the
    // way a cut's sketch plane does (the tool travels opposite the normal).
    const first = frames[0];
    const cutPlane = Plane.fromPointAndNormal(first.origin, first.normal);
    p.record('Cut', () => cutWithSceneObjects(scope, tools, cutPlane, dims.depth ?? 0, this, { recordHistoryFor: this }));

    this.setState(DIMENSIONS_STATE_KEY, dims);
    this.setState(FRAMES_STATE_KEY, frames);
  }

  private stateShapes<T extends Shape>(key: string, indices: number[]): (parent: SceneObject) => T[] {
    return parent => {
      const shapes = (parent.getState(key) as T[] | undefined) ?? [];
      if (indices.length === 0) {
        return shapes;
      }
      return indices.filter(i => i >= 0 && i < shapes.length).map(i => shapes[i]);
    };
  }

  private suffix(prefix: string, indices: number[]): string {
    return indices.length === 0 ? prefix : `${prefix}-${indices.join('-')}`;
  }

  /** The walls the cut created — the cylinder, the counterbore step, the countersink cone, the drill point. */
  faces(...indices: number[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.suffix('faces', indices)),
      this.stateShapes<Face>('internal-faces', indices), this, indices);
  }

  /** Every edge the cut created: the rims on the surface and the creases inside. */
  edges(...indices: number[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.suffix('edges', indices)),
      this.stateShapes<Edge>('section-edges', indices), this, indices);
  }

  /** The rims where the hole meets the surface it enters. */
  startEdges(...indices: number[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.suffix('start-edges', indices)),
      this.stateShapes<Edge>('start-edges', indices), this, indices);
  }

  /** The rims at the bottom of a blind hole, or where a through hole leaves the solid. */
  endEdges(...indices: number[]): ISelection {
    return new LazySelectionSceneObject(this.generateUniqueName(this.suffix('end-edges', indices)),
      this.stateShapes<Edge>('end-edges', indices), this, indices);
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
      dimensions: this.getDimensions(),
      frames: this.getFrames().map(frame => ({
        origin: frame.origin.toArray(),
        normal: frame.normal.toArray(),
      })),
    };
  }
}
