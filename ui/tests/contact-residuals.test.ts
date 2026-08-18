import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  contactResidual,
  contactRowCount,
  resolveContact,
} from '../src/solver/contact-model';
import type { BodyState, ContactEntity, ContactState, MateRecord } from '../src/solver/types';

// §4.2 pair catalog: residual-zero at hand-constructed tangent poses,
// internal-branch targets, near-parallel stability, and the §6.2
// active-entity selection across a G1 plane→fillet chain.

function body(
  instanceId: string,
  contacts: ContactState[],
  position = new Vector3(),
  quaternion = new Quaternion(),
  grounded = false,
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors: [], contacts };
}

function tangentMate(options?: MateRecord['options']): MateRecord {
  return {
    mateId: 'm-tangent',
    type: 'tangent',
    geometryA: { instanceId: 'A', exposeName: 'gA' },
    geometryB: { instanceId: 'B', exposeName: 'gB' },
    options,
  };
}

function state(name: string, ...chain: ContactEntity[]): ContactState {
  return { exposeName: name, seed: chain[0] ?? null, chain };
}

function residualFor(
  chainA: ContactEntity[],
  chainB: ContactEntity[],
  poseB: { position?: Vector3; quaternion?: Quaternion } = {},
  options?: MateRecord['options'],
): number[] {
  const a = body('A', [state('gA', ...chainA)]);
  const b = body('B', [state('gB', ...chainB)],
    poseB.position ?? new Vector3(), poseB.quaternion ?? new Quaternion());
  const mate = tangentMate(options);
  const rc = resolveContact(mate, new Map([['A', a], ['B', b]]));
  expect(rc).not.toBeNull();
  return contactResidual(rc!);
}

const plane = (point: [number, number, number], over: Partial<ContactEntity> = {}): ContactEntity => ({
  form: 'plane', point, dir: [0, 0, 1], xDir: [1, 0, 0], convex: true, ...over,
});
const sphereAt = (point: [number, number, number], radius: number, convex = true): ContactEntity => ({
  form: 'sphere', point, dir: [0, 0, 1], radius, convex,
});
const cylinderAt = (
  point: [number, number, number], dir: [number, number, number], radius: number,
  over: Partial<ContactEntity> = {},
): ContactEntity => ({
  form: 'cylinder', point, dir, xDir: undefined, radius, convex: true, ...over,
});
const lineAt = (point: [number, number, number], dir: [number, number, number]): ContactEntity => ({
  form: 'line', point, dir, convex: true,
});

const expectAllNear = (rows: number[], eps = 1e-9) => {
  expect(rows.length).toBeGreaterThan(0);
  for (const v of rows) expect(Math.abs(v)).toBeLessThan(eps);
};

describe('contact residual catalog — residual-zero at tangency', () => {
  it('plane–sphere: ball resting on the plane', () => {
    const rows = residualFor([plane([0, 0, 10])], [sphereAt([3, -2, 15], 5)]);
    expect(rows).toHaveLength(1);
    expectAllNear(rows);
  });

  it('plane–cylinder: shaft lying on the plane (2 rows: axis ∥ + height)', () => {
    const rows = residualFor(
      [plane([0, 0, 0])],
      [cylinderAt([0, 0, 4], [1, 0, 0], 4)],
    );
    expect(rows).toHaveLength(2);
    expectAllNear(rows);
  });

  it('plane–cone: cone on its side — apex on the plane, axis tilted by α', () => {
    const alpha = (15 * Math.PI) / 180;
    const cone: ContactEntity = {
      form: 'cone',
      point: [0, 0, 0],
      dir: [Math.cos(alpha), 0, Math.sin(alpha)],
      halfAngleDeg: 15,
      convex: true,
    };
    const rows = residualFor([plane([0, 0, 0])], [cone]);
    expect(rows).toHaveLength(2);
    expectAllNear(rows, 1e-7);
  });

  it('plane–line: edge resting in the plane', () => {
    const rows = residualFor([plane([0, 0, 2])], [lineAt([5, 5, 2], [0, 1, 0])]);
    expect(rows).toHaveLength(2);
    expectAllNear(rows);
  });

  it('plane–circle: tilted rim touching the plane', () => {
    const R = 10;
    const phi = (30 * Math.PI) / 180; // tilt of the circle plane
    const circle: ContactEntity = {
      form: 'circle',
      point: [0, 0, R * Math.sin(phi)],
      dir: [Math.sin(phi), 0, Math.cos(phi)],
      xDir: [0, 1, 0],
      radius: R,
      convex: true,
    };
    const rows = residualFor([plane([0, 0, 0])], [circle]);
    expect(rows).toHaveLength(1);
    expectAllNear(rows, 1e-7);
  });

  it('cylinder–cylinder: crossed shafts touching externally', () => {
    const rows = residualFor(
      [cylinderAt([0, 0, 0], [1, 0, 0], 5)],
      [cylinderAt([0, 0, 8], [0, 1, 0], 3)],
    );
    expect(rows).toHaveLength(1);
    expectAllNear(rows);
  });

  it('cylinder–cylinder: shaft resting in a bore (internal branch, parallel axes)', () => {
    // Bore Ø20 (concave), shaft Ø12 — axes parallel, 4 apart. The
    // parallel configuration exercises the distLL fallback branch.
    const rows = residualFor(
      [cylinderAt([0, 0, 0], [0, 0, 1], 10, { convex: false })],
      [cylinderAt([4, 0, 0], [0, 0, 1], 6)],
    );
    expect(rows).toHaveLength(1);
    expectAllNear(rows);
  });

  it('cylinder–sphere: ball on a shaft, and ball inside a bore', () => {
    const external = residualFor(
      [cylinderAt([0, 0, 0], [0, 0, 1], 5)],
      [sphereAt([9, 0, 12], 4)],
    );
    expectAllNear(external);

    const internal = residualFor(
      [cylinderAt([0, 0, 0], [0, 0, 1], 10, { convex: false })],
      [sphereAt([6, 0, 3], 4)],
    );
    expectAllNear(internal);
  });

  it('cylinder–line: edge resting on a shaft', () => {
    const rows = residualFor(
      [cylinderAt([0, 0, 0], [1, 0, 0], 5)],
      [lineAt([0, 0, 5], [0, 1, 0])],
    );
    expect(rows).toHaveLength(1);
    expectAllNear(rows);
  });

  it('sphere–sphere: external and internal', () => {
    expectAllNear(residualFor([sphereAt([0, 0, 0], 5)], [sphereAt([8, 0, 0], 3)]));
    expectAllNear(residualFor(
      [sphereAt([0, 0, 0], 10, false)],
      [sphereAt([0, 6, 0], 4)],
    ));
  });

  it('body pose transforms the geometry: ball offset via body position', () => {
    // Sphere entity at local origin; the BODY carries the pose.
    const rows = residualFor(
      [plane([0, 0, 0])],
      [sphereAt([0, 0, 0], 5)],
      { position: new Vector3(40, -7, 5) },
    );
    expectAllNear(rows);
  });
});

describe('contact residual catalog — signs and stability', () => {
  it('reports the signed gap when the ball hovers above the plane', () => {
    const rows = residualFor([plane([0, 0, 0])], [sphereAt([0, 0, 8], 5)]);
    expect(rows[0]).toBeCloseTo(3, 9);
  });

  it('reports penetration as a negative gap', () => {
    const rows = residualFor([plane([0, 0, 0])], [sphereAt([0, 0, 3], 5)]);
    expect(rows[0]).toBeCloseTo(-2, 9);
  });

  it('near-parallel cylinder–cylinder stays finite and continuous', () => {
    const base = cylinderAt([0, 0, 0], [0, 0, 1], 5);
    let prev: number | null = null;
    for (const tilt of [0, 1e-9, 1e-7, 1e-5, 1e-3]) {
      // Tilt OUT of the common plane so the axes stay skew at distance 8
      // (an in-plane tilt would make coplanar lines intersect).
      const d = Math.sqrt(1 - tilt * tilt);
      const rows = residualFor(
        [base],
        [cylinderAt([8, 0, 0], [0, tilt, d], 3)],
      );
      expect(Number.isFinite(rows[0])).toBe(true);
      expect(Math.abs(rows[0])).toBeLessThan(1e-4);
      if (prev !== null) expect(Math.abs(rows[0] - prev)).toBeLessThan(1e-4);
      prev = rows[0];
    }
  });

  it('concave–concave pairs are unsupported (zero rows)', () => {
    const a = body('A', [state('gA', cylinderAt([0, 0, 0], [0, 0, 1], 10, { convex: false }))]);
    const b = body('B', [state('gB', cylinderAt([4, 0, 0], [0, 0, 1], 6, { convex: false }))]);
    const rc = resolveContact(tangentMate(), new Map([['A', a], ['B', b]]));
    expect(rc).not.toBeNull();
    expect(contactRowCount(rc!)).toBe(0);
    expect(contactResidual(rc!)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §6 propagation: rounded slab (top plane + G1 fillet), bounds gating
// ---------------------------------------------------------------------------

// Slab top z=10 for x ≤ 17, fillet r=3 with axis along y at (17, 0, 7):
// tangent to the top plane and to the side wall x=20.
const SLAB_TOP: ContactEntity = {
  form: 'plane',
  point: [0, 0, 10],
  dir: [0, 0, 1],
  xDir: [1, 0, 0],
  convex: true,
  bounds: { uMin: -17, uMax: 17, vMin: -10, vMax: 10 },
};
// Cylinder canonical frame: xDir = +x, yDir = dir × xDir = (0,1,0)×(1,0,0) = −z.
// Radial +z ⇒ angle −π/2 (top tangency); radial +x ⇒ 0 (side tangency).
const SLAB_FILLET: ContactEntity = {
  form: 'cylinder',
  point: [17, 0, 7],
  dir: [0, 1, 0],
  xDir: [1, 0, 0],
  radius: 3,
  convex: true,
  bounds: { uMin: -Math.PI / 2, uMax: 0, vMin: -10, vMax: 10 },
};
const BALL_R = 5;

describe('tangent propagation — active-entity selection over a G1 chain', () => {
  it('keeps the residual ~0 while rolling from the plane onto the fillet', () => {
    const chainA = [SLAB_TOP, SLAB_FILLET];
    // On the plane: center (x, 0, 15) for x ≤ 17; on the fillet: center
    // sweeps the arc around the fillet axis at radius 3 + R.
    const centers: Vector3[] = [];
    for (let x = 0; x <= 17; x += 1.7) centers.push(new Vector3(x, 0, 15));
    for (let i = 0; i <= 10; i++) {
      const theta = -Math.PI / 2 + (i / 10) * (Math.PI / 2);
      // radial(θ) = cosθ·xDir + sinθ·yDir = (cosθ, 0, −sinθ)
      centers.push(new Vector3(
        17 + (3 + BALL_R) * Math.cos(theta),
        0,
        7 - (3 + BALL_R) * Math.sin(theta),
      ));
    }
    for (const c of centers) {
      const rows = residualFor(
        [chainA[0], chainA[1]],
        [sphereAt([0, 0, 0], BALL_R)],
        { position: c },
      );
      expect(rows).toHaveLength(1);
      expect(Math.abs(rows[0])).toBeLessThan(1e-6);
    }
  });

  it('bounds gating: past the physical edge, the infinite plane no longer claims contact', () => {
    // Ball hovers at plane height but 13 beyond the face's bounded
    // extent: the in-bounds fillet pair (positive gap) must win over the
    // out-of-bounds plane pair (zero gap).
    const rows = residualFor(
      [SLAB_TOP, SLAB_FILLET],
      [sphereAt([0, 0, 0], BALL_R)],
      { position: new Vector3(30, 0, 15) },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeGreaterThan(1);
  });

  it('.noPropagate() restricts the contact set to the seed', () => {
    // Ball tangent to the FILLET only: with propagation the fillet
    // entity serves; with .noPropagate() only the plane seed remains and
    // the residual is the (non-zero) plane gap.
    const theta = -Math.PI / 4;
    const center = new Vector3(
      17 + (3 + BALL_R) * Math.cos(theta),
      0,
      7 + (3 + BALL_R) * Math.abs(Math.sin(theta)),
    );
    const withProp = residualFor(
      [SLAB_TOP, SLAB_FILLET], [sphereAt([0, 0, 0], BALL_R)], { position: center },
    );
    expect(Math.abs(withProp[0])).toBeLessThan(1e-6);

    const noProp = residualFor(
      [SLAB_TOP, SLAB_FILLET], [sphereAt([0, 0, 0], BALL_R)], { position: center },
      { propagate: false },
    );
    expect(Math.abs(noProp[0])).toBeGreaterThan(0.1);
  });

  it('row count is fixed per record across mixed-form chains (§6.2 padding)', () => {
    // plane member (vs sphere: 1 row) + cylinder member (vs sphere:
    // 1 row) → dim 1 everywhere. Against a LINE counter-side, the plane
    // member pairs at 2 rows and the cylinder member at 1 → dim 2, and
    // the cylinder selection must pad.
    const a = body('A', [state('gA', SLAB_TOP, SLAB_FILLET)]);
    const bLine = body('B', [state('gB', lineAt([0, 0, 10], [0, 1, 0]))]);
    const rc = resolveContact(tangentMate(), new Map([['A', a], ['B', bLine]]));
    expect(contactRowCount(rc!)).toBe(2);
    expect(contactResidual(rc!)).toHaveLength(2);
  });
});
