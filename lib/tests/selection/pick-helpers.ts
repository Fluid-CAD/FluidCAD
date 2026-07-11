import { expect } from "vitest";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Edge } from "../../common/edge.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import type { PickRef } from "../../selection/types.js";

export function findSolids(scene: Scene): Shape[] {
  const solids: Shape[] = [];
  const seen = new Set<string>();
  for (const obj of scene.getAllSceneObjects()) {
    if (obj.isContainer()) {
      continue; // containers re-expose their children's shapes
    }
    for (const shape of obj.getShapes()) {
      if (shape.getType() === "solid" && !seen.has(shape.id)) {
        seen.add(shape.id);
        solids.push(shape);
      }
    }
  }
  return solids;
}

export function findSolid(scene: Scene): Shape {
  const solids = findSolids(scene);
  expect(solids.length).toBeGreaterThan(0);
  return solids[0];
}

export function allEdgeRefs(solid: Shape): PickRef[] {
  return Explorer.findEdgesWrapped(solid).map((_, index) => ({
    shapeId: solid.id,
    sub: { type: 'edge' as const, index },
  }));
}

/** Refs of the solid's edges whose midpoint satisfies `where`. */
export function edgeRefsWhere(solid: Shape, where: (mid: { x: number; y: number; z: number }) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findEdgesWrapped(solid).forEach((e: Edge, index: number) => {
    const mid = EdgeOps.getEdgeMidPoint(e);
    if (where(mid)) {
      refs.push({ shapeId: solid.id, sub: { type: 'edge', index } });
    }
  });
  return refs;
}

export function setLocation(obj: unknown, line: number) {
  (obj as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line, column: 0 });
}

/** Refs of the solid's faces where every edge midpoint satisfies `where`. */
export function faceRefsWhere(solid: Shape, where: (mid: { x: number; y: number; z: number }) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findFacesWrapped(solid).forEach((f, index) => {
    const mids = f.getEdges().map(e => EdgeOps.getEdgeMidPoint(e));
    if (mids.length > 0 && mids.every(where)) {
      refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
    }
  });
  return refs;
}
