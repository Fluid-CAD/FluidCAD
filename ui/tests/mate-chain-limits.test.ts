import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';
import { extract } from '../src/solver/joint-model';

// Stage D of the joint-model plan: `.limits()` hold on CHAINED drags.
// Before the joint-space LM, limits were only clamped by the tree
// warm-start's analytic drag path — which only touches the dragged
// body's own edge. A drag that reached an upstream limited joint via
// LM inverse kinematics sailed straight past the bound (F2). With
// joint params as LM variables, limits are box constraints projected
// after every accepted step, so they hold everywhere.

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
  connectors: ConnectorState[],
): BodyState {
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function revolute(
  mateId: string,
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type: 'revolute',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

// Two-link arm: A (grounded) —m1— B —m2— C, links 50 mm each.
// Connectors: every body has h1 at its local origin; A and B also have
// h2 at local (50, 0, 0).
function buildArm(m1Options?: MateRecord['options']): {
  bodies: BodyState[];
  mates: MateRecord[];
  conns: Record<string, ConnectorState>;
} {
  const aH1 = flatConnector('h1');
  const bH1 = flatConnector('h1');
  const bH2 = flatConnector('h2', 50, 0);
  const cH1 = flatConnector('h1');
  const cH2 = flatConnector('h2', 50, 0);
  const bodies = [
    body('A', true, new Vector3(0, 0, 0), [aH1]),
    body('B', false, new Vector3(0, 0, 0), [bH1, bH2]),
    body('C', false, new Vector3(50, 0, 0), [cH1, cH2]),
  ];
  const mates = [
    revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }, m1Options),
    revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
  ];
  return { bodies, mates, conns: { aH1, bH1, bH2, cH1, cH2 } };
}

// Signed hinge angle of m1 (about A.h1's Z) at the solved poses.
function m1Angle(
  out: { bodies: { instanceId: string; position: Vector3; quaternion: Quaternion }[] },
  setup: ReturnType<typeof buildArm>,
): number {
  const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
  const driver: BodyState = {
    instanceId: 'A', grounded: true, connectors: [],
    position: get('A').position, quaternion: get('A').quaternion,
  };
  const follower: BodyState = {
    instanceId: 'B', grounded: false, connectors: [],
    position: get('B').position, quaternion: get('B').quaternion,
  };
  return extract(driver, setup.conns.aH1, follower, setup.conns.bH1).rotZ;
}

describe('mate limits on chained drags (joint-space LM)', () => {
  function settleAndDrag(m1Options?: MateRecord['options']) {
    const solver = new Solver();
    const setup = buildArm(m1Options);
    const settle = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(settle.result).toBe('okay');

    // Drag C's far tip (world ~(100, 0, 0) after settle) up to
    // (0, 80, 0): reachable by the 100 mm arm, but only by swinging m1
    // far past +30°. m1 is NOT the dragged body's own edge, so only the
    // LM box constraint can hold its limit.
    const draggedBodies: BodyState[] = settle.bodies.map(s => ({
      ...setup.bodies.find(b => b.instanceId === s.instanceId)!,
      position: s.position.clone(),
      quaternion: s.quaternion.clone(),
    }));
    const out = solver.solve({
      bodies: draggedBodies,
      mates: setup.mates,
      draggedInstanceId: 'C',
      draggedCursorWorld: new Vector3(0, 80, 0),
      draggedGrabLocal: new Vector3(50, 0, 0),
    });
    return { out, setup };
  }

  it('control: without limits the drag swings m1 well past 30°', () => {
    const { out, setup } = settleAndDrag();
    expect(Math.abs(m1Angle(out, setup))).toBeGreaterThan(45);
  });

  it('an upstream limited joint pins at its bound instead of sailing past (F2)', () => {
    const { out, setup } = settleAndDrag({ limits: [-30, 30] });
    const angle = m1Angle(out, setup);
    expect(angle).toBeLessThanOrEqual(30 + 1e-6);
    expect(angle).toBeCloseTo(30, 3);

    // Tree mates stay exact through the clamped solve.
    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const world = (b: { position: Vector3; quaternion: Quaternion }, c: ConnectorState) =>
      c.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
    expect(world(get('B'), setup.conns.bH1).distanceTo(world(get('A'), setup.conns.aH1)))
      .toBeLessThan(1e-6);
    expect(world(get('C'), setup.conns.cH1).distanceTo(world(get('B'), setup.conns.bH2)))
      .toBeLessThan(1e-6);
  });
});
