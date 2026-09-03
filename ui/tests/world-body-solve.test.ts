import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, makeWorldBody, matesReferenceWorld, worldConnectorRef } from '../src/solver';
import type { BodyState, MateRecord } from '../src/solver';

// Assembly-connector mates at the solver boundary: a `frameA/frameB` side
// becomes an ordinary connector ref on the synthetic grounded world body
// (makeWorldBody), whose connectors are the assembly's own connectors at
// their built frames — so the solver needs no frame awareness. The world
// body is always a grounded BFS root, i.e. the mate's driver, and mate
// options read in the assembly connector's frame.

function freeBody(instanceId: string, position: [number, number, number]): BodyState {
  return {
    instanceId,
    position: new Vector3(...position),
    quaternion: new Quaternion(0, 0, 0, 1),
    grounded: false,
    connectors: [{
      connectorId: 'c1',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    }],
  };
}

const BASE = {
  connectorId: 'w-base',
  origin: { x: 0, y: 0, z: 0 },
  xDirection: { x: 1, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};
/** `connector('rail', [0, 0, 0]).rotate('y', 90)` — Z along world X. */
const RAIL = {
  connectorId: 'w-rail',
  origin: { x: 0, y: 0, z: 0 },
  xDirection: { x: 0, y: 0, z: -1 },
  normal: { x: 1, y: 0, z: 0 },
};
/** `connector('post', [10, 0, 5])` — translated, world axes. */
const POST = {
  connectorId: 'w-post',
  origin: { x: 10, y: 0, z: 5 },
  xDirection: { x: 1, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

function worldMate(
  type: MateRecord['type'],
  connectorId: string,
  instanceId: string,
  options: MateRecord['options'] = {},
): MateRecord {
  return {
    mateId: 'mate-0',
    type,
    connectorA: worldConnectorRef({ connectorId }),
    connectorB: { instanceId, connectorId: 'c1' },
    options,
  };
}

const connectorWorld = (b: { position: Vector3; quaternion: Quaternion }) =>
  new Vector3(0, 0, 0).applyQuaternion(b.quaternion).add(b.position);

describe('assembly-connector mates in the solver', () => {
  it('fastened to a connector at the origin pins the body connector there, 0 DOF', () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [5, 5, 5]), makeWorldBody([BASE])],
      mates: [worldMate('fastened', 'w-base', 'i1')],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    expect(connectorWorld(solved).length()).toBeLessThan(1e-6);
  });

  it('fastened to a translated connector lands the body at its frame', () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [0, 0, 0]), makeWorldBody([BASE, POST])],
      mates: [worldMate('fastened', 'w-post', 'i1')],
    });
    expect(out.result).toBe('okay');
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    expect(connectorWorld(solved).distanceTo(new Vector3(10, 0, 5))).toBeLessThan(1e-6);
  });

  it("the mate's .offset() reads in the connector's frame (the world side drives)", () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [5, 5, 5]), makeWorldBody([BASE])],
      mates: [worldMate('fastened', 'w-base', 'i1', { offset: [10, 0, 5] })],
    });
    expect(out.result).toBe('okay');
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    expect(connectorWorld(solved).distanceTo(new Vector3(10, 0, 5))).toBeLessThan(1e-6);
  });

  it('revolute to a connector whose Z is world X hinges about world X, 1 DOF', () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [3, 3, 3]), makeWorldBody([RAIL])],
      mates: [worldMate('revolute', 'w-rail', 'i1')],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    // Follower connector origin on the axis point…
    expect(connectorWorld(solved).length()).toBeLessThan(1e-6);
    // …and its Z (local (0,0,1)) anti-parallel to world X (face-to-face default).
    const z = new Vector3(0, 0, 1).applyQuaternion(solved.quaternion);
    expect(Math.abs(z.dot(new Vector3(1, 0, 0)))).toBeCloseTo(1, 6);
  });

  it('a grounded body fastened to an assembly connector reports the closure honestly', () => {
    // Both sides grounded: the mate is a closure between two roots — a
    // conflicting configuration must surface as failed, not vanish.
    const grounded: BodyState = { ...freeBody('i1', [5, 0, 0]), grounded: true };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [grounded, makeWorldBody([BASE])],
      mates: [worldMate('fastened', 'w-base', 'i1')],
    });
    expect(out.result).toBe('inconsistent');
    expect(out.failed).toContain('mate-0');
  });

  it('matesReferenceWorld gates the synthetic body', () => {
    expect(matesReferenceWorld([worldMate('fastened', 'w-base', 'i1')])).toBe(true);
    expect(matesReferenceWorld([{
      mateId: 'm', type: 'fastened',
      connectorA: { instanceId: 'i1', connectorId: 'c1' },
      connectorB: { instanceId: 'i2', connectorId: 'c1' },
    }])).toBe(false);
  });
});
