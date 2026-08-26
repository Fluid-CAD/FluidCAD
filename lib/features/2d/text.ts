import type { Font } from "fontkit";
import { Sketch } from "./sketch.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { PlaneObjectBase } from "../plane-renderable-base.js";
import { ExtrudableGeometryBase } from "./extrudable-base.js";
import { IText } from "../../core/interfaces.js";
import { FontRegistry } from "../../io/font-registry.js";
import { TextOutline, type TextAlign } from "../../oc/text-outline.js";
import { PathSampler } from "../../oc/path-sampler.js";
import { WireOps } from "../../oc/wire-ops.js";
import { BuildError } from "../../common/build-error.js";
import { GeometrySceneObject } from "./geometry.js";
import { Plane } from "../../math/plane.js";
import { Point, Point2D } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { StatementAnchors, AnchorPointRef } from "./solved/anchors.js";
import { collectSourceEntities, sourceEntitiesPayload } from "./solved/source-entities.js";

const WEIGHT_NAMES: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400,
  normal: 400, medium: 500, semibold: 600, demibold: 600, bold: 700,
  extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/**
 * Fits a plane through sampled path points (Newell-style accumulation of
 * cross products around the centroid). Returns null when the points are
 * colinear — a straight path carries no orientation of its own.
 */
function fitPathPlane(samples: Point[], startTangent: Vector3d, pathLength: number): Plane | null {
  const n = samples.length;
  let cx = 0, cy = 0, cz = 0;
  for (const p of samples) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const centroid = new Point(cx / n, cy / n, cz / n);

  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i + 1 < n; i++) {
    const a = centroid.vectorTo(samples[i]);
    const b = centroid.vectorTo(samples[i + 1]);
    const cross = a.cross(b);
    nx += cross.x;
    ny += cross.y;
    nz += cross.z;
  }

  const mag = Math.hypot(nx, ny, nz);
  if (mag < 1e-9 * pathLength * pathLength) {
    return null;
  }
  const normal = new Vector3d(nx / mag, ny / mag, nz / mag);
  const xDirection = startTangent
    .subtract(normal.multiply(startTangent.dot(normal)))
    .normalize();
  return new Plane(samples[0], xDirection, normal);
}

/** The `text()` options a path layout reads; the chained path-only modifiers
 * (`.offset()`, `.startAt()`, `.flip()`) default to off. */
export type TextPathLayoutOptions = {
  size: number;
  align: TextAlign;
  lineSpacing: number;
  letterSpacing: number;
  offset?: number;
  startAt?: number;
  flip?: boolean;
};

/** The plane a path object carries of its own, or null (a plane is fitted
 * through the samples instead). */
function pathOwnPlane(path: SceneObject): Plane | null {
  if (path instanceof Sketch) {
    return path.getPlane();
  }
  if (path instanceof ExtrudableGeometryBase) {
    try {
      return path.getPlane();
    } catch {
      return null;
    }
  }
  // Plain sketch geometry (arc, line, …) lies in its sketch's plane.
  if (path instanceof GeometrySceneObject) {
    const sketch = path.sketch;
    return sketch ? sketch.getPlane() : null;
  }
  return null;
}

/**
 * The plane the text lies in: the path object's own plane when it has one
 * (sketch, planar primitive), otherwise a plane fitted through the path.
 * Also verifies the path actually is planar.
 */
function resolveTextPathPlane(path: SceneObject, sampler: PathSampler): Plane {
  const samples = sampler.sample(64);

  let plane = pathOwnPlane(path);
  if (!plane) {
    plane = fitPathPlane(samples, sampler.evalAt(0).tangent, sampler.length);
  }
  if (!plane) {
    throw new BuildError(
      "text: cannot derive the path's orientation — a straight-line path carries no plane of its own.",
      "Draw the path in a sketch (or use a planar primitive) so the text knows which way is up.",
    );
  }

  const tol = Math.max(1e-5, sampler.length * 1e-6);
  for (const p of samples) {
    if (plane.distanceToPoint(p) > tol) {
      throw new BuildError(
        "text: path must be planar.",
        "Text can only follow a curve lying in a single plane (e.g. a sketch curve or a planar edge loop).",
      );
    }
  }
  return plane;
}

/**
 * Lay `text` along `path` — the layout core `Text.build` and the dialogs'
 * glyph preview share: chain ALL of the path's edges (guides included —
 * marking the path `.guide()` is the natural way to keep it out of the
 * sketch profile) into a wire, resolve the plane the text lies in, normalize
 * closed-loop winding so text sits on the OUTSIDE by default, and place the
 * glyph outlines at arc-length stations. Throws {@link BuildError} on empty,
 * disconnected or non-planar paths.
 */
export function buildTextEdgesAlongPath(
  path: SceneObject,
  text: string,
  font: Font,
  options: TextPathLayoutOptions,
): { edges: Edge[]; plane: Plane } {
  const shapes = path.getShapes({ excludeMeta: false, excludeGuide: false });
  const pathEdges = shapes.flatMap(s => s.getSubShapes('edge')) as Edge[];
  if (pathEdges.length === 0) {
    throw new BuildError("text: path contains no edges.");
  }

  const wire = WireOps.makeWireFromEdges(pathEdges);
  const sampler = new PathSampler(wire);
  try {
    const plane = resolveTextPathPlane(path, sampler);

    // On a closed loop, normalize the (arbitrary) wire winding so text
    // sits on the OUTSIDE by default; `.flip()` then moves it inside.
    // A clockwise loop (w.r.t. the plane normal) already has its glyph
    // "up" (normal × tangent) pointing outward.
    let flip = options.flip === true;
    if (sampler.closed && !WireOps.isCW(wire, plane.normal)) {
      flip = !flip;
    }

    const edges: Edge[] = TextOutline.buildEdgesAlongPath(
      font,
      text,
      {
        size: options.size,
        align: options.align,
        lineSpacing: options.lineSpacing,
        letterSpacing: options.letterSpacing,
      },
      {
        evalAt: (s) => sampler.evalAt(s),
        length: sampler.length,
        normal: plane.normal,
        offset: options.offset ?? 0,
        startAt: options.startAt ?? 0,
        flip,
        closed: sampler.closed,
      },
    );

    return { edges, plane };
  } finally {
    sampler.dispose();
  }
}

/**
 * 3D text as an extrudable outline profile. Glyph outlines are produced via
 * fontkit and converted to sketch edges; extruding the result gives raised or
 * cut lettering. Works standalone on a plane (`text("xy", "Hi")`), inside a
 * `sketch()` (`text("Hi")`), or following a planar curve
 * (`text("Hi", path)`).
 */
export class Text extends ExtrudableGeometryBase implements IText {
  private _size = 10;
  private _font?: string;
  private _weight = 400;
  private _italic = false;
  private _align: TextAlign = "left";
  private _lineSpacing = 1;
  private _letterSpacing = 0;
  private _pathOffset = 0;
  private _flip = false;
  private _startAt = 0;
  private _pathPlane: Plane | null = null;
  private _anchor: Point2D | null = null;
  private anchors = new StatementAnchors();

  constructor(public text: string, targetPlane: PlaneObjectBase = null, private path: SceneObject = null) {
    super(targetPlane);
  }

  /**
   * Called by the command factory right after addSceneObject (anchored
   * form only — path text has no anchor): the anchor registers as a
   * solver point entity, so constraints can target it and the solve
   * positions the text. The guess starts at the plane origin; a chained
   * `.at([x, y])` refines it before the solve.
   */
  register(sk: Sketch): void {
    if (this.path) {
      return;
    }
    this.anchors.register(sk, this, [this._anchor ?? new Point2D(0, 0)]);
  }

  /** The anchor point — this text's solver entity, targetable by
   * constraints, and a lazy vertex anywhere a point is accepted. */
  anchor(): AnchorPointRef {
    if (this.path) {
      throw new Error("text: .anchor() applies to anchored text — text following a path has no anchor point.");
    }
    return this.anchors.ref(this, 0, this.generateUniqueName('ref-anchor'));
  }

  /** Solver identity when this text is a derived-op source (P8): anchored
   * text vouches through its anchor (glyphs are literals); path text
   * vouches through whatever the path vouches through. */
  anchorSourceEntities(): { ids: number[]; allSolved: boolean } | undefined {
    if (this.path) {
      return collectSourceEntities([this.path]);
    }
    return this.anchors.registered
      ? { ids: [this.anchors.entityId(0)], allSolved: true }
      : undefined;
  }

  build(): void {
    if (this.path) {
      this.buildAlongPath();
      return;
    }
    if (this._pathOffset !== 0 || this._flip || this._startAt !== 0) {
      throw new BuildError(
        "text: .offset(), .flip() and .startAt() only apply to text following a path.",
        "Use the text(string, path) form, or remove these modifiers.",
      );
    }
    if (this._align === "space-between" || this._align === "space-around") {
      throw new BuildError(
        `text: align('${this._align}') only applies to text following a path.`,
        "Use the text(string, path) form, or pick left/center/right.",
      );
    }

    const plane = this.targetPlane
      ? this.targetPlane.getPlane()
      : (this.getParent() as Sketch).getPlane();
    // No pen exists since P7 — the anchored form draws at the plane origin
    // (what the legacy cursor defaulted to) unless `.at([x, y])` places it.
    // Inside a sketch the anchor is a solver point entity: read the solved
    // position (constraints may have moved it off the literal).
    const origin = this.anchors.registered
      ? this.anchors.solvedValues(this)[0]
      : this._anchor
        ?? (this.targetPlane
          ? plane.worldToLocal(this.targetPlane.getPlaneCenter())
          : new Point2D(0, 0));

    const font = FontRegistry.resolve({ font: this._font, weight: this._weight, italic: this._italic });

    const edges: Edge[] = TextOutline.buildEdges(
      font,
      this.text,
      {
        size: this._size,
        align: this._align,
        lineSpacing: this._lineSpacing,
        letterSpacing: this._letterSpacing,
      },
      plane,
      origin,
    );

    this.addShapes(edges);

    if (this.targetPlane) {
      this.targetPlane.removeShapes(this);
    }
  }

  private buildAlongPath(): void {
    const font = FontRegistry.resolve({ font: this._font, weight: this._weight, italic: this._italic });
    const { edges, plane } = buildTextEdgesAlongPath(this.path, this.text, font, {
      size: this._size,
      align: this._align,
      lineSpacing: this._lineSpacing,
      letterSpacing: this._letterSpacing,
      offset: this._pathOffset,
      startAt: this._startAt,
      flip: this._flip,
    });
    this._pathPlane = plane;
    this.addShapes(edges);
  }

  override getPlane(): Plane {
    if (this.path) {
      if (!this._pathPlane) {
        throw new Error("text: the path plane is resolved during build; render the scene first.");
      }
      return this._pathPlane;
    }
    return super.getPlane();
  }

  size(value: number): this {
    this._size = value;
    return this;
  }

  /** Places the text anchor at an explicit local position (default: the
   * plane origin). Not applicable to text following a path. */
  at(position: Point2D | [number, number]): this {
    this._anchor = Array.isArray(position)
      ? new Point2D(position[0], position[1])
      : position;
    // Statement-time chain: refine the registered anchor's guess (the
    // factory registered at the plane-origin default before `.at()` ran).
    if (this.anchors.registered) {
      this.anchors.updateGuess(0, this._anchor);
    }
    return this;
  }

  font(name: string): this {
    this._font = name;
    return this;
  }

  weight(value: number | string): this {
    this._weight = typeof value === "number" ? value : (WEIGHT_NAMES[value.toLowerCase()] ?? 400);
    return this;
  }

  bold(): this {
    this._weight = 700;
    return this;
  }

  italic(value: boolean = true): this {
    this._italic = value;
    return this;
  }

  align(value: TextAlign): this {
    this._align = value;
    return this;
  }

  lineSpacing(value: number): this {
    this._lineSpacing = value;
    return this;
  }

  letterSpacing(value: number): this {
    this._letterSpacing = value;
    return this;
  }

  offset(value: number): this {
    this._pathOffset = value;
    return this;
  }

  flip(value: boolean = true): this {
    this._flip = value;
    return this;
  }

  startAt(distance: number): this {
    this._startAt = distance;
    return this;
  }

  getType(): string {
    return "text";
  }

  override getDependencies(): SceneObject[] {
    const deps: SceneObject[] = [];
    if (this.targetPlane) {
      deps.push(this.targetPlane);
    }
    if (this.path) {
      deps.push(this.path);
    }
    return deps;
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const targetPlane = this.targetPlane
      ? (remap.get(this.targetPlane) as PlaneObjectBase || this.targetPlane)
      : null;
    const path = this.path
      ? (remap.get(this.path) || this.path)
      : null;
    const copy = new Text(this.text, targetPlane, path);
    copy._size = this._size;
    copy._font = this._font;
    copy._weight = this._weight;
    copy._italic = this._italic;
    copy._align = this._align;
    copy._lineSpacing = this._lineSpacing;
    copy._letterSpacing = this._letterSpacing;
    copy._pathOffset = this._pathOffset;
    copy._flip = this._flip;
    copy._startAt = this._startAt;
    copy._anchor = this._anchor;
    this.anchors.copyTo(copy.anchors);
    return copy;
  }

  override compareTo(other: Text): boolean {
    if (!(other instanceof Text)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.targetPlane?.constructor !== other.targetPlane?.constructor) {
      return false;
    }
    if (this.targetPlane && other.targetPlane && !this.targetPlane.compareTo(other.targetPlane)) {
      return false;
    }
    if (this.path?.constructor !== other.path?.constructor) {
      return false;
    }
    if (this.path && other.path && !this.path.compareTo(other.path)) {
      return false;
    }
    if (!this.anchors.sameAs(other.anchors)) {
      return false;
    }
    return this.text === other.text
      && this._size === other._size
      && this._font === other._font
      && this._weight === other._weight
      && this._italic === other._italic
      && this._align === other._align
      && this._lineSpacing === other._lineSpacing
      && this._letterSpacing === other._letterSpacing
      && this._pathOffset === other._pathOffset
      && this._flip === other._flip
      && this._startAt === other._startAt
      && (this._anchor?.x ?? null) === (other._anchor?.x ?? null)
      && (this._anchor?.y ?? null) === (other._anchor?.y ?? null);
  }

  serialize() {
    const anchored = this.anchors.registered;
    const guess = this._anchor ?? new Point2D(0, 0);
    return {
      text: this.text,
      size: this._size,
      font: this._font,
      weight: this._weight,
      italic: this._italic,
      align: this._align,
      lineSpacing: this._lineSpacing,
      letterSpacing: this._letterSpacing,
      offset: this._pathOffset,
      flip: this._flip,
      startAt: this._startAt,
      // Solver join fields (the UI's statement→entity map + the drag
      // write-back's drift guard), present only inside a sketch.
      ...(anchored
        ? {
          entityId: this.anchors.entityId(0),
          anchor: { x: this.anchors.value(0).x, y: this.anchors.value(0).y },
          guess: { anchor: { x: guess.x, y: guess.y } },
        }
        : {}),
      // Path text is a rigid layout over its path — the tint join makes
      // the glyphs wear the path's constrained verdict.
      ...(this.path ? sourceEntitiesPayload(collectSourceEntities([this.path])) : {}),
    };
  }
}
