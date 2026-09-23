import type { LazyVertex } from "../features/lazy-vertex.js";
import type { PointLike } from "../math/point.js";
import type { FaceFilterBuilder } from "../filters/face/face-filter.js";
import type { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { Axis, AxisLike } from "../math/axis.js";
import type { Plane, PlaneLike } from "../math/plane.js";
import type { NumberParam } from "./param.js";

export interface ISceneObject {
  /**
   * Sets a custom display name for this object, overriding the default type-based name.
   * @param value - The display name to assign.
   */
  name(value: string): this;

  /**
   * Marks this object as reusable. Reusable objects retain their shapes when
   * consumed by features (e.g., extrude, revolve), allowing multiple features
   * to reference the same source geometry. Use `remove(obj)` to force-remove
   * shapes from a reusable object.
   */
  reusable(): this;
}

export interface ISketch extends ISceneObject {
  /**
   * Marks the sketch finished. The editor stays in sketch mode while the
   * timeline ends in an open sketch; a closed sketch ends that without a
   * consuming feature, so a profile can be left unconsumed and the model
   * still opens as a 3D scene. The Finish Sketch button adds this chain and
   * removes it again when the sketch is reopened for editing.
   */
  close(): this;
}

export interface LoadOptions {
  /**
   * Asserts the unit the asset's cached geometry is in. Normally unnecessary:
   * imports are cached in mm and `load()` scales them into the loading
   * document's unit automatically. Use it only for assets without trustworthy
   * metadata (a `.brep` copied in by hand, a STEP whose header lied); it
   * overrides the import sidecar. One of `mm`, `cm`, `m`, `in`, `ft`.
   */
  unit?: string;
}

export interface ILoadFile extends ISceneObject {
  /**
   * Skip applying colors from the imported file's color metadata sidecar.
   */
  noColors(): this;

  /**
   * Keep only the solids at the given 0-based indices (in load order).
   * Combined with {@link exclude} by applying include first, then exclude.
   * Repeated calls accumulate.
   * @param indices - The 0-based solid indices to keep.
   */
  include(...indices: number[]): this;

  /**
   * Drop the solids at the given 0-based indices. Applied after {@link include}.
   * Repeated calls accumulate.
   * @param indices - The 0-based solid indices to drop.
   */
  exclude(...indices: number[]): this;
}

export interface IBooleanOperation extends ISceneObject {
  /**
   * Additive boolean operation — fuses the result with all intersecting scene objects.
   * Use `.scope()` to target specific objects.
   */
  add(): this;

  /**
   * No boolean operation — keeps the result as a standalone shape,
   * separate from all other scene objects.
   */
  'new'(): this;

  /**
   * Subtractive boolean operation — cuts the result from all intersecting scene objects.
   * Use `.scope()` to target specific objects.
   */
  remove(): this;

  /**
   * Narrows the boolean operation scope to specific target objects.
   * Must be chained after `.add()` or `.remove()`.
   * @param objects - The target objects to operate on.
   */
  scope(...objects: ISceneObject[]): this;
}

/**
 * Scene objects that can be chained with world-space transformations.
 * The chained form `obj.translate(...)` / `obj.rotate(...)` / `obj.mirror(...)`
 * applies the transform to the object's built shapes; it does not create
 * a separate history entry like the free-function `translate()` does.
 *
 * Container objects (sketches, parts, repeat/mirror features) deliberately
 * do not expose this interface — apply transforms to their contents instead.
 */
export interface ITransformable extends ISceneObject {
  /**
   * Composes a 4x4 transformation matrix onto this object. Applied to the
   * object's own shapes after build. Chained calls compose left-to-right:
   * `.translate(T).rotate(R)` applies translation first, then rotation.
   */
  transform(matrix: Matrix4): this;

  /**
   * Translate along X.
   * @param x - Distance along world X.
   */
  translate(x: NumberParam): this;
  /**
   * Translate along X and Y.
   */
  translate(x: NumberParam, y: NumberParam): this;
  /**
   * Translate along X, Y, and Z.
   */
  translate(x: NumberParam, y: NumberParam, z: NumberParam): this;
  /**
   * Translate by a point-like offset in world space.
   */
  translate(offset: PointLike): this;

  /**
   * Rotate by an angle around world Z through the origin.
   * @param angle - Rotation in degrees.
   */
  rotate(angle: NumberParam): this;
  /**
   * Rotate around an axis by an angle.
   * @param axis - The axis to rotate around.
   * @param angle - Rotation in degrees.
   */
  rotate(axis: AxisLike, angle: NumberParam): this;

  /**
   * Mirror across a plane.
   */
  mirror(plane: PlaneLike): this;
  /**
   * Mirror across an axis (primarily useful for 2D geometry).
   */
  mirror(axis: AxisLike): this;
}

/**
 * A plane datum in the scene — what `plane()` returns. `getPlane()` is the
 * one member every plane object shares; it is declared here (rather than
 * leaving the interface empty) so a plane is structurally distinct from a
 * bare `ISceneObject` and overloaded functions such as `mirror()` resolve
 * their `PlaneLike` forms instead of a 2D `line` form.
 */
export interface IPlane extends ISceneObject {
  /** The resolved plane (origin, normal, x-direction) this datum stands for. */
  getPlane(): Plane;
}

/**
 * An axis datum in the scene — what `axis()` returns. `getAxis()`
 * plays the same structural role here as `getPlane()` does on `IPlane`.
 */
export interface IAxis extends ISceneObject {
  /** The resolved axis (origin, direction) this datum stands for. */
  getAxis(): Axis;
}

/**
 * A face/edge selection — the result of `select(...)` or of lazy accessors
 * like `e.endFaces()` / `e.startEdges(0)` / `rect.edge('top')`. Besides
 * feeding features directly, a selection can reference well-known points on
 * its **first** face or edge; the returned `LazyVertex` re-derives on every
 * render and keeps the underlying geometry's orientation, so
 * `connector('name', e.endFaces().center())` aligns with the face normal.
 */
export interface ISelection extends ISceneObject {
  /**
   * The center of the selection's first face or edge: bounding-box center
   * for a face, circle center for a circular edge or arc, midpoint for any
   * other edge.
   */
  center(): LazyVertex;

  /**
   * The start vertex of the selection's first edge, in the edge's canonical
   * direction (straight edges lean positive along the leading world axis,
   * so re-selections and rebuilds agree). Not available on faces.
   */
  start(): LazyVertex;

  /**
   * The end vertex of the selection's first edge, in the edge's canonical
   * direction. Not available on faces.
   */
  end(): LazyVertex;

  /**
   * A point along the selection's first edge.
   * - `offset('relative', t)` — t from 0 (start) to 1 (end); works on any edge.
   * - `offset('absolute', d)` — d units from the start, or negative for
   *   d units back from the end; straight line edges only.
   */
  offset(mode: "relative" | "absolute", value: number): LazyVertex;
}

export interface ISelect extends ISelection {}

/**
 * A mate connector attached to a part — a coordinate frame the assembly
 * pipeline can reference. Returned by the `connector(...)` DSL.
 *
 * `rotate` and `offset` adjust the frame in its **local** axes (not world),
 * so the connector's own xDirection / yDirection / normal define the
 * transform — chaining calls composes left-to-right against the *current*
 * (already-transformed) frame.
 */
export interface IConnector extends ISceneObject {
  /**
   * Rotate the connector frame around its own local X, Y, or Z axis,
   * pivoting at its current origin.
   * @param axis - "x", "y", or "z" — the connector's local axis name.
   * @param angle - Rotation in degrees.
   */
  rotate(axis: "x" | "y" | "z", angle: number): this;

  /**
   * Translate the connector origin along its own local axes:
   * `x · xDirection + y · yDirection + z · normal`. Omitted `y` / `z`
   * default to 0. Axes are unchanged.
   */
  offset(x: number, y?: number, z?: number): this;
}

/**
 * A built part in the scene — one materialized variant of a `part(...)`
 * definition, carrying the geometry and named connectors every instance of
 * that variant shares. `part()` itself returns the lazy `PartDefinition`;
 * this interface is the scene object the definition builds.
 */
/**
 * A materialized part. Its geometry is in the unit of the scene that
 * consumes it: a definition from a file with a different `unit()` is
 * rescaled into the consumer's unit when it renders. `insert(def, { … })`
 * parameter overrides stay in the part file's own unit — see `insert`.
 */
export interface IPart extends ISceneObject {}

export interface IGeometry extends ISceneObject {
  /**
   * Marks this sketch geometry as construction geometry. Guide geometries are
   * excluded from the final sketch output (e.g., extrude, revolve) unless
   * explicitly included.
   */
  guide(): this;

  /**
   * Uniform edge accessor. `edge('body')` selects this feature's edges by
   * role (optionally disambiguated by role index); `edge(1)` selects by
   * build-order index over the feature's real edges. Roles: solver lines and
   * arcs stamp `body`; circles and ellipses `perimeter`; derived-op outputs
   * carry provenance-specific roles (e.g. fillet arcs).
   * @param roleOrIndex - A role name, or a build-order edge index.
   * @param roleIndex - Disambiguates roles that repeat.
   */
  edge(roleOrIndex: string | number, roleIndex?: number): ISelection;

  /**
   * Returns a lazy-evaluated vertex at the start point of this geometry element.
   */
  start(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex at the end point of this geometry element.
   */
  end(): LazyVertex;
}

export interface IExtrudableGeometry extends IGeometry {}

/**
 * One projected/sectioned edge as a constraint target (P6 fixed reference):
 * `p.ref(0)` names the edge, its accessors name its points.
 */
export interface IReferenceEntity {
  start(): LazyVertex;
  end(): LazyVertex;
  center(): LazyVertex;
}

/**
 * A `project()`/`intersect()` result inside a solved sketch: fixed reference
 * geometry the constraints can target. Passing the reference itself (or its
 * `center()`) resolves when it produced exactly one constrainable edge;
 * `.ref(i)` addresses one of several.
 */
export interface IReference extends IExtrudableGeometry {
  /** Constraint target naming projected edge `i` (0-based emitted order). */
  ref(index: number): IReferenceEntity;
  /** The single projected circle/arc's center point. */
  center(): LazyVertex;
}

/** A solved (constraint-sketch) line statement. */
export interface ISolvedLine extends IGeometry {
  /**
   * Returns a lazy-evaluated vertex at the line's midpoint. In constraints
   * it is accepted by coincident(), which lowers it to the midpoint
   * constraint.
   */
  mid(): LazyVertex;
}

/** A solved (constraint-sketch) arc statement. */
export interface ISolvedArc extends IGeometry {
  /**
   * Sweeps the arc clockwise from start to end (display/topology only — the
   * solver has no sweep parameter).
   */
  cw(): this;

  /** Sweeps the arc counter-clockwise from start to end (the default). */
  ccw(): this;

  /** Returns a lazy-evaluated vertex at the arc's center. */
  center(): LazyVertex;
}

/** A solved (constraint-sketch) circle statement. */
export interface ISolvedCircle extends IExtrudableGeometry {
  /** Returns a lazy-evaluated vertex at the circle's center. */
  center(): LazyVertex;
}

/**
 * One named edge of a macro shape (`r.bottom()`, `r.corner(i)`): a
 * constraint/dimension target. Its point accessors name the edge's
 * endpoints (and an arc's center), like the solved primitives'.
 */
export interface IMacroEdge {
  start(): LazyVertex;
  end(): LazyVertex;
  center(): LazyVertex;
}

/**
 * A `rect()` macro shape (fluidcad/shapes): an axis-aligned rectangle as
 * one atomic, self-constrained statement. All arguments are guesses — a
 * bare rect keeps 4 degrees of freedom (5 with `.radius()`); pin and
 * dimension it with external constraints against its edge accessors.
 */
export interface IRect extends ISceneObject {
  // rect(pos, width, height? = width) — omitting height draws a square.
  /** Marks the whole shape as construction geometry. */
  guide(): this;
  /** Reinterprets the position argument as the rectangle's center. */
  centered(): this;
  /**
   * Rounds all four corners with a shared radius. The value is a guess
   * (one extra degree of freedom) — lock it with a `radius()` dimension
   * on a corner arc.
   */
  radius(r: number): this;
  /** The bottom edge (drawing order: the side leaving the pos corner). */
  bottom(): IMacroEdge;
  right(): IMacroEdge;
  top(): IMacroEdge;
  left(): IMacroEdge;
  /** Corner arc `i` (0 at the pos corner, numbered counter-clockwise) —
   * rounded rects only. */
  corner(i: number): IMacroEdge;
}

/**
 * An ellipse statement — a solver entity like a circle: center, rotation
 * and both semi-radii solve. The statement itself is a constraint target:
 * `radius(el, v, 'x' | 'y')` dimensions a semi-radius,
 * `horizontal(el)`/`vertical(el)` orient its RX axis, `concentric(el, c)`
 * shares its center, `tangent(el, l)` touches a line, circle, arc or
 * another ellipse, `coincident(p, el)` puts a point on it, `equal(e1, e2)`
 * matches shapes.
 */
export interface IEllipse extends IExtrudableGeometry {
  /** Returns a lazy-evaluated vertex at the ellipse's center — a
   * constraint target like a circle's `.center()`. */
  center(): LazyVertex;
}

/**
 * A bezier statement. Inside a sketch every control point given as a
 * literal is a solver point entity — constraints target `.point(i)`
 * (or `.start()`/`.end()`) and the solve reshapes the curve. A control
 * point given as another entity's accessor (e.g. `l.end()`) is that
 * entity's point; `.point(i)` returns the original reference.
 */
export interface IBezier extends IGeometry {
  /** Returns the i-th control point (0-based; 0 is the start, the last
   * index is the end) as a lazy vertex / constraint target. */
  point(index: number): LazyVertex;
  /** Returns the curve's start point — `point(0)`. */
  start(): LazyVertex;
  /** Returns the curve's end point — `point(n - 1)`. */
  end(): LazyVertex;
}

/** A distance dimension statement in a constraint-mode sketch. */
export interface IDistance extends ISceneObject {
  /**
   * Measures to the FAR side of any circle/arc in the pair (the
   * SolidWorks/Onshape arc-condition "max"): point–circle and
   * line–circle measure `center distance + radius`, circle–circle
   * measures between the far circumferences. Requires a circle or arc
   * entity target. For a center distance, dimension the accessor
   * instead: `distance(l, a.center(), v)`.
   */
  max(): this;

  /**
   * Measures to the NEAR side of the circumference — the default; an
   * explicit `.min()` only documents intent.
   */
  min(): this;
}

export interface IText extends IExtrudableGeometry {
  /**
   * Sets the text height (em size) in model units. Default 10.
   * @param value - The em size.
   */
  size(value: number): this;

  /**
   * Places the text anchor at an explicit local position. Default: the
   * sketch plane origin. Not applicable to text following a path.
   * @param position - The anchor point in sketch coordinates.
   */
  at(position: [number, number]): this;

  /**
   * Returns the anchor point — a solver point entity constraints can
   * target, so the solve positions the text. Not applicable to text
   * following a path.
   */
  anchor(): LazyVertex;

  /**
   * Sets the font. A name without a font extension (e.g. `"Arial"`) is resolved
   * to a system font; a value ending in `.ttf`/`.otf`/`.ttc`/`.woff` (e.g.
   * `"fonts/Brand.ttf"`) is loaded as a workspace-relative file. When omitted, a
   * default system font is used.
   * @param name - A system family name or a workspace-relative font file path.
   */
  font(name: string): this;

  /**
   * Sets the font weight: a number (100–900) or a name such as `"regular"`,
   * `"medium"`, or `"bold"`. Resolves to the matching face (or the wght axis of a
   * variable font).
   * @param value - The weight as a number or name.
   */
  weight(value: number | string): this;

  /**
   * Shortcut for `weight(700)`.
   */
  bold(): this;

  /**
   * Renders the italic/oblique face of the font.
   * @param value - Whether to use italic (defaults to true).
   */
  italic(value?: boolean): this;

  /**
   * Horizontal alignment of the text. For straight text it is relative to the
   * origin point; for text along a path it positions the run against the
   * path: `"start"` begins at the path's start, `"center"` centers on the
   * midpoint, `"end"` finishes at the path's end, `"space-between"` justifies
   * the glyphs evenly across the whole path, and `"space-around"` spreads
   * them with half a gap before the first glyph and after the last, like the
   * CSS flexbox value (both path text only). `"left"` and `"right"` are
   * synonyms of `"start"` and `"end"`.
   * @param value - `"left"`/`"start"` (default), `"center"`,
   *   `"right"`/`"end"`, `"space-between"`, or `"space-around"`.
   */
  align(value: "left" | "center" | "right" | "start" | "end" | "space-between" | "space-around"): this;

  /**
   * Line-height multiplier for multi-line text (newlines in the string).
   * @param value - Multiplier on the font's natural line height (default 1).
   */
  lineSpacing(value: number): this;

  /**
   * Extra spacing added between glyphs, in model units (default 0).
   * @param value - The additional advance per glyph.
   */
  letterSpacing(value: number): this;

  /**
   * Shifts the baseline perpendicular to the path, in model units: positive
   * values move the text toward its "up" side, negative below the path.
   * Only applies to text following a path (`text(string, path)`).
   * @param value - The perpendicular baseline shift.
   */
  offset(value: number): this;

  /**
   * Mirrors the text to the other side of the path, reversing the reading
   * direction. On a closed path (circle, loop) text sits on the outside by
   * default — `.flip()` moves it inside. On an open path it mirrors the text
   * below the curve. Only applies to text following a path.
   * @param value - Whether to flip (defaults to true).
   */
  flip(value?: boolean): this;

  /**
   * Shifts where the text starts along the path, as an arc-length distance
   * from the path's start (combines with `align()`). On a closed path the
   * text wraps around. Only applies to text following a path.
   * @param distance - The arc-length shift in model units.
   */
  startAt(distance: number): this;
}

/**
 * One edge of an offset result (`o.edge(i)`): a whole-edge operand like any
 * `edge(i)` selection, and a point source for references from outside the
 * sketch — loft connections, connectors — through `.start()`, `.end()` and,
 * on an arc, `.center()`. Offset edges have no solver identity, so these
 * points are not constraint targets.
 */
export interface IOffsetEdge extends ISelect {
  /** The edge's first point along the offset walk (see `IOffset.edge`). */
  start(): LazyVertex;

  /** The edge's last point along the offset walk — `o.edge(i).end()` is `o.edge(i + 1).start()`. */
  end(): LazyVertex;

  /** The center of an arc edge (an offset arc or a rounded outward corner); an error on a line. */
  center(): LazyVertex;
}

export interface IOffset extends IExtrudableGeometry {
  /**
   * Closes an open offset by joining it back to the source wire with
   * straight cap edges at each endpoint. Has no effect when the offset
   * is already closed.
   */
  close(): this;

  /**
   * One edge of the result by index, with point accessors for references
   * from outside the sketch (`a.geometries.o.edge(2).start()` in a loft
   * connection). Indices walk the result: index 0 is the offset of the
   * first source edge in statement order (for an open offset, the offset of
   * the chain's first edge), the walk continues in that edge's own
   * direction, and the arcs an outward offset rounds corners with are
   * ordinary steps of it. Several separate sources offset to several wires,
   * numbered wire after wire in statement order; `.close()` appends the cap
   * at the walk's end, then the cap at its start. Because the indices are
   * positional, an edit that changes which corners are rounded — flipping
   * the sign, for one — shifts them, and a reference then resolves to a
   * different vertex, as any index-based reference does.
   * @param index - The 0-based edge index along the offset walk.
   */
  edge(index: number): IOffsetEdge;
}

export interface ICommon extends ISceneObject {
  /**
   * Controls whether the original objects involved in the boolean intersection
   * are retained or removed after the operation.
   * @param value - `true` to keep originals, `false` (default) to remove them.
   */
  keepOriginal(value?: boolean): this;
}

export interface IExtrude extends IBooleanOperation {
  /**
   * Enables symmetric mode — extrudes equally in both directions from the sketch plane.
   */
  symmetric(): this;
  /**
   * Selects faces at the start (base) of the extrusion.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects faces at the end (cap) of the extrusion.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the start (base) faces of the extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the end (cap) faces of the extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the lateral faces created by the extrusion.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects faces created inside the solid during extrusion (e.g., from holes or intersections).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges bounding the internal geometry created during extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the cap faces at the open ends of a thin-walled extrusion from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the cap faces of a thin-walled extrusion from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Applies a draft (taper) angle to the extrusion walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: NumberParam | [NumberParam, NumberParam]): this;

  /**
   * Offsets the end face by a specified distance along the extrusion direction.
   * @param value - The offset distance.
   */
  endOffset(value: NumberParam): this;

  /**
   * Enables or disables drill mode, which partitions the sketch into face regions
   * before extruding.
   * @param value - `true` to enable (default), `false` to disable.
   */
  drill(value?: boolean): this;

  /**
   * Restricts extrusion to particular regions of the sketch. A region is
   * named by the sketch entities on its outer loop — `'b r t l'` for the
   * rectangle those four lines close, `'c1 c2-'` for the ring inside `c1`
   * and outside `c2` — or by its position in the sketch's region list.
   * The region pick mode writes the keys.
   * @param keys - Region keys, or positions in the sketch's region list.
   */
  region(...keys: (string | number)[]): this;

  /**
   * Enables thin extrude mode — offsets the profile edges to create a thin-walled solid
   * instead of extruding filled faces. Positive values offset outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: NumberParam): this;

  /**
   * Enables thin extrude mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: NumberParam, offset2: NumberParam): this;
}

export interface ICut extends ISceneObject {
  /**
   * Enables symmetric mode — cuts equally in both directions from the sketch plane.
   */
  symmetric(): this;

  /**
   * Narrows the cut scope to specific target objects.
   * Must be chained after `.remove()`.
   * @param objects - The target objects to cut from.
   */
  scope(...objects: ISceneObject[]): this;
  /**
   * Applies a draft (taper) angle to the cut walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: NumberParam | [NumberParam, NumberParam]): this;

  /**
   * Offsets the cut end face by a specified distance along the cut direction.
   * @param value - The offset distance.
   */
  endOffset(value: NumberParam): this;

  /**
   * Selects the edges at the top of the cut: the rims where the tool entered the
   * material, on whatever face it entered through (a flat top or a curved wall).
   * A symmetric cut starts inside the material, so it only has start edges where
   * the sketch plane lies in a void and the tool meets material further out.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the edges at the bottom of the cut: every edge of a floor the tool
   * stopped at, and the rims where a through cut left the material.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the edges created inside the solid: creases between the cut's own
   * walls, and rims along faces the cut runs parallel to.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects internal faces exposed by the cut — newly created surfaces not from the original stock.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Restricts the cut to particular regions of the sketch, named by the
   * sketch entities on their outer loop (`'c1 c2-'`) or by position in the
   * sketch's region list. See `IExtrude.region`.
   * @param keys - Region keys, or positions in the sketch's region list.
   */
  region(...keys: (string | number)[]): this;

  /**
   * Enables thin cut mode — offsets the profile edges to cut a thin-walled shape
   * instead of cutting filled faces. Positive values offset outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: NumberParam): this;

  /**
   * Enables thin cut mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: NumberParam, offset2: NumberParam): this;
}

export interface IRevolve extends IBooleanOperation {
  /**
   * Enables symmetric mode — revolves equally in both directions from the sketch plane.
   */
  symmetric(): this;
  /**
   * Restricts the revolve to particular regions of the sketch, named by the
   * sketch entities on their outer loop (`'c1 c2-'`) or by position in the
   * sketch's region list. See `IExtrude.region`.
   * @param keys - Region keys, or positions in the sketch's region list.
   */
  region(...keys: (string | number)[]): this;

  /**
   * Enables thin revolve mode — offsets the profile edges to create a thin-walled
   * solid of revolution instead of revolving filled faces. Positive values offset
   * outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: NumberParam): this;

  /**
   * Enables thin revolve mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: NumberParam, offset2: NumberParam): this;

  /**
   * Selects faces created inside the solid during revolution (e.g., the inner
   * wall of a thin-walled revolve from a closed profile).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges bounding the internal geometry created during revolution.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the cap faces at the open ends of a thin-walled revolve from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the cap faces of a thin-walled revolve from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;
}

/**
 * How a loft leaves (or arrives at) an end profile:
 * - `'none'` — no constraint (default).
 * - `'normal'` — the surface takes off perpendicular to the profile plane.
 * - `'tangent'` — the surface takes off inside the profile plane, directed
 *   outward, so the profile plane becomes a tangency plane.
 */
export type LoftConditionType = 'none' | 'normal' | 'tangent';

export interface ILoft extends IBooleanOperation {
  /**
   * Joins one vertex on each profile, in profile order. Repeat `.connect()`
   * for additional connections. Each connection becomes an edge of the loft.
   * Points may be world coordinates or sketch/selection point references.
   * Requires closed, planar profiles with one region each. Full circles and
   * ellipses must be split into arcs to supply vertices. Connections compose
   * with start/end conditions; guides and thin walls are not yet supported.
   * @param points - One profile vertex per section, in the loft's profile order.
   */
  connect(...points: (PointLike | LazyVertex)[]): this;

  /**
   * Adds side guide curves (rails) the loft surface must follow. Supports one
   * or two guides in total; a single argument may carry several separate
   * curves (e.g. a sketch holding a curve and its mirror) — each connected
   * chain counts as one guide. Every guide must pass through every profile.
   * Composes with start/end conditions (the condition fades out around each
   * guide's contact point — rails win locally, the condition shapes the
   * rest). Cannot be combined with thin mode.
   * @param guides - Sketches or edges forming the guide curves.
   */
  guides(...guides: ISceneObject[]): this;

  /**
   * Constrains how the surface leaves the first profile.
   * @param type - `'none'`, `'normal'` or `'tangent'` — see {@link LoftConditionType}.
   * @param magnitude - Scales the takeoff strength; defaults to 1. Negative
   * values flip the direction (e.g. inward instead of outward for `'tangent'`).
   */
  startCondition(type: LoftConditionType, magnitude?: NumberParam): this;

  /**
   * Constrains how the surface arrives at the last profile.
   * @param type - `'none'`, `'normal'` or `'tangent'` — see {@link LoftConditionType}.
   * @param magnitude - Scales the arrival strength; defaults to 1. Negative
   * values flip the direction (e.g. inward instead of outward for `'tangent'`).
   */
  endCondition(type: LoftConditionType, magnitude?: NumberParam): this;

  /**
   * Selects faces on the first profile plane of the loft.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects faces on the last profile plane of the loft.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects the lateral faces generated between loft profiles.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the first profile plane of the loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the last profile plane of the loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Enables thin loft mode — offsets the profile edges of each section to create a
   * thin-walled shell instead of lofting filled faces. All profiles must be sketches
   * and share the same topology. Positive values offset outward, negative offsets inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: NumberParam): this;

  /**
   * Enables thin loft mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: NumberParam, offset2: NumberParam): this;

  /**
   * Selects faces created inside the solid during loft (e.g., the inner
   * wall of a thin-walled loft from closed profiles).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges bounding the internal geometry created during loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the cap faces at the open ends of a thin-walled loft from open profiles.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the cap faces of a thin-walled loft from open profiles.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;
}

/** Which end of a sweep path to extend. */
export type SweepSide = "start" | "end";

export interface ISweep extends IBooleanOperation {
  /**
   * Selects faces at the start (profile plane) of the sweep.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects faces at the end of the sweep path.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects the lateral faces generated by sweeping the profile along the path.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the start faces of the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the end faces of the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects faces created inside the solid during the sweep (e.g., from holes).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges bounding the internal geometry created during the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Applies a draft (taper) angle to the sweep walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: NumberParam | [NumberParam, NumberParam]): this;

  /**
   * Offsets the end face by a specified distance along the sweep direction.
   * @param value - The offset distance.
   */
  endOffset(value: NumberParam): this;

  /**
   * Extends the swept solid beyond the path at the given end by `amount`,
   * continuing straight along the path's tangent direction there. Chain twice to
   * extend both ends, e.g. `.extend('start', 10).extend('end', 5)`.
   * @param side - Which end of the path to extend: `'start'` or `'end'`.
   * @param amount - Distance to extend, in mm (positive; non-positive is a no-op).
   */
  extend(side: SweepSide, amount: NumberParam): this;

  /**
   * Enables or disables drill mode.
   * @param value - `true` to enable (default), `false` to disable.
   */
  drill(value?: boolean): this;

  /**
   * Restricts the sweep to particular regions of the profile sketch, named
   * by the sketch entities on their outer loop (`'c1 c2-'`) or by position
   * in the sketch's region list. See `IExtrude.region`.
   * @param keys - Region keys, or positions in the sketch's region list.
   */
  region(...keys: (string | number)[]): this;

  /**
   * Enables thin sweep mode — offsets the profile edges to create a thin-walled
   * swept shell instead of sweeping filled faces. Positive values offset outward,
   * negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: NumberParam): this;

  /**
   * Enables thin sweep mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: NumberParam, offset2: NumberParam): this;

  /**
   * Selects the cap faces at the open ends of a thin-walled sweep from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the cap faces of a thin-walled sweep from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;
}

/**
 * One grid slot of a 2D copy: a whole-geometry operand (offset, fillet)
 * AND — when the slot holds exactly one solver-backed edge — a constraint
 * target. Constraining an instance moves its source (and every sibling
 * duplicate) through the copy's rigid transform; the original's slot
 * resolves to the source statement itself.
 */
export interface ICopyInstance extends ISceneObject {
  /**
   * The instance's start point as a constraint target
   * (e.g. `distance(cp.instance(2).start(), origin(), 40)`).
   */
  start(): LazyVertex;

  /** The instance's end point as a constraint target. */
  end(): LazyVertex;

  /** The instance's center point (circles and arcs) as a constraint target. */
  center(): LazyVertex;
}

export interface ICopy extends ISceneObject {
  /**
   * Selects one grid slot of a 2D (in-sketch) copy as a whole geometry —
   * every edge at that position, usable wherever a whole geometry operand is
   * accepted (e.g. `offset(2, cp.instance(1))`). The copy owns only the
   * duplicates it stamps; the original keeps its own statement, and its slot
   * resolves through that source geometry. Linear copies linearize the grid
   * in axis order (the first axis varies slowest), with the original at its
   * own slot — 0 when not centered, the center slot when centered. Circular
   * copies count rotation steps with the original at 0, the same numbering
   * the `skip` option uses. 3D copies do not support this accessor.
   *
   * When the slot holds exactly one solver-backed edge (a copied
   * line/arc/circle/point statement) the instance is also a constraint
   * target: `parallel(cp.instance(1), l)` constrains the slot's duplicate
   * entity, which is rigidly tied to its source — the source (and every
   * other duplicate) moves with it. The ORIGINAL's slot resolves to the
   * source statement's own entity, so constraining it is constraining the
   * source. Slots with several edges, skipped slots, and slots whose source
   * carries no solver identity (offset results, nested copies) error as
   * constraint targets while remaining valid whole-geometry operands.
   * @param index - The grid-slot index.
   */
  instance(index: number): ICopyInstance;
}

/**
 * One instance of a 3D `repeat()` pattern. As a whole it is the repeated
 * geometry at that slot — a whole-geometry operand (`fillet(2, r.instance(1))`)
 * and a `from()` scope (`select(edge().from(r.instance(1)).circle())`).
 * When the repeat clones exactly one feature per instance, the instance
 * also forwards that feature's bucket accessors: `r.instance(1).endEdges()`
 * is the clone's own end-edge bucket, with the same index and filter
 * arguments the original's accessor takes.
 */
export interface IRepeatInstance extends ISelection {
  /**
   * The repeated feature's start faces at this instance.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's end (cap) faces at this instance.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's start edges at this instance.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's end (cap) edges at this instance.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's side faces at this instance.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's side edges at this instance.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's internal faces at this instance.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's internal edges at this instance.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's cap faces at this instance (thin-walled extrudes).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's cap edges at this instance (thin-walled extrudes).
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * The repeated feature's section edges at this instance, by index.
   * @param indices - Edge indices within the section-edge bucket.
   */
  edges(...indices: number[]): ISelection;
}

/**
 * A 3D `repeat()` — linear, circular, mirror, rotate or matrix. Its
 * instances are addressable by slot, so one clone of a pattern can be
 * selected without describing its position numerically.
 */
export interface IRepeat extends ISceneObject {
  /**
   * Selects one instance of the pattern: the repeated features at that slot
   * as a whole geometry, plus their forwarded bucket accessors when the
   * repeat clones a single feature (`r.instance(1).endEdges()`). Slot 0 is
   * the original for circular, mirror, rotate and matrix repeats. Linear
   * repeats linearize the grid in axis order (the first axis varies
   * slowest) with the original at its own slot — 0 when not centered, the
   * center slot when centered — the same numbering the `skip` option uses;
   * a skipped slot is an error.
   * @param index - The slot index.
   */
  instance(index: number): IRepeatInstance;
}

export interface IMirror extends IBooleanOperation {
  /**
   * Excludes the given objects from the mirror operation. Useful when
   * mirroring "everything" but a few specific objects should be skipped,
   * or when narrowing an explicit target list.
   * @param objects - The objects to exclude from mirroring.
   */
  exclude(...objects: ISceneObject[]): this;
}

export interface IMirrorInstance extends ISceneObject {
  /**
   * The image's start point as a constraint target
   * (e.g. `coincident(m.instance(l).start(), p)`).
   */
  start(): LazyVertex;

  /** The image's end point as a constraint target. */
  end(): LazyVertex;

  /** The image's center point (circles and arcs) as a constraint target. */
  center(): LazyVertex;
}

export interface IMirror2D extends IGeometry {
  /**
   * The mirror image of one mirrored statement — a whole-geometry operand
   * (`offset(2, m.instance(l))`) and a constraint target: the image of a
   * line/arc/circle/point statement is a solver entity rigidly tied to its
   * source across the mirror line, so `parallel(m.instance(l), k)` drives
   * the source (and, for a sketched mirror line, can move the line) through
   * the tie. Its `.start()`/`.end()`/`.center()` points are targets too.
   * The source is the statement itself (`m.instance(l)`, never one of its
   * points), a copy instance (`m.instance(cp.instance(2))`), or another
   * mirror's instance. Geometry the mirror does not stamp — later in the
   * sketch, not among explicit targets — and sources without solver
   * identity (an offset result) error as constraint targets. The mirror
   * line itself has no image: constrain it directly.
   * @param source - The mirrored statement (or copy/mirror instance).
   */
  instance(source: ISceneObject): IMirrorInstance;
}

export interface ITranslate extends ISceneObject {
  /**
   * Excludes the given objects from the translate operation. Useful when
   * translating "everything" but a few specific objects should be skipped,
   * or when narrowing an explicit target list.
   * @param objects - The objects to exclude from translating.
   */
  exclude(...objects: ISceneObject[]): this;
}

export interface IRotate extends ISceneObject {
  /**
   * Excludes the given objects from the rotate operation. Useful when
   * rotating "everything" but a few specific objects should be skipped,
   * or when narrowing an explicit target list.
   * @param objects - The objects to exclude from rotating.
   */
  exclude(...objects: ISceneObject[]): this;
}

export interface IDraft extends ISceneObject {}

export interface IRib extends IBooleanOperation {
  /**
   * Selects faces at the start (base) of the rib — the profile face at the sketch plane.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects faces at the end (top) of the rib — where the rib meets the boundary.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects the lateral wall faces of the rib.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects the small cap faces at the spine endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the start faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the cap faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Applies a draft (taper) angle to the rib walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: NumberParam | [NumberParam, NumberParam]): this;

  /**
   * Switches the extrusion direction to parallel to the sketch plane
   * (perpendicular to the spine within the plane) instead of normal to it.
   */
  parallel(): this;

  /**
   * Extends the rib's side faces at the spine endpoints outward to blend
   * with the target solids' walls.
   */
  extend(): this;
}

export interface IWrap extends IBooleanOperation {
  /**
   * Selects the faces lying on the target surface (the base of the wrap).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects the raised (or recessed) faces offset from the target surface by the wrap thickness.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the base faces of the wrap.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the offset faces of the wrap.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the wall faces created from the outer boundary of each wrapped region.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges on the wall faces, excluding edges shared with base/offset faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Selects the wall faces created from holes inside a wrapped region.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges bounding the hole walls of the wrap.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Enables or disables drill mode, which partitions the sketch into face regions
   * before wrapping.
   * @param value - `true` to enable (default), `false` to disable.
   */
  drill(value?: boolean): this;

  /**
   * Restricts wrapping to particular regions of the sketch, named by the
   * sketch entities on their outer loop (`'c1 c2-'`) or by position in the
   * sketch's region list. See `IExtrude.region`.
   * @param keys - Region keys, or positions in the sketch's region list.
   */
  region(...keys: (string | number)[]): this;
}

export type ShellJoinType = 'arc' | 'intersection' | 'tangent';

export interface IShell extends ISceneObject {
  /**
   * Selects the inner wall faces created by the shell operation (from thickness removal).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISelection;

  /**
   * Selects edges created by the shell operation that are not from the original solid
   * or on the opening rim.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISelection;

  /**
   * Sets the join type used at inner-wall corners.
   * @param type - `'arc'` (default) for rounded blends, `'intersection'` for sharp corners,
   *   or `'tangent'` for tangent-continuous blends.
   */
  join(type: ShellJoinType): this;
}

/**
 * A 3D helix wire — a single edge that traces a helix curve on a cylindrical or
 * conical surface. Used as a path for `sweep()` to produce springs, threads, and
 * coils.
 *
 * Created from one of:
 * - An axis (`AxisLike`): user supplies geometry via chained config.
 * - A cylindrical or conical face: axis + radii + height derived from the face.
 * - A line edge: axis = the line, height = line length.
 * - A circular edge: axis = circle normal, radius = circle radius.
 */
export interface IHelix extends ISceneObject {
  /**
   * Axial rise per turn (distance along the helix axis covered per full revolution).
   * If unset, derived from `height / turns`.
   */
  pitch(pitch: number): this;

  /**
   * Number of full turns. Fractional values are allowed. Default 1.
   */
  turns(turns: number): this;

  /**
   * Shifts the start of the helix along its axis, in axial mm. Positive values
   * trim the start (move it toward the end); negative values extend it. Default 0.
   */
  startOffset(offset: number): this;

  /**
   * Extends (positive) or trims (negative) the helix at its end, in axial mm.
   * Default 0.
   */
  endOffset(offset: number): this;

  /**
   * Total axial height. Overrides face/edge-derived height when set. For line-edge
   * input, defaults to the line length. For circular-edge / pure-axis input,
   * defaults to 50 if neither this nor `pitch * turns` determine it.
   */
  height(height: number): this;

  /**
   * Start radius. Defaults to 20 for axis/line-edge input. For a cylindrical
   * face input, defaults to the face's radius and may be overridden (useful for
   * sweep/fuse workflows where the helix tube must overlap the cylinder
   * volumetrically — offset by ~1mm to avoid pure tangency). Ignored on
   * conical face input (radius is derived from face geometry).
   */
  radius(radius: number): this;

  /**
   * End radius — when different from `radius()`, produces a conical helix.
   * Defaults to `radius()`. Ignored on face/circle inputs.
   */
  endRadius(radius: number): this;

  /**
   * Winds the helix counter-clockwise (right-handed) about its axis — viewed
   * from the axis tip looking back toward the origin — instead of the default
   * clockwise (left-handed) winding.
   */
  ccw(): this;
}
