import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, type BodyState, type ConnectorState, type MateRecord } from '../src/solver';

// The gizmo's external-drag calls feed the solver with exactly these input
// shapes (see AssemblyController.updateExternalDragTranslate/Rotate):
// translation passes the axis-constrained target as both the origin target
// and the cursor with a zero grab offset; rotation writes the quaternion
// onto the dragged body and re-solves seeded at it with no target. These
// tests pin the solver-side behavior those calls rely on.

function flatConnector(connectorId: string, ox = 0, oy = 0): ConnectorState {
  return {
    connectorId,
    localOrigin: new Vector3(ox, oy, 0),
    localXDirection: new Vector3(1, 0, 0),
    localNormal: new Vector3(0, 0, 1),
  };
}

function body(
  instanceId: string,
  grounded: boolean,
  position: Vector3,
  connectors: ConnectorState[] = [],
  quaternion = new Quaternion(),
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors };
}

function revolute(a: { i: string; c: string }, b: { i: string; c: string }): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'revolute',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options: undefined,
  };
}

/** The gizmo translate call: target the body origin with a zero grab. */
function solveTranslate(
  solver: Solver,
  bodies: BodyState[],
  mates: MateRecord[],
  draggedInstanceId: string,
  target: Vector3,
) {
  return solver.solve({
    bodies,
    mates,
    draggedInstanceId,
    draggedTargetOrigin: target.clone(),
    draggedCursorWorld: target.clone(),
    draggedGrabLocal: new Vector3(0, 0, 0),
  });
}

/** The gizmo rotate call: quaternion pre-written on the body, seeded solve. */
function solveRotate(
  solver: Solver,
  bodies: BodyState[],
  mates: MateRecord[],
  draggedInstanceId: string,
) {
  return solver.solve({ bodies, mates, draggedInstanceId });
}

function adoptSolved(bodies: BodyState[], out: { bodies: { instanceId: string; position: Vector3; quaternion: Quaternion }[] }): BodyState[] {
  return bodies.map((b) => {
    const solved = out.bodies.find((s) => s.instanceId === b.instanceId)!;
    return { ...b, position: solved.position, quaternion: solved.quaternion };
  });
}

describe('gizmo external drag — solver contract', () => {
  it('free body tracks axis-constrained targets exactly, no drift over 50 steps', () => {
    const solver = new Solver();
    let bodies = [body('g', true, new Vector3()), body('a', false, new Vector3(2, 1, 0))];
    const start = new Vector3(2, 1, 0);
    const axis = new Vector3(1, 0, 0);

    for (let i = 1; i <= 50; i++) {
      // The same target repeatedly at the end proves idempotence too.
      const t = Math.min(i, 40) * 0.25;
      const target = start.clone().addScaledVector(axis, t);
      const out = solveTranslate(solver, bodies, [], 'a', target);
      expect(out.result).toBe('okay');
      const a = out.bodies.find((b) => b.instanceId === 'a')!;
      expect(a.position.x).toBeCloseTo(target.x, 6);
      expect(a.position.y).toBeCloseTo(start.y, 6);
      expect(a.position.z).toBeCloseTo(start.z, 6);
      bodies = adoptSolved(bodies, out);
    }
  });

  it('rotation passes through unchanged for a free body', () => {
    const solver = new Solver();
    const rotated = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3);
    const bodies = [
      body('g', true, new Vector3()),
      body('a', false, new Vector3(5, 2, 1), [], rotated.clone()),
    ];
    const out = solveRotate(solver, bodies, [], 'a');
    expect(out.result).toBe('okay');
    const a = out.bodies.find((b) => b.instanceId === 'a')!;
    expect(a.position.x).toBeCloseTo(5, 9);
    expect(a.position.y).toBeCloseTo(2, 9);
    expect(a.position.z).toBeCloseTo(1, 9);
    expect(Math.abs(a.quaternion.dot(rotated))).toBeCloseTo(1, 9);
  });

  it('revolute follower keeps a rotation about the mate axis', () => {
    const solver = new Solver();
    const aboutZ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6);
    // Settle the mate first so the rotation applies from a solved pose.
    let bodies = [
      body('g', true, new Vector3(), [flatConnector('c0')]),
      body('a', false, new Vector3(0.5, 0, 0), [flatConnector('c1')]),
    ];
    const mates = [revolute({ i: 'g', c: 'c0' }, { i: 'a', c: 'c1' })];
    const settled = solveRotate(solver, bodies, mates, 'a');
    expect(settled.result).toBe('okay');
    bodies = adoptSolved(bodies, settled);

    // The gizmo rotate: quaternion written onto the live body, then re-solve.
    bodies = bodies.map((b) => (b.instanceId === 'a' ? { ...b, quaternion: aboutZ.clone() } : b));
    const out = solveRotate(solver, bodies, mates, 'a');
    expect(out.result).toBe('okay');
    const a = out.bodies.find((b) => b.instanceId === 'a')!;
    const hingeX = new Vector3(1, 0, 0).applyQuaternion(a.quaternion);
    expect((Math.atan2(hingeX.y, hingeX.x) * 180) / Math.PI).toBeCloseTo(30, 4);
  });

  it('revolute follower rejects a rotation off the mate axis (re-projected)', () => {
    const solver = new Solver();
    const aboutX = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 9);
    let bodies = [
      body('g', true, new Vector3(), [flatConnector('c0')]),
      body('a', false, new Vector3(0.5, 0, 0), [flatConnector('c1')]),
    ];
    const mates = [revolute({ i: 'g', c: 'c0' }, { i: 'a', c: 'c1' })];
    const settled = solveRotate(solver, bodies, mates, 'a');
    bodies = adoptSolved(bodies, settled);
    const settledNormal = new Vector3(0, 0, 1)
      .applyQuaternion(bodies.find((b) => b.instanceId === 'a')!.quaternion);

    const tilted = aboutX.clone().multiply(bodies.find((b) => b.instanceId === 'a')!.quaternion);
    bodies = bodies.map((b) => (b.instanceId === 'a' ? { ...b, quaternion: tilted } : b));
    const out = solveRotate(solver, bodies, mates, 'a');
    expect(out.result).toBe('okay');
    const a = out.bodies.find((b) => b.instanceId === 'a')!;
    // The off-axis tilt must be projected out: the hinge normal returns to
    // the settled mate branch (whichever sign convention the mate chose).
    const normal = new Vector3(0, 0, 1).applyQuaternion(a.quaternion);
    expect(normal.dot(settledNormal)).toBeGreaterThan(0.999);
  });

  it('revolute follower dragged away keeps connector origins coincident', () => {
    const solver = new Solver();
    let bodies = [
      body('g', true, new Vector3(), [flatConnector('c0')]),
      body('a', false, new Vector3(0.5, 0, 0), [flatConnector('c1')]),
    ];
    const mates = [revolute({ i: 'g', c: 'c0' }, { i: 'a', c: 'c1' })];
    const settled = solveRotate(solver, bodies, mates, 'a');
    bodies = adoptSolved(bodies, settled);

    const out = solveTranslate(solver, bodies, mates, 'a', new Vector3(40, -25, 10));
    expect(out.result).toBe('okay');
    const a = out.bodies.find((b) => b.instanceId === 'a')!;
    // The follower's connector origin is its body origin (localOrigin 0);
    // the hinge pins it to the grounded connector at the world origin.
    expect(a.position.length()).toBeLessThan(1e-6);
  });
});
