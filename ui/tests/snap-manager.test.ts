import { describe, it, expect } from 'vitest';
import { SnapManager } from '../src/snapping/snap-manager';
import { PlaneData } from '../src/types';

const XY_PLANE_CENTERED_AT = (cx: number, cy: number, cz: number): PlaneData => ({
  origin: { x: 0, y: 0, z: 0 },
  center: { x: cx, y: cy, z: cz },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
});

describe('SnapManager.fromSceneObjects', () => {
  // The bug this guards: sketching on a face defaults the start position to
  // the face center, but the interactive tools' snapping only knew sketch
  // child vertices and the grid — the default position itself was unsnappable.
  it('snaps to the plane center (the sketch default position)', () => {
    const plane = XY_PLANE_CENTERED_AT(12.5, 7.25, 0);
    const manager = SnapManager.fromSceneObjects([], 'sketch-1', plane);

    const result = manager.snap([12.4, 7.3], plane);

    expect(result.snapType).toBe('vertex');
    expect(result.point2d[0]).toBeCloseTo(12.5);
    expect(result.point2d[1]).toBeCloseTo(7.25);
    expect(result.worldPoint.x).toBeCloseTo(12.5);
    expect(result.worldPoint.y).toBeCloseTo(7.25);
  });

  it('projects an off-plane-origin center into sketch coordinates', () => {
    const plane: PlaneData = {
      origin: { x: 10, y: 0, z: 5 },
      center: { x: 13, y: 4, z: 5 },
      normal: { x: 0, y: 0, z: 1 },
      xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 },
    };
    const manager = SnapManager.fromSceneObjects([], 'sketch-1', plane);

    const result = manager.snap([3.1, 3.9], plane);

    expect(result.snapType).toBe('vertex');
    expect(result.point2d[0]).toBeCloseTo(3);
    expect(result.point2d[1]).toBeCloseTo(4);
  });

  it('falls back to grid snap away from the center', () => {
    const plane = XY_PLANE_CENTERED_AT(0, 0, 0);
    const manager = SnapManager.fromSceneObjects([], 'sketch-1', plane);

    const result = manager.snap([100.2, 50.1], plane);

    expect(result.snapType).toBe('grid');
  });
});
