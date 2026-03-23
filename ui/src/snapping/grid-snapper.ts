import { Vector3 } from 'three';
import { Snapper, SnapResult } from './types';
import { PlaneData } from '../types';

export class GridSnapper implements Snapper {
  private spacing: number;
  private plane: PlaneData;

  constructor(plane: PlaneData, spacing: number = 10) {
    this.plane = plane;
    this.spacing = spacing;
  }

  snap(point2d: [number, number], threshold: number): SnapResult | null {
    const snappedX = Math.round(point2d[0] / this.spacing) * this.spacing;
    const snappedY = Math.round(point2d[1] / this.spacing) * this.spacing;

    const dx = point2d[0] - snappedX;
    const dy = point2d[1] - snappedY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > threshold) {
      return null;
    }

    const snapped: [number, number] = [snappedX, snappedY];

    return {
      point2d: snapped,
      worldPoint: localToWorld(snapped, this.plane),
      snapType: 'grid',
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
