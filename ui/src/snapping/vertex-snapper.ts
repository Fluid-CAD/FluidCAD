import { Vector3 } from 'three';
import { Snapper, SnapResult } from './types';
import { PlaneData, Vec3Data } from '../types';

export class VertexSnapper implements Snapper {
  private vertices2d: [number, number][] = [];
  private plane: PlaneData;

  constructor(vertices2d: [number, number][], plane: PlaneData) {
    this.vertices2d = vertices2d;
    this.plane = plane;
  }

  snap(point2d: [number, number], threshold: number): SnapResult | null {
    let minDist = Infinity;
    let closest: [number, number] | null = null;

    for (const v of this.vertices2d) {
      const dx = point2d[0] - v[0];
      const dy = point2d[1] - v[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < threshold && dist < minDist) {
        minDist = dist;
        closest = v;
      }
    }

    if (!closest) {
      return null;
    }

    return {
      point2d: closest,
      worldPoint: localToWorld(closest, this.plane),
      snapType: 'vertex',
    };
  }
}

function localToWorld(point2d: [number, number], plane: PlaneData): Vector3 {
  const o = plane.origin;
  const x = plane.xDirection;
  const y = plane.yDirection;
  return new Vector3(
    o.x + x.x * point2d[0] + y.x * point2d[1],
    o.y + x.y * point2d[0] + y.y * point2d[1],
    o.z + x.z * point2d[0] + y.z * point2d[1],
  );
}
