import { Vector3 } from 'three';
import { Snapper, SnapResult } from './types';
import { VertexSnapper } from './vertex-snapper';
import { GridSnapper } from './grid-snapper';
import { PlaneData, SceneObjectRender } from '../types';

const DEFAULT_SNAP_THRESHOLD = 15;

export class SnapManager {
  private snappers: Snapper[] = [];
  private threshold: number;

  constructor(snappers: Snapper[], threshold: number = DEFAULT_SNAP_THRESHOLD) {
    this.snappers = snappers;
    this.threshold = threshold;
  }

  snap(point2d: [number, number], plane: PlaneData): SnapResult {
    // Try each snapper in priority order; first match wins
    for (const snapper of this.snappers) {
      const result = snapper.snap(point2d, this.threshold);
      if (result) {
        return result;
      }
    }

    // No snap — return the original point
    const o = plane.origin;
    const x = plane.xDirection;
    const y = plane.yDirection;

    return {
      point2d,
      worldPoint: new Vector3(
        o.x + x.x * point2d[0] + y.x * point2d[1],
        o.y + x.y * point2d[0] + y.y * point2d[1],
        o.z + x.z * point2d[0] + y.z * point2d[1],
      ),
      snapType: 'none',
    };
  }

  static fromSceneObjects(
    sceneObjects: SceneObjectRender[],
    sketchId: string,
    plane: PlaneData,
  ): SnapManager {
    // Extract vertex positions from sketch child mesh data
    const vertices2d: [number, number][] = [];
    const EPSILON_SQ = 1e-6;

    for (const obj of sceneObjects) {
      if (obj.parentId !== sketchId || !obj.sceneShapes.length) {
        continue;
      }

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }

        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          // Find topological endpoints (vertices appearing once in line-segment pairs)
          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          for (const [idx, c] of count) {
            if (c === 1) {
              const wx = meshData.vertices[idx * 3];
              const wy = meshData.vertices[idx * 3 + 1];
              const wz = meshData.vertices[idx * 3 + 2];

              // Convert world → 2D sketch coordinates
              const rx = wx - plane.origin.x;
              const ry = wy - plane.origin.y;
              const rz = wz - plane.origin.z;
              const u = rx * plane.xDirection.x + ry * plane.xDirection.y + rz * plane.xDirection.z;
              const v = rx * plane.yDirection.x + ry * plane.yDirection.y + rz * plane.yDirection.z;

              // Deduplicate
              const isDup = vertices2d.some(
                p => (p[0] - u) * (p[0] - u) + (p[1] - v) * (p[1] - v) < EPSILON_SQ,
              );
              if (!isDup) {
                vertices2d.push([u, v]);
              }
            }
          }
        }
      }
    }

    // Priority order: vertex snap first, then grid snap
    const snappers: Snapper[] = [
      new VertexSnapper(vertices2d, plane),
      new GridSnapper(plane),
    ];

    return new SnapManager(snappers);
  }
}
