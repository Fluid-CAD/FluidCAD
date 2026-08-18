import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver } from '../src/solver';
import type { BodyState, ContactEntity, ContactState, MateRecord } from '../src/solver/types';

// Solver-level tangent mate tests (17-mate-tangent phase B): residual-only
// contact edges through the joint-space LM with multi-root pose blocks.

function body(
  instanceId: string,
  grounded: boolean,
  contacts: ContactState[],
  position = new Vector3(),
  quaternion = new Quaternion(),
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors: [], contacts };
}

function tangent(
  mateId: string,
  a: { i: string; g: string },
  b: { i: string; g: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type: 'tangent',
    geometryA: { instanceId: a.i, exposeName: a.g },
    geometryB: { instanceId: b.i, exposeName: b.g },
    options,
  };
}

const PLATE_TOP: ContactEntity = {
  form: 'plane',
  point: [0, 0, 10],
  dir: [0, 0, 1],
  xDir: [1, 0, 0],
  convex: true,
  bounds: { uMin: -50, uMax: 50, vMin: -50, vMax: 50 },
};
const BALL: ContactEntity = {
  form: 'sphere', point: [0, 0, 0], dir: [0, 0, 1], radius: 5, convex: true,
};

const plateState: ContactState = { exposeName: 'top', seed: PLATE_TOP, chain: [PLATE_TOP] };
const ballState: ContactState = { exposeName: 'skin', seed: BALL, chain: [BALL] };

function ballOnPlate(ballPos: Vector3, ballGrounded = false) {
  const bodies = [
    body('plate', true, [plateState]),
    body('ball', ballGrounded, [ballState], ballPos),
  ];
  const mates = [tangent('t1', { i: 'plate', g: 'top' }, { i: 'ball', g: 'skin' })];
  return { bodies, mates };
}

function gapToPlane(out: { bodies: { instanceId: string; position: Vector3 }[] }): number {
  const ball = out.bodies.find(b => b.instanceId === 'ball')!;
  return ball.position.z - 10 - 5;
}

describe('tangent mate — ball on a plate', () => {
  it('reports 5 DOF (rank-based) at a satisfied touching pose', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(3, -4, 15));
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);
    // 6 root vars for the contact-only ball, 1 contact row → 5.
    expect(out.dof).toBe(5);
    expect(Math.abs(gapToPlane(out))).toBeLessThan(1e-6);
  });

  it('LM pulls a hovering ball down onto the plane', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(0, 0, 17.5));
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(Math.abs(gapToPlane(out))).toBeLessThan(1e-6);
  });

  it('LM pushes a penetrating ball back up onto the plane', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(0, 0, 13));
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(Math.abs(gapToPlane(out))).toBeLessThan(1e-6);
  });

  it('drag slides the ball along the plane without lifting or spinning it', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(0, 0, 15));
    const out = new Solver().solve({
      bodies,
      mates,
      draggedInstanceId: 'ball',
      draggedGrabLocal: new Vector3(0, 0, 0),
      draggedCursorWorld: new Vector3(12, 7, 15),
    });
    expect(out.result).toBe('okay');
    const ball = out.bodies.find(b => b.instanceId === 'ball')!;
    // In-plane the drag is unconstrained — the grab reaches the cursor.
    expect(ball.position.x).toBeCloseTo(12, 3);
    expect(ball.position.y).toBeCloseTo(7, 3);
    // The contact keeps it on the plane even when the cursor tries to lift.
    expect(Math.abs(gapToPlane(out))).toBeLessThan(1e-3);
    // No orientation drift (the ball-on-plane drag regression gate).
    const q = ball.quaternion;
    expect(Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z)).toBeLessThan(1e-6);
  });

  it('drag with a lifting cursor keeps the ball on the plane', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(0, 0, 15));
    const out = new Solver().solve({
      bodies,
      mates,
      draggedInstanceId: 'ball',
      draggedGrabLocal: new Vector3(0, 0, 0),
      draggedCursorWorld: new Vector3(5, 0, 40),
    });
    // The small drag weight lets the contact dominate an unreachable
    // cursor: the ball slides toward it but stays tangent within the
    // drag-weight equilibrium (w²·25 ≈ 0.06 mm — the same compromise the
    // closure rhombus regression accepts; FAILED_MATE_EPS sits above it).
    expect(out.result).toBe('okay');
    expect(Math.abs(gapToPlane(out))).toBeLessThan(0.1);
  });

  it('both-grounded tangent degenerates to a pure check', () => {
    const { bodies, mates } = ballOnPlate(new Vector3(0, 0, 30), true);
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['t1']);
    // Poses untouched.
    const ball = out.bodies.find(b => b.instanceId === 'ball')!;
    expect(ball.position.z).toBeCloseTo(30, 9);
    expect(out.dof).toBe(0);
  });
});

describe('tangent mate — multi-root LM variable blocks', () => {
  it('two balls on one plate: two ungrounded roots, both contacts enforced, 10 DOF', () => {
    const bodies = [
      body('plate', true, [plateState]),
      body('ball1', false, [ballState], new Vector3(-10, 0, 16)),
      body('ball2', false, [ballState], new Vector3(10, 0, 13.5)),
    ];
    const mates = [
      tangent('t1', { i: 'plate', g: 'top' }, { i: 'ball1', g: 'skin' }),
      tangent('t2', { i: 'plate', g: 'top' }, { i: 'ball2', g: 'skin' }),
    ];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === 'ball1')!;
    const b2 = out.bodies.find(b => b.instanceId === 'ball2')!;
    expect(b1.position.z).toBeCloseTo(15, 5);
    expect(b2.position.z).toBeCloseTo(15, 5);
    // 12 root vars, 2 independent contact rows → 10.
    expect(out.dof).toBe(10);
  });

  it('a contact-only body still solves when its cluster hangs off a fastened pair', () => {
    // ball1 fastened to ball2 (tree edge), the CLUSTER touches the plate
    // only through ball1's tangent — the cluster root is an extra
    // ungrounded root of the forest.
    const conn = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const bodies: BodyState[] = [
      body('plate', true, [plateState]),
      { ...body('ball1', false, [ballState], new Vector3(0, 0, 18)), connectors: [conn] },
      { ...body('ball2', false, [ballState], new Vector3(0, 0, 18)), connectors: [conn] },
    ];
    const mates: MateRecord[] = [
      tangent('t1', { i: 'plate', g: 'top' }, { i: 'ball1', g: 'skin' }),
      {
        mateId: 'f1',
        type: 'fastened',
        connectorA: { instanceId: 'ball1', connectorId: 'c' },
        connectorB: { instanceId: 'ball2', connectorId: 'c' },
      },
    ];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === 'ball1')!;
    expect(b1.position.z).toBeCloseTo(15, 5);
  });
});

describe('tangent mate — shaft in a bore', () => {
  const BORE: ContactEntity = {
    form: 'cylinder',
    point: [0, 0, 0],
    dir: [0, 0, 1],
    xDir: [1, 0, 0],
    radius: 10,
    convex: false,
    bounds: { uMin: -Math.PI, uMax: Math.PI, vMin: 0, vMax: 40 },
  };
  const SHAFT: ContactEntity = {
    form: 'cylinder',
    point: [0, 0, 0],
    dir: [0, 0, 1],
    xDir: [1, 0, 0],
    radius: 6,
    convex: true,
    bounds: { uMin: -Math.PI, uMax: Math.PI, vMin: 0, vMax: 40 },
  };

  it('rests the shaft against the bore wall (internal branch)', () => {
    const bodies = [
      body('housing', true, [{ exposeName: 'bore', seed: BORE, chain: [BORE] }]),
      body('shaft', false, [{ exposeName: 'wall', seed: SHAFT, chain: [SHAFT] }],
        new Vector3(1, 0, 0)),
    ];
    const mates = [tangent('t1', { i: 'housing', g: 'bore' }, { i: 'shaft', g: 'wall' })];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    const shaft = out.bodies.find(b => b.instanceId === 'shaft')!;
    // Axis distance settles at r_bore − r_shaft = 4.
    const axisDist = Math.hypot(shaft.position.x, shaft.position.y);
    expect(axisDist).toBeCloseTo(4, 5);
  });
});

describe('tangent mate — propagation through the solver', () => {
  // Rounded slab: bounded top plane + G1 fillet (see contact-residuals).
  const SLAB_TOP: ContactEntity = {
    form: 'plane',
    point: [0, 0, 10],
    dir: [0, 0, 1],
    xDir: [1, 0, 0],
    convex: true,
    bounds: { uMin: -17, uMax: 17, vMin: -10, vMax: 10 },
  };
  const SLAB_FILLET: ContactEntity = {
    form: 'cylinder',
    point: [17, 0, 7],
    dir: [0, 1, 0],
    xDir: [1, 0, 0],
    radius: 3,
    convex: true,
    bounds: { uMin: -Math.PI / 2, uMax: 0, vMin: -10, vMax: 10 },
  };

  it('a ball past the face edge settles on the fillet, not the infinite plane', () => {
    const bodies = [
      body('slab', true, [{ exposeName: 'top', seed: SLAB_TOP, chain: [SLAB_TOP, SLAB_FILLET] }]),
      body('ball', false, [ballState], new Vector3(22, 0, 14)),
    ];
    const mates = [tangent('t1', { i: 'slab', g: 'top' }, { i: 'ball', g: 'skin' })];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    const ball = out.bodies.find(b => b.instanceId === 'ball')!;
    // Tangent to the fillet: distance from the fillet axis = 3 + 5.
    const d = Math.hypot(ball.position.x - 17, ball.position.z - 7);
    expect(d).toBeCloseTo(8, 4);
  });
});
