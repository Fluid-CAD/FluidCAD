import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { pixelToSketchThreshold } from '../sketch-plane-utils';

export type ConnectionHit = {
  point: [number, number];
  tangent: [number, number];
  hitZone: 'start' | 'end';
};

export const CONNECTABLE_TYPES = new Set([
  'line-two-points', 'hline', 'vline',
  'arc',
  'tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent',
  'tline',
]);

export function meshToSketch2D(vertices: number[], plane: PlaneData): [number, number][] {
  const ox = plane.origin.x, oy = plane.origin.y, oz = plane.origin.z;
  const xx = plane.xDirection.x, xy = plane.xDirection.y, xz = plane.xDirection.z;
  const yx = plane.yDirection.x, yy = plane.yDirection.y, yz = plane.yDirection.z;
  const result: [number, number][] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const rx = vertices[i] - ox, ry = vertices[i + 1] - oy, rz = vertices[i + 2] - oz;
    result.push([rx * xx + ry * xy + rz * xz, rx * yx + ry * yy + rz * yz]);
  }
  return result;
}

export function tangentFromVertices(
  verts: [number, number][],
  hitZone: 'start' | 'end',
): [number, number] | null {
  let dx: number, dy: number;
  if (hitZone === 'end') {
    const a = verts[verts.length - 2];
    const b = verts[verts.length - 1];
    dx = b[0] - a[0];
    dy = b[1] - a[1];
  } else {
    const a = verts[0];
    const b = verts[1];
    dx = a[0] - b[0];
    dy = a[1] - b[1];
  }
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) {
    return null;
  }
  return [dx / len, dy / len];
}

export function findConnectionGeometry(
  point2d: [number, number],
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
  ctx: SceneContext,
): ConnectionHit | null {
  const threshold = pixelToSketchThreshold(ctx, 12);
  const thresholdSq = threshold * threshold;

  let bestHit: ConnectionHit | null = null;
  let bestDistSq = Infinity;

  for (const child of sceneObjects) {
    if (child.parentId !== sketchId || !child.sourceLocation) {
      continue;
    }
    if (!CONNECTABLE_TYPES.has(child.uniqueType ?? '')) {
      continue;
    }

    for (const part of child.sceneShapes) {
      if (part.isMetaShape) {
        continue;
      }
      for (const mesh of part.meshes) {
        const verts = meshToSketch2D(mesh.vertices, plane);
        if (verts.length < 2) {
          continue;
        }

        const startV = verts[0];
        const endV = verts[verts.length - 1];

        const edx = endV[0] - point2d[0];
        const edy = endV[1] - point2d[1];
        const endDist = edx * edx + edy * edy;
        if (endDist < thresholdSq && endDist < bestDistSq) {
          const tangent = tangentFromVertices(verts, 'end');
          if (tangent) {
            bestHit = { point: endV, tangent, hitZone: 'end' };
            bestDistSq = endDist;
          }
        }

        const sdx = startV[0] - point2d[0];
        const sdy = startV[1] - point2d[1];
        const startDist = sdx * sdx + sdy * sdy;
        if (startDist < thresholdSq && startDist < bestDistSq) {
          const tangent = tangentFromVertices(verts, 'start');
          if (tangent) {
            bestHit = { point: startV, tangent, hitZone: 'start' };
            bestDistSq = startDist;
          }
        }
      }
    }
  }

  return bestHit;
}
