import { LazyVertex } from "../features/lazy-vertex.js";
import { Point2DLike } from "../math/point.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";

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
   * Controls the fusion scope for this operation — determines which existing shapes
   * are merged with the result.
   *
   * @param value - `'all'` merges with every intersecting shape; `'none'` keeps the result separate.
   */
  fuse(value: 'all' | 'none'): this;
  /**
   * Merges the result of this operation with a specific object's shapes.
   * @param object - The target object to fuse with.
   */
  fuse(object: ISceneObject): this;
  /**
   * Merges the result of this operation with multiple specific objects' shapes.
   * @param objects - The target objects to fuse with.
   */
  fuse(...objects: ISceneObject[]): this;
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
  center(value?: boolean | 'horizontal' | 'vertical'): this;

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
  center(value?: boolean): this;

  /**
   * Sets the rotation angle of the slot's primary axis.
   * @param angle - Rotation in degrees.
   */
  rotate(angle: number): this;
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

export interface IExtrude extends ISceneObject {
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
}

export interface ICut extends ISceneObject {
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
}

export interface IRevolve extends ISceneObject {
  /**
   * Restricts the revolve to only the sketch regions containing the given points.
   * @param points - 2D points in the sketch plane identifying regions to revolve.
   */
  pick(...points: Point2DLike[]): this;
}

export interface ILoft extends ISceneObject {
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
}

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
