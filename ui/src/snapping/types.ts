import { Vector3 } from 'three';

export type SnapType = 'vertex' | 'grid' | 'none';

export type SnapResult = {
  point2d: [number, number];
  worldPoint: Vector3;
  snapType: SnapType;
};

export interface Snapper {
  snap(point2d: [number, number], threshold: number): SnapResult | null;
}
