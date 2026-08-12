import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Stage E of the joint-model plan: closure components report
// `dof = n_vars − rank(J_closure at the solution)` instead of the
// per-mate table sum, so a parallelogram 4-bar reads its true 1 DOF
// (three revolute variables, two independent closure constraints)
// rather than 3.

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
  quaternion: Quaternion,
  connectors: ConnectorState[],
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors };
}

function revolute(
  mateId: string,
  a: { i: string; c: string },
  b: { i: string; c: string },
): MateRecord {
  return {
    mateId,
    type: 'revolute',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
  };
}

function quatZ(degrees: number): Quaternion {
  const half = (degrees * Math.PI) / 360;
  return new Quaternion(0, 0, Math.sin(half), Math.cos(half));
}

// Parallelogram 4-bar at the canonical closed config (see
// mate-loops.test.ts for the geometry).
function buildParallelogram(groundD: boolean): { bodies: BodyState[]; mates: MateRecord[] } {
  const bodies = [
    body('A', true, new Vector3(0, 0, 0), new Quaternion(),
      [flatConnector('h1', 0, 0), flatConnector('h2', 100, 0)]),
    body('B', false, new Vector3(0, 0, 0), quatZ(90),
      [flatConnector('h1', 0, 0), flatConnector('h2', 30, 0)]),
    body('C', false, new Vector3(0, 30, 0), new Quaternion(),
      [flatConnector('h1', 0, 0), flatConnector('h2', 100, 0)]),
    body('D', groundD, new Vector3(100, 30, 0), quatZ(-90),
      [flatConnector('h1', 0, 0), flatConnector('h2', 30, 0)]),
  ];
  const mates = [
    revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
    revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
    revolute('m3', { i: 'C', c: 'h2' }, { i: 'D', c: 'h1' }),
    revolute('m4', { i: 'D', c: 'h2' }, { i: 'A', c: 'h2' }),
  ];
  return { bodies, mates };
}

describe('loop DOF — rank of the closure Jacobian', () => {
  it('parallelogram 4-bar reads 1 DOF (was 3 under the table sum)', () => {
    const { bodies, mates } = buildParallelogram(false);
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
  });

  it('grounding the rocker too turns the 4-bar into a 0-DOF structure', () => {
    // With BOTH A and D grounded only two links move on three revolute
    // joints — Grübler: 3·2 − 2·3 = 0. The m2 closure pins B's tip to
    // the isolated intersection of two circles (rank 2 against the two
    // remaining joint variables), so no free motion is left.
    const { bodies, mates } = buildParallelogram(true);
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
  });

  it('the unreachable two-ground revolute chain reads 0 DOF', () => {
    // F1 repro topology: one revolute variable, and the closure toward
    // the second ground constrains it (rank 1) → no free motion left.
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [flatConnector('h1')]),
      body('B', false, new Vector3(20, 10, 0), new Quaternion(),
        [flatConnector('h1'), flatConnector('h2', 50, 0)]),
      body('C', true, new Vector3(80, 0, 0), new Quaternion(), [flatConnector('h1')]),
    ];
    const mates = [
      revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
    ];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('inconsistent');
    expect(out.dof).toBe(0);
  });

  it('an unclosable all-fastened triangle reads 0 DOF', () => {
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(),
        [flatConnector('h1', 0, 0), flatConnector('h2', 10, 0)]),
      body('B', false, new Vector3(0, 0, 0), new Quaternion(),
        [flatConnector('h1', 0, 0), flatConnector('h2', 20, 0)]),
      body('C', false, new Vector3(0, 0, 0), new Quaternion(),
        [flatConnector('h1', 0, 0), flatConnector('h2', 20, 0)]),
    ];
    const mates: MateRecord[] = [
      { mateId: 'm1', type: 'fastened', connectorA: { instanceId: 'A', connectorId: 'h1' }, connectorB: { instanceId: 'B', connectorId: 'h1' } },
      { mateId: 'm2', type: 'fastened', connectorA: { instanceId: 'B', connectorId: 'h2' }, connectorB: { instanceId: 'C', connectorId: 'h1' } },
      { mateId: 'm3', type: 'fastened', connectorA: { instanceId: 'C', connectorId: 'h2' }, connectorB: { instanceId: 'A', connectorId: 'h2' } },
    ];
    const out = new Solver().solve({ bodies, mates });
    expect(out.dof).toBe(0);
  });

  it('a floating (ungrounded) 4-bar reads 7 DOF: 6 rigid + 1 mechanism', () => {
    const { bodies, mates } = buildParallelogram(false);
    bodies[0].grounded = false;
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(7);
  });

  it('redundant collinear supports keep exactly the shaft DOF', () => {
    // Three grounded bearings on one axis, one shaft, three cylindrical
    // mates. m0 is the tree edge (2 variables); m1/m2 are closures whose
    // residuals don't change as the shaft slides/spins on the shared
    // axis → rank 0 → 2 DOF exactly (the table sum said 6).
    const c = (id: string): ConnectorState => flatConnector(id);
    const bodies = [
      body('s0', true, new Vector3(0, 0, 0), new Quaternion(), [c('s0c')]),
      body('s1', true, new Vector3(0, 0, 20), new Quaternion(), [c('s1c')]),
      body('s2', true, new Vector3(0, 0, 40), new Quaternion(), [c('s2c')]),
      body('shaft', false, new Vector3(0, 0, 0), new Quaternion(), [c('shaft')]),
    ];
    const mates: MateRecord[] = [
      { mateId: 'm0', type: 'cylindrical', connectorA: { instanceId: 's0', connectorId: 's0c' }, connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
      { mateId: 'm1', type: 'cylindrical', connectorA: { instanceId: 's1', connectorId: 's1c' }, connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
      { mateId: 'm2', type: 'cylindrical', connectorA: { instanceId: 's2', connectorId: 's2c' }, connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
    ];
    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(2);
  });
});
