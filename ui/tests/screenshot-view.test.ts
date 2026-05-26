import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import {
  NAMED_VIEW_DIRECTIONS,
  eyeTargetForNamedView,
  eyeTargetForOrbit,
  resolveView,
  type NamedView,
} from '../src/screenshot-view';

describe('NAMED_VIEW_DIRECTIONS', () => {
  it('cardinal views are unit-length and aligned to their axis', () => {
    for (const name of ['front', 'back', 'left', 'right', 'top', 'bottom'] as NamedView[]) {
      expect(NAMED_VIEW_DIRECTIONS[name].length()).toBeCloseTo(1, 9);
    }
    expect(NAMED_VIEW_DIRECTIONS.front).toEqual(new Vector3(0, -1, 0));
    expect(NAMED_VIEW_DIRECTIONS.back).toEqual(new Vector3(0, 1, 0));
    expect(NAMED_VIEW_DIRECTIONS.left).toEqual(new Vector3(-1, 0, 0));
    expect(NAMED_VIEW_DIRECTIONS.right).toEqual(new Vector3(1, 0, 0));
    expect(NAMED_VIEW_DIRECTIONS.top).toEqual(new Vector3(0, 0, 1));
    expect(NAMED_VIEW_DIRECTIONS.bottom).toEqual(new Vector3(0, 0, -1));
  });

  it('opposing cardinal views are antiparallel', () => {
    expect(NAMED_VIEW_DIRECTIONS.front.dot(NAMED_VIEW_DIRECTIONS.back)).toBeCloseTo(-1, 9);
    expect(NAMED_VIEW_DIRECTIONS.left.dot(NAMED_VIEW_DIRECTIONS.right)).toBeCloseTo(-1, 9);
    expect(NAMED_VIEW_DIRECTIONS.top.dot(NAMED_VIEW_DIRECTIONS.bottom)).toBeCloseTo(-1, 9);
  });

  it('perpendicular pairs (front ⊥ right, front ⊥ top, right ⊥ top)', () => {
    expect(NAMED_VIEW_DIRECTIONS.front.dot(NAMED_VIEW_DIRECTIONS.right)).toBeCloseTo(0, 9);
    expect(NAMED_VIEW_DIRECTIONS.front.dot(NAMED_VIEW_DIRECTIONS.top)).toBeCloseTo(0, 9);
    expect(NAMED_VIEW_DIRECTIONS.right.dot(NAMED_VIEW_DIRECTIONS.top)).toBeCloseTo(0, 9);
  });

  it('iso views are unit-length and land in the correct octant', () => {
    const isoNames: NamedView[] = [
      'iso-ftr', 'iso-fbr', 'iso-ftl', 'iso-fbl',
      'iso-btr', 'iso-bbr', 'iso-btl', 'iso-bbl',
    ];
    for (const name of isoNames) {
      expect(NAMED_VIEW_DIRECTIONS[name].length()).toBeCloseTo(1, 9);
    }
    // ftr: +x, -y, +z
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-ftr'].x)).toBe(1);
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-ftr'].y)).toBe(-1);
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-ftr'].z)).toBe(1);
    // bbl: -x, +y, -z
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-bbl'].x)).toBe(-1);
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-bbl'].y)).toBe(1);
    expect(Math.sign(NAMED_VIEW_DIRECTIONS['iso-bbl'].z)).toBe(-1);
    // ftr and bbl are antiparallel
    expect(NAMED_VIEW_DIRECTIONS['iso-ftr'].dot(NAMED_VIEW_DIRECTIONS['iso-bbl'])).toBeCloseTo(-1, 9);
  });
});

describe('eyeTargetForNamedView', () => {
  it('places the camera at center + dir * distance, looking back at center', () => {
    const center = new Vector3(10, 20, 30);
    const distance = 50;
    const result = eyeTargetForNamedView('front', center, distance);
    // front dir is (0, -1, 0); eye = (10, 20 - 50, 30) = (10, -30, 30)
    expect(result.eye.x).toBeCloseTo(10, 9);
    expect(result.eye.y).toBeCloseTo(-30, 9);
    expect(result.eye.z).toBeCloseTo(30, 9);
    expect(result.target).toEqual(center);
  });

  it('clamps tiny distances so the camera never sits inside the model', () => {
    const result = eyeTargetForNamedView('top', new Vector3(0, 0, 0), 0);
    expect(result.eye.length()).toBeGreaterThan(0);
  });
});

describe('eyeTargetForOrbit', () => {
  it('zero deltas leave the eye exactly where it was', () => {
    const eye = new Vector3(50, -50, 40);
    const target = new Vector3(0, 0, 0);
    const result = eyeTargetForOrbit(eye, target, 0, 0);
    expect(result.eye.x).toBeCloseTo(eye.x, 6);
    expect(result.eye.y).toBeCloseTo(eye.y, 6);
    expect(result.eye.z).toBeCloseTo(eye.z, 6);
    expect(result.target).toEqual(target);
  });

  it('preserves distance to the target under any rotation', () => {
    const eye = new Vector3(50, -50, 40);
    const target = new Vector3(5, 5, 5);
    const original = eye.clone().sub(target).length();
    const result = eyeTargetForOrbit(eye, target, 45, 30);
    const actual = result.eye.clone().sub(result.target).length();
    expect(actual).toBeCloseTo(original, 6);
  });

  it('a 90deg azimuth rotates an X-axis offset into +Y', () => {
    const target = new Vector3(0, 0, 0);
    const eye = new Vector3(10, 0, 0);
    const result = eyeTargetForOrbit(eye, target, 90, 0);
    expect(result.eye.x).toBeCloseTo(0, 6);
    expect(result.eye.y).toBeCloseTo(10, 6);
    expect(result.eye.z).toBeCloseTo(0, 6);
  });
});

describe('resolveView', () => {
  const center = new Vector3(0, 0, 0);
  const diameter = 100;
  const eye = new Vector3(50, -50, 40);
  const target = new Vector3(0, 0, 0);

  it('returns null for kind=current', () => {
    expect(resolveView({ kind: 'current' }, center, diameter, eye, target)).toBeNull();
  });

  it('named view resolves to eyeTargetForNamedView', () => {
    const result = resolveView({ kind: 'named', name: 'top' }, center, diameter, eye, target);
    expect(result).not.toBeNull();
    expect(result!.eye.z).toBeGreaterThan(0);
    expect(result!.target.length()).toBeCloseTo(0, 9);
  });

  it('look-from defaults target to scene center when omitted', () => {
    const result = resolveView(
      { kind: 'look-from', eye: [100, 0, 0] },
      new Vector3(7, 8, 9),
      diameter,
      eye,
      target,
    );
    expect(result!.eye).toEqual(new Vector3(100, 0, 0));
    expect(result!.target).toEqual(new Vector3(7, 8, 9));
  });

  it('look-from honors an explicit target', () => {
    const result = resolveView(
      { kind: 'look-from', eye: [100, 0, 0], target: [1, 2, 3] },
      center,
      diameter,
      eye,
      target,
    );
    expect(result!.target).toEqual(new Vector3(1, 2, 3));
  });
});
