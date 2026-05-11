import { Vector3 } from 'three';
import { Snapper, SnapResult } from './types';
import { PlaneData } from '../types';

const EXCLUSION_EPSILON_SQ = 1e-6;

export class VertexSnapper implements Snapper {
  private vertices2d: [number, number][] = [];
  private excluded: [number, number][] = [];
  private plane: PlaneData;

  constructor(vertices2d: [number, number][], plane: PlaneData) {
    this.vertices2d = vertices2d;
    this.plane = plane;
  }

  setExcluded(excluded: [number, number][]): void {
    this.excluded = excluded;
  }

  private isExcluded(v: [number, number]): boolean {
    for (const e of this.excluded) {
      const dx = v[0] - e[0];
      const dy = v[1] - e[1];
      if (dx * dx + dy * dy < EXCLUSION_EPSILON_SQ) {
        return true;
      }
    }
    return false;
  }

  snap(point2d: [number, number], threshold: number): SnapResult | null {
    let minDist = Infinity;
    let closest: [number, number] | null = null;

    for (const v of this.vertices2d) {
      if (this.isExcluded(v)) {
        continue;
      }
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
