import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { SceneObject } from "../common/scene-object.js";
import { Wire } from "../common/wire.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Plane } from "../math/plane.js";

export type BoundingBox = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  [key: string]: any;
};

export type FaceInfo = {
  face: Face;
  wire: Wire;
  bbox: BoundingBox;
  diagonal: number;
  holes?: FaceInfo[];
}

export interface Extrudable extends SceneObject {
  getGeometries(includeRemoved?: boolean): Edge[];
  getGeometriesWithOwner(includeRemoved?: boolean): Map<Edge, GeometrySceneObject>;
  getPlane(): Plane;
}
