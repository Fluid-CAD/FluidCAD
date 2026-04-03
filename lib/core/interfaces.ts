import { LazyVertex } from "../features/lazy-vertex.js";
import { Point2DLike } from "../math/point.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";

/**
 * Base interface for all scene objects exposed to the end user.
 * Only user-facing methods are included.
 */
export interface ISceneObject {
  name(value: string): this;
  guide(): this;
  fuse(value: 'all' | 'none'): this;
  fuse(object: ISceneObject): this;
  fuse(...objects: ISceneObject[]): this;
}

/**
 * Interface for plane objects returned by the plane() builder.
 */
export interface IPlane extends ISceneObject {}

/**
 * Interface for axis objects returned by the axis() builder.
 */
export interface IAxis extends ISceneObject {}

/**
 * Interface for select objects returned by the select() builder
 * and by extrude/cut face/edge accessors.
 */
export interface ISelect extends ISceneObject {}

/**
 * Interface for 2D geometry objects returned by sketch geometry builders
 * (line, arc, hLine, vLine, aLine, move, connect, etc.).
 */
export interface IGeometry extends ISceneObject {
  start(): LazyVertex;
  end(): LazyVertex;
  tangent(): LazyVertex;
}

/**
 * Interface for extrudable 2D geometry objects
 * that can be passed directly to extrude()/cut()/revolve().
 */
export interface IExtrudableGeometry extends IGeometry {}

/**
 * Interface for rect objects returned by the rect() builder.
 */
export interface IRect extends IExtrudableGeometry {
  radius(...r: number[]): this;
  center(value?: boolean | 'horizontal' | 'vertical'): this;
  topEdge(): ISceneObject;
  bottomEdge(): ISceneObject;
  leftEdge(): ISceneObject;
  rightEdge(): ISceneObject;
  topLeftArcEdge(): ISceneObject;
  topRightArcEdge(): ISceneObject;
  bottomLeftArcEdge(): ISceneObject;
  bottomRightArcEdge(): ISceneObject;
  topLeft(): LazyVertex;
  topRight(): LazyVertex;
  bottomLeft(): LazyVertex;
  bottomRight(): LazyVertex;
}

/**
 * Interface for slot objects returned by the slot() builder.
 */
export interface ISlot extends IExtrudableGeometry {
  center(value?: boolean): this;
  rotate(angle: number): this;
}

/**
 * Interface for polygon objects returned by the polygon() builder.
 */
export interface IPolygon extends IExtrudableGeometry {
  getEdge(index: number): ISceneObject;
  getVertex(index: number): LazyVertex;
}

/**
 * Interface for constrained tangent line with index-based start/end.
 */
export interface ITwoObjectsTangentLine extends IGeometry {
  start(index?: number): LazyVertex;
  end(index?: number): LazyVertex;
}

/**
 * Interface for constrained tangent arc with index-based start/end.
 */
export interface ITangentArcTwoObjects extends IGeometry {
  start(index?: number): LazyVertex;
  end(index?: number): LazyVertex;
}

/**
 * Interface for common (intersection) results returned by the common() builder.
 */
export interface ICommon extends ISceneObject {
  keepOriginal(value?: boolean): this;
}

/**
 * Interface for extrude results returned by the extrude() builder.
 */
export interface IExtrude extends ISceneObject {
  startFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;
  endFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  sideFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;
  sideEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  draft(value: number | [number, number]): this;
  endOffset(value: number): this;
  drill(value?: boolean): this;
  pick(...points: Point2DLike[]): this;
}

/**
 * Interface for cut results returned by the cut() builder.
 */
export interface ICut extends ISceneObject {
  draft(value: number | [number, number]): this;
  endOffset(value: number): this;
  startEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  endEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  internalEdges(...args: (number | EdgeFilterBuilder)[]): ISceneObject;
  internalFaces(...args: (number | FaceFilterBuilder)[]): ISceneObject;
  pick(...points: Point2DLike[]): this;
}

/**
 * Interface for revolve results returned by the revolve() builder.
 */
export interface IRevolve extends ISceneObject {
  pick(...points: Point2DLike[]): this;
}
