import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  isUsableSolution,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Stage C of the joint-model plan: the solver reports mate health.
// `failed[]` lists every mate whose residual ∞-norm at the FINAL output
// poses exceeds 1e-3; `result` becomes 'inconsistent' when any mate
// fails. Poses still apply — an impossible assembly shows its least-bad
// configuration, the report drives the DOF pill / joints-panel dots.

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

function mate(
  mateId: string,
  type: MateRecord['type'],
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type,
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

function quatZ(degrees: number): Quaternion {
  const half = (degrees * Math.PI) / 360;
  return new Quaternion(0, 0, Math.sin(half), Math.cos(half));
}

function connectorWorld(
  b: { position: Vector3; quaternion: Quaternion },
  conn: ConnectorState,
): Vector3 {
  return conn.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
}

describe('solver diagnostics — failed[] / result', () => {
  it('unclosable fastened triangle reports the closure mate as failed', () => {
    // A (ground): h1@(0,0,0), h2@(10,0,0) — but the B→C chain spans 40,
    // so the loop cannot close. m1 and m3 both touch the ground root
    // directly, so BFS takes them as tree edges (exact through the
    // fixups); m2 is the closure and carries the whole misclosure.
    const aH1 = flatConnector('h1', 0, 0);
    const aH2 = flatConnector('h2', 10, 0);
    const bH1 = flatConnector('h1', 0, 0);
    const bH2 = flatConnector('h2', 20, 0);
    const cH1 = flatConnector('h1', 0, 0);
    const cH2 = flatConnector('h2', 20, 0);
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [aH1, aH2]),
      body('B', false, new Vector3(0, 0, 0), new Quaternion(), [bH1, bH2]),
      body('C', false, new Vector3(0, 0, 0), new Quaternion(), [cH1, cH2]),
    ];
    const mates = [
      mate('m1', 'fastened', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      mate('m2', 'fastened', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      mate('m3', 'fastened', { i: 'C', c: 'h2' }, { i: 'A', c: 'h2' }),
    ];
    const solver = new Solver();
    const out = solver.solve({ bodies, mates });

    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['m2']);
    expect(isUsableSolution(out)).toBe(false);

    // Poses still applied: the tree mates hold exactly.
    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    expect(connectorWorld(get('B'), bH1).distanceTo(connectorWorld(get('A'), aH1)))
      .toBeLessThan(1e-6);
    expect(connectorWorld(get('C'), cH2).distanceTo(connectorWorld(get('A'), aH2)))
      .toBeLessThan(1e-6);
    // Ground never moves.
    expect(get('A').position.length()).toBeLessThan(1e-9);
  });

  it('a violated mate between two grounded bodies reports failed', () => {
    const aH1 = flatConnector('h1');
    const cH1 = flatConnector('h1');
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [aH1]),
      body('C', true, new Vector3(80, 0, 0), new Quaternion(), [cH1]),
    ];
    const mates = [mate('m1', 'fastened', { i: 'A', c: 'h1' }, { i: 'C', c: 'h1' })];
    const solver = new Solver();
    const out = solver.solve({ bodies, mates });

    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['m1']);
    // Neither grounded body moved to "fix" it.
    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    expect(get('A').position.length()).toBeLessThan(1e-9);
    expect(get('C').position.distanceTo(new Vector3(80, 0, 0))).toBeLessThan(1e-9);
  });

  it('the two-ground revolute chain (F1 repro) reports the unreachable closure', () => {
    const aH1 = flatConnector('h1');
    const bH1 = flatConnector('h1');
    const bH2 = flatConnector('h2', 50, 0);
    const cH1 = flatConnector('h1');
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [aH1]),
      body('B', false, new Vector3(20, 10, 0), new Quaternion(), [bH1, bH2]),
      body('C', true, new Vector3(80, 0, 0), new Quaternion(), [cH1]),
    ];
    const mates = [
      mate('m1', 'revolute', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      mate('m2', 'revolute', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
    ];
    const solver = new Solver();
    const out = solver.solve({ bodies, mates });

    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['m2']);
  });

  it('a healthy 4-bar drag frame reports no failures', () => {
    // Parallelogram 4-bar at canonical config (same geometry as
    // mate-loops.test.ts), dragged gently along the crank's reachable
    // arc — the closure stays tight, so failed[] must stay empty.
    const aH1 = flatConnector('h1', 0, 0);
    const aH2 = flatConnector('h2', 100, 0);
    const bH1 = flatConnector('h1', 0, 0);
    const bH2 = flatConnector('h2', 30, 0);
    const cH1 = flatConnector('h1', 0, 0);
    const cH2 = flatConnector('h2', 100, 0);
    const dH1 = flatConnector('h1', 0, 0);
    const dH2 = flatConnector('h2', 30, 0);
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [aH1, aH2]),
      body('B', false, new Vector3(0, 0, 0), quatZ(90), [bH1, bH2]),
      body('C', false, new Vector3(0, 30, 0), new Quaternion(), [cH1, cH2]),
      body('D', false, new Vector3(100, 30, 0), quatZ(-90), [dH1, dH2]),
    ];
    const mates = [
      mate('m1', 'revolute', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      mate('m2', 'revolute', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      mate('m3', 'revolute', { i: 'C', c: 'h2' }, { i: 'D', c: 'h1' }),
      mate('m4', 'revolute', { i: 'D', c: 'h2' }, { i: 'A', c: 'h2' }),
    ];
    const solver = new Solver();
    // B.h2 sits at world (0, 30, 0); nudge it a few degrees along its
    // reachable circle about the origin.
    const out = solver.solve({
      bodies,
      mates,
      draggedInstanceId: 'B',
      draggedCursorWorld: new Vector3(3, 29.85, 0),
      draggedGrabLocal: new Vector3(30, 0, 0),
    });

    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);
    expect(isUsableSolution(out)).toBe(true);
  });

  it('a satisfied fastened pair reports okay', () => {
    const aH1 = flatConnector('h1');
    const bH1 = flatConnector('h1');
    const bodies = [
      body('A', true, new Vector3(0, 0, 0), new Quaternion(), [aH1]),
      body('B', false, new Vector3(40, 0, 0), new Quaternion(), [bH1]),
    ];
    const mates = [mate('m1', 'fastened', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' })];
    const solver = new Solver();
    const out = solver.solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);
  });
});
