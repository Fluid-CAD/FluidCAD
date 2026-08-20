import { Vector3 } from 'three';
import { Snapper, SnapResult, SolvedVertexRef } from './types';
import { PlaneData } from '../types';

const EXCLUSION_EPSILON_SQ = 1e-6;

/** A snappable vertex; `ref` carries solved-sketch provenance (which entity
 * statement vertex this is) so tools can emit coincident constraints. */
export type VertexCandidate = {
  point: [number, number];
  ref?: SolvedVertexRef;
};

export class VertexSnapper implements Snapper {
  private candidates: VertexCandidate[] = [];
  private excluded: [number, number][] = [];
  private plane: PlaneData;

  constructor(candidates: VertexCandidate[], plane: PlaneData) {
    this.candidates = candidates;
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
    let closest: VertexCandidate | null = null;

    for (const c of this.candidates) {
      if (this.isExcluded(c.point)) {
        continue;
      }
      const dx = point2d[0] - c.point[0];
      const dy = point2d[1] - c.point[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < threshold && dist < minDist) {
        minDist = dist;
        closest = c;
      }
    }

    if (!closest) {
      return null;
    }

    return {
      point2d: closest.point,
      worldPoint: localToWorld(closest.point, this.plane),
      snapType: 'vertex',
      ...(closest.ref ? { ref: closest.ref } : {}),
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
