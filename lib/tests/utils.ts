import { Scene } from "../rendering/scene.js";
import { Solid } from "../common/solid.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { EdgeProps, EdgeProperties } from "../oc/edge-props.js";
import { FaceProps, FaceProperties } from "../oc/face-props.js";
import { Face } from "../common/face.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { BoundingBox } from "../helpers/types.js";
import { SceneObject } from "../common/scene-object.js";
import { ColoredSolids, type ColoredSolid } from "../common/colored-solid.js";
import type { FaceColorEntry } from "../common/face-color-view.js";

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

/**
 * The leaf object holding `solid` — the one whose face-colour records answer
 * for it. A solid two objects added (a copy's original, moved over as it is)
 * is the later one's.
 */
export function holderOf(scene: Scene, solid: Shape): SceneObject {
  let holder: SceneObject | undefined;
  for (const obj of scene.getAllSceneObjects()) {
    if (!obj.isContainer() && obj.getAddedShapes().includes(solid)) {
      holder = obj;
    }
  }
  if (!holder) {
    throw new Error(`No scene object holds solid ${solid.id}`);
  }
  return holder;
}

/** The resolved colour records of `solid` (scope-less), each with the statement that painted it. */
export function faceColorEntriesOf(scene: Scene, solid: Shape): FaceColorEntry[] {
  const view = holderOf(scene, solid).getFaceColors(solid);
  try {
    return [...view.entries()];
  } finally {
    view.delete();
  }
}

/** Face → colour for every painted face of `solid`, as its holder resolves them. */
export function faceColorsOf(scene: Scene, solid: Shape): Map<Face, string> {
  return new Map(faceColorEntriesOf(scene, solid).map(entry => [entry.face, entry.color]));
}

/** The colour `solid`'s holder resolves for `face`, or undefined when unpainted. */
export function colorOf(scene: Scene, solid: Shape, face: Face): string | undefined {
  return holderOf(scene, solid).faceColorOf(solid, face);
}

/** `solids` with the colours their holders resolve — what an export takes. */
export function coloredSolids(scene: Scene, solids: Solid[]): ColoredSolid[] {
  return solids.map(solid => ColoredSolids.fromHolder(holderOf(scene, solid), solid));
}
