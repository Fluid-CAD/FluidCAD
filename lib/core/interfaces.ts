import type { LazyVertex } from "../features/lazy-vertex.js";
import type { Point2DLike, PointLike } from "../math/point.js";
import type { FaceFilterBuilder } from "../filters/face/face-filter.js";
import type { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import type { Matrix4 } from "../math/matrix4.js";
import type { AxisLike } from "../math/axis.js";
import type { PlaneLike } from "../math/plane.js";

export interface ISceneObject {
  /**
   * Sets a custom display name for this object, overriding the default type-based name.
   * @param value - The display name to assign.
   */
  name(value: string): this;

  /**
   * Marks this object as construction geometry. Guide objects are excluded from
   * final geometry output unless explicitly included.
   */
  guide(): this;

  /**
   * Marks this object as reusable. Reusable objects retain their shapes when
   * consumed by features (e.g., extrude, revolve), allowing multiple features
   * to reference the same source geometry. Use `remove(obj)` to force-remove
   * shapes from a reusable object.
   */
  reusable(): this;
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
  translate(x: number): this;
  /**
   * Translate along X and Y.
   */
  translate(x: number, y: number): this;
  /**
   * Translate along X, Y, and Z.
   */
  translate(x: number, y: number, z: number): this;
  /**
   * Translate by a point-like offset in world space.
   */
  translate(offset: PointLike): this;

  /**
   * Rotate by an angle around world Z through the origin.
   * @param angle - Rotation in degrees.
   */
  rotate(angle: number): this;
  /**
   * Rotate around an axis by an angle.
   * @param axis - The axis to rotate around. Use `local(...)` to reference a sketch-local axis.
   * @param angle - Rotation in degrees.
   */
  rotate(axis: AxisLike, angle: number): this;

  /**
   * Mirror across a plane.
   */
  mirror(plane: PlaneLike): this;
  /**
   * Mirror across an axis (primarily useful for 2D geometry).
   */
  mirror(axis: AxisLike): this;
}

export interface IPlane extends ISceneObject {}

export interface IAxis extends ISceneObject {}

export interface ISelect extends ISceneObject {}

export interface IGeometry extends ISceneObject {
  /**
   * Returns a lazy-evaluated vertex at the start point of this geometry element.
   */
  start(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex at the end point of this geometry element.
   */
  end(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex representing the tangent direction at the end
   * of this geometry. Used to determine the direction of subsequent geometry elements.
   */
  tangent(): LazyVertex;
}

export interface IExtrudableGeometry extends IGeometry {}

export interface IOffset extends IExtrudableGeometry {
  /**
   * Closes an open offset by joining it back to the source wire with
   * straight cap edges at each endpoint. Has no effect when the offset
   * is already closed. Cannot be combined with `removeOriginal=true`.
   */
  close(): this;
}

export interface IArcPoints extends IExtrudableGeometry {
  /**
   * Sets the bulge radius for point-to-point arcs.
   * Positive = CCW, negative = CW.
   * @param value - The bulge radius.
   */
  radius(value: number): this;

  /**
   * Specifies the circle center point for the arc.
   * Mutually exclusive with `.radius()`.
   * @param value - The center point of the arc's circle.
   */
  center(value: Point2DLike): this;
}

export interface IArcAngles extends IExtrudableGeometry {
  /**
   * Centers the arc symmetrically around the start angle.
   */
  centered(): this;
}

export interface IRect extends IExtrudableGeometry {
  /**
   * Sets corner radii for a rounded rectangle. Accepts 1–4 values
   * in order: `[bottomLeft, bottomRight, topRight, topLeft]`.
   * A single value applies to all corners.
   * @param r - One or more radius values.
   */
  radius(...r: number[]): this;

  /**
   * Controls how the rectangle is positioned relative to the current point.
   * @param value - `true` centers on both axes, `'horizontal'` or `'vertical'` centers
   *   on one axis, `false` (default) keeps the current point as the origin corner.
   */
  centered(value?: boolean | 'horizontal' | 'vertical'): this;

  /**
   * Returns the top straight edge of the rectangle.
   */
  topEdge(): ISceneObject;

  /**
   * Returns the bottom straight edge of the rectangle.
   */
  bottomEdge(): ISceneObject;

  /**
   * Returns the left straight edge of the rectangle.
   */
  leftEdge(): ISceneObject;

  /**
   * Returns the right straight edge of the rectangle.
   */
  rightEdge(): ISceneObject;

  /**
   * Returns the arc edge at the top-left corner. Only present when a radius is applied.
   */
  topLeftArcEdge(): ISceneObject;

  /**
   * Returns the arc edge at the top-right corner. Only present when a radius is applied.
   */
  topRightArcEdge(): ISceneObject;

  /**
   * Returns the arc edge at the bottom-left corner. Only present when a radius is applied.
   */
  bottomLeftArcEdge(): ISceneObject;

  /**
   * Returns the arc edge at the bottom-right corner. Only present when a radius is applied.
   */
  bottomRightArcEdge(): ISceneObject;

  /**
   * Returns a lazy-evaluated vertex at the top-left corner.
   */
  topLeft(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex at the top-right corner.
   */
  topRight(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex at the bottom-left corner.
   */
  bottomLeft(): LazyVertex;

  /**
   * Returns a lazy-evaluated vertex at the bottom-right corner.
   */
  bottomRight(): LazyVertex;
}

export interface ISlot extends IExtrudableGeometry {
  /**
   * Controls whether the slot is centered on the current position.
   * When `true`, the slot is offset backward by half its length.
   * @param value - `true` to center, `false` (default) to start from the current position.
   */
  centered(value?: boolean): this;

  /**
   * Sets the rotation angle of the slot's primary axis.
   * @param angle - Rotation in degrees.
   */
  rotate(angle: number): this;
}

export interface IALine extends IGeometry {
  /**
   * Controls whether the line is centered on the current position.
   * When `true`, the line is offset backward by half its length so that the
   * current position falls at its midpoint.
   * @param value - `true` to center, `false` (default) to start from the current position.
   */
  centered(value?: boolean): this;
}

export interface IHLine extends IGeometry {
  /**
   * Controls whether the line is centered on the current position.
   * When `true`, the line is offset backward by half its length so that the
   * current position falls at its midpoint.
   * @param value - `true` to center, `false` (default) to start from the current position.
   */
  centered(value?: boolean): this;
}

export interface IVLine extends IGeometry {
  /**
   * Controls whether the line is centered on the current position.
   * When `true`, the line is offset backward by half its length so that the
   * current position falls at its midpoint.
   * @param value - `true` to center, `false` (default) to start from the current position.
   */
  centered(value?: boolean): this;
}

export interface IPolygon extends IExtrudableGeometry {
  /**
   * Returns a specific edge of the polygon by index.
   * @param index - Zero-based edge index.
   */
  getEdge(index: number): ISceneObject;

  /**
   * Returns a lazy-evaluated vertex at a specific corner of the polygon.
   * @param index - Zero-based vertex index.
   */
  getVertex(index: number): LazyVertex;
}

export interface ITwoObjectsTangentLine extends IGeometry {
  /**
   * Returns the start vertex of the tangent line.
   * @param index - Solution index when multiple tangent lines exist (defaults to 0).
   */
  start(index?: number): LazyVertex;

  /**
   * Returns the end vertex of the tangent line.
   * @param index - Solution index when multiple tangent lines exist (defaults to 0).
   */
  end(index?: number): LazyVertex;
}

export interface ITangentArcTwoObjects extends IGeometry {
  /**
   * Returns the start vertex of the tangent arc.
   * @param index - Solution index when multiple tangent arcs exist (defaults to 0).
   */
  start(index?: number): LazyVertex;

  /**
   * Returns the end vertex of the tangent arc.
   * @param index - Solution index when multiple tangent arcs exist (defaults to 0).
   */
  end(index?: number): LazyVertex;
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
  startFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects faces at the end (cap) of the extrusion.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the start (base) faces of the extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the end (cap) faces of the extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects the lateral faces created by the extrusion.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects faces created inside the solid during extrusion (e.g., from holes or intersections).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges bounding the internal geometry created during extrusion.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects the cap faces at the open ends of a thin-walled extrusion from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the cap faces of a thin-walled extrusion from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Applies a draft (taper) angle to the extrusion walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: number | [number, number]): this;

  /**
   * Offsets the end face by a specified distance along the extrusion direction.
   * @param value - The offset distance.
   */
  endOffset(value: number): this;

  /**
   * Enables or disables drill mode, which partitions the sketch into face regions
   * before extruding.
   * @param value - `true` to enable (default), `false` to disable.
   */
  drill(value?: boolean): this;

  /**
   * Restricts extrusion to only the sketch regions containing the given points.
   * @param points - 2D points in the sketch plane identifying regions to extrude.
   */
  pick(...points: Point2DLike[]): this;

  /**
   * Enables thin extrude mode — offsets the profile edges to create a thin-walled solid
   * instead of extruding filled faces. Positive values offset outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: number): this;

  /**
   * Enables thin extrude mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: number, offset2: number): this;
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
  draft(value: number | [number, number]): this;

  /**
   * Offsets the cut end face by a specified distance along the cut direction.
   * @param value - The offset distance.
   */
  endOffset(value: number): this;

  /**
   * Selects edges at the start of the cut path, classified by signed distance from the cut plane.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges at the end of the cut path, classified by signed distance from the cut plane.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects internal edges created by the cut that are not on the cut plane boundary.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects internal faces exposed by the cut — newly created surfaces not from the original stock.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Restricts the cut to only the sketch regions containing the given points.
   * @param points - 2D points in the sketch plane identifying regions to cut.
   */
  pick(...points: Point2DLike[]): this;

  /**
   * Enables thin cut mode — offsets the profile edges to cut a thin-walled shape
   * instead of cutting filled faces. Positive values offset outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: number): this;

  /**
   * Enables thin cut mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: number, offset2: number): this;
}

export interface IRevolve extends IBooleanOperation {
  /**
   * Enables symmetric mode — revolves equally in both directions from the sketch plane.
   */
  symmetric(): this;
  /**
   * Restricts the revolve to only the sketch regions containing the given points.
   * @param points - 2D points in the sketch plane identifying regions to revolve.
   */
  pick(...points: Point2DLike[]): this;

  /**
   * Enables thin revolve mode — offsets the profile edges to create a thin-walled
   * solid of revolution instead of revolving filled faces. Positive values offset
   * outward, negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: number): this;

  /**
   * Enables thin revolve mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: number, offset2: number): this;

  /**
   * Selects faces created inside the solid during revolution (e.g., the inner
   * wall of a thin-walled revolve from a closed profile).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges bounding the internal geometry created during revolution.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects the cap faces at the open ends of a thin-walled revolve from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the cap faces of a thin-walled revolve from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
}

export interface ILoft extends IBooleanOperation {
  /**
   * Selects faces on the first profile plane of the loft.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects faces on the last profile plane of the loft.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects the lateral faces generated between loft profiles.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the first profile plane of the loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the last profile plane of the loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Enables thin loft mode — offsets the profile edges of each section to create a
   * thin-walled shell instead of lofting filled faces. All profiles must be sketches
   * and share the same topology. Positive values offset outward, negative offsets inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: number): this;

  /**
   * Enables thin loft mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: number, offset2: number): this;

  /**
   * Selects faces created inside the solid during loft (e.g., the inner
   * wall of a thin-walled loft from closed profiles).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges bounding the internal geometry created during loft.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects the cap faces at the open ends of a thin-walled loft from open profiles.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the cap faces of a thin-walled loft from open profiles.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
}

export interface ISweep extends IBooleanOperation {
  /**
   * Selects faces at the start (profile plane) of the sweep.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  startFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects faces at the end of the sweep path.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  endFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects the lateral faces generated by sweeping the profile along the path.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the start faces of the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the end faces of the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the side faces, excluding edges shared with start/end faces.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Selects faces created inside the solid during the sweep (e.g., from holes).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges bounding the internal geometry created during the sweep.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;

  /**
   * Applies a draft (taper) angle to the sweep walls.
   * @param value - A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft.
   */
  draft(value: number | [number, number]): this;

  /**
   * Offsets the end face by a specified distance along the sweep direction.
   * @param value - The offset distance.
   */
  endOffset(value: number): this;

  /**
   * Enables or disables drill mode.
   * @param value - `true` to enable (default), `false` to disable.
   */
  drill(value?: boolean): this;

  /**
   * Restricts the sweep to only the sketch regions containing the given points.
   * @param points - 2D points in the sketch plane identifying regions to sweep.
   */
  pick(...points: Point2DLike[]): this;

  /**
   * Enables thin sweep mode — offsets the profile edges to create a thin-walled
   * swept shell instead of sweeping filled faces. Positive values offset outward,
   * negative values offset inward.
   * @param offset - The wall offset distance. Positive = outward, negative = inward.
   */
  thin(offset: number): this;

  /**
   * Enables thin sweep mode with two offset directions.
   * The two offsets must go in opposite directions. If both have the same sign,
   * the second offset is automatically flipped.
   * @param offset1 - The first wall offset distance. Positive = outward, negative = inward.
   * @param offset2 - The second wall offset distance, in the opposite direction of offset1.
   */
  thin(offset1: number, offset2: number): this;

  /**
   * Selects the cap faces at the open ends of a thin-walled sweep from an open profile.
   * These are the small faces connecting the inner and outer walls at the profile endpoints.
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  capFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges on the cap faces of a thin-walled sweep from an open profile.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  capEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
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

export interface IShell extends ISceneObject {
  /**
   * Selects the inner wall faces created by the shell operation (from thickness removal).
   * @param args - Numeric indices or {@link FaceFilterBuilder} instances to filter the selection.
   */
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;

  /**
   * Selects edges created by the shell operation that are not from the original solid
   * or on the opening rim.
   * @param args - Numeric indices or {@link EdgeFilterBuilder} instances to filter the selection.
   */
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
}
