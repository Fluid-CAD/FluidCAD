import { Scene } from "../rendering/scene.js";
import { Solid } from "../common/solid.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { Face } from "../common/face.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BoundingBox } from "../helpers/types.js";

export function countShapes(scene: Scene): number {
  return scene.getRenderedObjects().reduce((acc, obj) => acc + obj.sceneShapes.length, 0);
}

export function getEdgesByType(source: Solid | Shape[], curveType: EdgeProperties["curveType"]): Edge[] {
  const edges = Array.isArray(source)
    ? source.filter((s): s is Edge => s instanceof Edge)
    : source.getEdges();
  return edges.filter(e => EdgeProps.getProperties(e.getShape()).curveType === curveType);
}

export function getFacesByType(solid: Solid, surfaceType: FaceProperties["surfaceType"]): Face[] {
  return solid.getFaces().filter(f => FaceProps.getProperties(f.getShape()).surfaceType === surfaceType);
}

export function getBoundingBoxOfShapes(shapes: Shape[]): BoundingBox {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const shape of shapes) {
    const bbox = ShapeOps.getBoundingBox(shape);
    minX = Math.min(minX, bbox.minX);
    maxX = Math.max(maxX, bbox.maxX);
    minY = Math.min(minY, bbox.minY);
    maxY = Math.max(maxY, bbox.maxY);
    minZ = Math.min(minZ, bbox.minZ);
    maxZ = Math.max(maxZ, bbox.maxZ);
  }

  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}
