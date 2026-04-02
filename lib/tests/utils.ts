import { Scene } from "../rendering/scene.js";
import { Solid } from "../common/solid.js";
import { Edge } from "../common/edge.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { Face } from "../common/face.js";

export function countShapes(scene: Scene): number {
  return scene.getRenderedObjects().reduce((acc, obj) => acc + obj.sceneShapes.length, 0);
}

export function getEdgesByType(solid: Solid, curveType: EdgeProperties["curveType"]): Edge[] {
  return solid.getEdges().filter(e => EdgeProps.getProperties(e.getShape()).curveType === curveType);
}

export function getFacesByType(solid: Solid, surfaceType: FaceProperties["surfaceType"]): Face[] {
  return solid.getFaces().filter(f => FaceProps.getProperties(f.getShape()).surfaceType === surfaceType);
}
