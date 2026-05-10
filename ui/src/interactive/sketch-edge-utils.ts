import { PlaneData, SceneObjectRender } from '../types';

export type EdgeEntry = {
  shapeId: string;
  segments: { ax: number; ay: number; bx: number; by: number }[];
  endpoints: [number, number, number][];
};

export function buildEdgeIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
): EdgeEntry[] {
  const result: EdgeEntry[] = [];
  const ox = plane.origin.x, oy = plane.origin.y, oz = plane.origin.z;
  const xx = plane.xDirection.x, xy = plane.xDirection.y, xz = plane.xDirection.z;
  const yx = plane.yDirection.x, yy = plane.yDirection.y, yz = plane.yDirection.z;

  const hasTrimMeta = sceneObjects.some(obj =>
    obj.parentId === sketchId &&
    obj.sceneShapes.some(s => s.metaType === 'trim'),
  );

  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (!shape.shapeId) {
        continue;
      }
      if (hasTrimMeta) {
        if (shape.metaType !== 'trim') {
          continue;
        }
      } else {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }
      }
      const segments: EdgeEntry['segments'] = [];
      const endpoints: [number, number, number][] = [];

      for (const mesh of shape.meshes) {
        const verts = mesh.vertices;
        const indices = mesh.indices;
        if (!indices.length) {
          continue;
        }

        const count = new Map<number, number>();
        for (const idx of indices) {
          count.set(idx, (count.get(idx) || 0) + 1);
        }
        for (const [idx, c] of count) {
          if (c === 1) {
            endpoints.push([verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]]);
          }
        }

        for (let k = 0; k < indices.length; k += 2) {
          const ia = indices[k] * 3;
          const ib = indices[k + 1] * 3;

          const rax = verts[ia] - ox, ray = verts[ia + 1] - oy, raz = verts[ia + 2] - oz;
          const ax = rax * xx + ray * xy + raz * xz;
          const ay = rax * yx + ray * yy + raz * yz;

          const rbx = verts[ib] - ox, rby = verts[ib + 1] - oy, rbz = verts[ib + 2] - oz;
          const bx = rbx * xx + rby * xy + rbz * xz;
          const by = rbx * yx + rby * yy + rbz * yz;

          segments.push({ ax, ay, bx, by });
        }
      }

      if (segments.length > 0) {
        result.push({ shapeId: shape.shapeId, segments, endpoints });
      }
    }
  }

  return result;
}

export function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  return closestPointOnSegment(px, py, ax, ay, bx, by).dist;
}

export function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let cx: number;
  let cy: number;

  if (lenSq === 0) {
    cx = ax;
    cy = ay;
  } else {
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) {
      t = 0;
    } else if (t > 1) {
      t = 1;
    }
    cx = ax + t * dx;
    cy = ay + t * dy;
  }

  const ex = cx - px;
  const ey = cy - py;
  return { x: cx, y: cy, dist: Math.sqrt(ex * ex + ey * ey) };
}
