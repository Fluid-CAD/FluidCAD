import { Vector3 } from 'three';
import { Snapper, SnapResult } from './types';
import { PlaneData } from '../types';

/**
 * Snap onto the sketch's datum axes (x = 0 / y = 0): zeroes the near
 * coordinate, the other follows the cursor. Solved sketches with datums
 * only. Ranked between vertex and grid snapping — a true vertex (incl. the
 * origin) wins, the lattice loses. Reports `snapType: 'vertex'` (it is a
 * ref-carrying snap and shares the vertex gating/color); the `ref.datum`
 * lets tools emit `coincident(p, xAxis()/yAxis())`.
 */
export class AxisSnapper implements Snapper {
  constructor(private plane: PlaneData) {}

  snap(point2d: [number, number], threshold: number): SnapResult | null {
    const [x, y] = point2d;
    const toX = Math.abs(y); // distance to the x axis (y = 0)
    const toY = Math.abs(x); // distance to the y axis (x = 0)
    if (toX > threshold && toY > threshold) {
      return null;
    }
    const onX = toX <= toY;
    const snapped: [number, number] = onX ? [x, 0] : [0, y];
    return {
      point2d: snapped,
      worldPoint: localToWorld(snapped, this.plane),
      snapType: 'vertex',
      ref: { datum: onX ? 'x-axis' : 'y-axis' },
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
