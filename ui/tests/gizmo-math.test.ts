import { describe, it, expect } from 'vitest';
import { Ray, Vector3 } from 'three';
import { GizmoMath } from '../src/interactive/gizmo/gizmo-math';

function rayAt(origin: [number, number, number], dir: [number, number, number]): Ray {
  return new Ray(new Vector3(...origin), new Vector3(...dir).normalize());
}

const ORIGIN = new Vector3(0, 0, 0);
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

describe('GizmoMath.closestAxisParam', () => {
  it('finds the axis param nearest a crossing ray', () => {
    const t = GizmoMath.closestAxisParam(rayAt([5, 0, 10], [0, 0, -1]), ORIGIN, X);
    expect(t).toBeCloseTo(5, 10);
  });

  it('handles skew rays', () => {
    const t = GizmoMath.closestAxisParam(rayAt([3, 4, 10], [0, 0, -1]), ORIGIN, X);
    expect(t).toBeCloseTo(3, 10);
  });

  it('is invariant to the ray origin sliding along its direction (ortho pushed-back origin)', () => {
    const near = GizmoMath.closestAxisParam(rayAt([5, 0, 10], [0, 0, -1]), ORIGIN, X);
    const far = GizmoMath.closestAxisParam(rayAt([5, 0, 20010], [0, 0, -1]), ORIGIN, X);
    expect(far).toBeCloseTo(near!, 6);
  });

  it('respects a translated axis origin', () => {
    const t = GizmoMath.closestAxisParam(rayAt([5, 0, 10], [0, 0, -1]), new Vector3(2, 0, 0), X);
    expect(t).toBeCloseTo(3, 10);
  });

  it('returns null for a ray parallel to the axis', () => {
    expect(GizmoMath.closestAxisParam(rayAt([0, 5, 0], [1, 0, 0]), ORIGIN, X)).toBeNull();
    expect(GizmoMath.closestAxisParam(rayAt([0, 5, 0], [-1, 0, 0]), ORIGIN, X)).toBeNull();
  });
});

describe('GizmoMath.intersectPlane', () => {
  it('intersects a facing plane', () => {
    const hit = GizmoMath.intersectPlane(rayAt([3, 4, 10], [0, 0, -1]), ORIGIN, Z);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(3, 10);
    expect(hit!.y).toBeCloseTo(4, 10);
    expect(hit!.z).toBeCloseTo(0, 10);
  });

  it('returns null edge-on', () => {
    expect(GizmoMath.intersectPlane(rayAt([0, -10, 0.5], [0, 1, 0]), ORIGIN, Z)).toBeNull();
  });

  it('returns null for a plane behind the ray', () => {
    expect(GizmoMath.intersectPlane(rayAt([0, 0, 10], [0, 0, 1]), ORIGIN, Z)).toBeNull();
  });
});

describe('GizmoMath.rotationAngleDeg', () => {
  const down = (x: number, y: number) => rayAt([x, y, 10], [0, 0, -1]);

  it('measures the polar angle in the (u, v) basis', () => {
    expect(GizmoMath.rotationAngleDeg(down(1, 0), ORIGIN, Z, X, Y)).toBeCloseTo(0, 10);
    expect(GizmoMath.rotationAngleDeg(down(0, 1), ORIGIN, Z, X, Y)).toBeCloseTo(90, 10);
    expect(GizmoMath.rotationAngleDeg(down(-1, 0), ORIGIN, Z, X, Y)).toBeCloseTo(180, 10);
    expect(GizmoMath.rotationAngleDeg(down(1, -1), ORIGIN, Z, X, Y)).toBeCloseTo(-45, 10);
  });

  it('returns null at the exact center and edge-on', () => {
    expect(GizmoMath.rotationAngleDeg(down(0, 0), ORIGIN, Z, X, Y)).toBeNull();
    expect(GizmoMath.rotationAngleDeg(rayAt([0, -10, 0], [0, 1, 0]), ORIGIN, Z, X, Y)).toBeNull();
  });
});

describe('GizmoMath.unwrapDeg', () => {
  it('accumulates plain deltas', () => {
    expect(GizmoMath.unwrapDeg(10, 25, 0)).toEqual({ raw: 25, accum: 15 });
    expect(GizmoMath.unwrapDeg(25, 5, 15)).toEqual({ raw: 5, accum: -5 });
  });

  it('unwraps across the +180/-180 seam going counter-clockwise', () => {
    const step = GizmoMath.unwrapDeg(170, -170, 170);
    expect(step.accum).toBeCloseTo(190, 10);
  });

  it('unwraps across the seam going clockwise', () => {
    const step = GizmoMath.unwrapDeg(-170, 170, -170);
    expect(step.accum).toBeCloseTo(-190, 10);
  });

  it('can wind multiple turns', () => {
    let raw = 0;
    let accum = 0;
    for (let i = 1; i <= 24; i++) {
      const next = ((i * 30 + 180) % 360) - 180;
      ({ raw, accum } = GizmoMath.unwrapDeg(raw, next, accum));
    }
    expect(accum).toBeCloseTo(720, 8);
  });
});

describe('GizmoMath snapping', () => {
  it('snaps translation to 1 mm and rotation to 5 degrees when on', () => {
    expect(GizmoMath.snapTranslate(2.6, true)).toBe(3);
    expect(GizmoMath.snapTranslate(2.6, false)).toBe(2.6);
    expect(GizmoMath.snapRotate(justUnder(47.5), true)).toBe(45);
    expect(GizmoMath.snapRotate(48, true)).toBe(50);
    expect(GizmoMath.snapRotate(48, false)).toBe(48);
  });
});

function justUnder(n: number): number {
  return n - 1e-9;
}
