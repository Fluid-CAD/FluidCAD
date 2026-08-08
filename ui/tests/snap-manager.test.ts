import { describe, it, expect } from 'vitest';
import { SnapManager } from '../src/snapping/snap-manager';
import { PlaneData } from '../src/types';
import { SceneContext } from '../src/scene/scene-context';

/** Minimal orthographic-camera context: worldHeight = (top - bottom) / zoom. */
function fakeOrthoContext(worldHeight: number, canvasHeight: number): SceneContext {
  return {
    camera: { isOrthographicCamera: true, top: worldHeight / 2, bottom: -worldHeight / 2, zoom: 1 },
    renderer: { domElement: { getBoundingClientRect: () => ({ height: canvasHeight }) } },
  } as unknown as SceneContext;
}

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

  // The bug this guards: the snap threshold was a fixed 15 sketch units no
  // matter the zoom — a huge magnet zoomed in, unreachable zoomed out. With a
  // scene context it is 15 *pixels*, converted at the current zoom.
  it('scales the snap threshold with zoom level', () => {
    const plane = XY_PLANE_CENTERED_AT(0, 0, 0);

    // Zoomed in: 500px canvas shows 50 world units → 15px ≈ 1.5 units.
    const zoomedIn = SnapManager.fromSceneObjects([], 'sketch-1', plane, fakeOrthoContext(50, 500));
    expect(zoomedIn.snap([0, 1.4], plane).snapType).toBe('vertex');
    expect(zoomedIn.snap([0, 5], plane).snapType).not.toBe('vertex');

    // Zoomed out: same canvas shows 5000 world units → 15px ≈ 150 units.
    const zoomedOut = SnapManager.fromSceneObjects([], 'sketch-1', plane, fakeOrthoContext(5000, 500));
    expect(zoomedOut.snap([0, 140], plane).snapType).toBe('vertex');
  });

  // Scene-derived snap points — plane-section crossings and projected body
  // vertices — computed server-side and carried on the sketch's own payload.
  it('snaps to the sketch payload\'s snapVertices', () => {
    const plane = XY_PLANE_CENTERED_AT(0, 0, 0);
    const sketchObj = {
      id: 'sketch-1',
      sceneShapes: [],
      ownShapes: [],
      snapVertices: [[30, -20]] as [number, number][],
    };
    const manager = SnapManager.fromSceneObjects([sketchObj], 'sketch-1', plane);

    const result = manager.snap([30.2, -19.9], plane);

    expect(result.snapType).toBe('vertex');
    expect(result.point2d[0]).toBeCloseTo(30);
    expect(result.point2d[1]).toBeCloseTo(-20);
  });

  it('falls back to grid snap away from the center', () => {
    const plane = XY_PLANE_CENTERED_AT(0, 0, 0);
    const manager = SnapManager.fromSceneObjects([], 'sketch-1', plane);

    const result = manager.snap([100.2, 50.1], plane);

    expect(result.snapType).toBe('grid');
  });
});
