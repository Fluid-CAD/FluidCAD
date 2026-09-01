import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, makeOriginBody, matesReferenceOrigin, originConnectorRef } from '../src/solver';
import type { BodyState, MateRecord } from '../src/solver';

// Origin-frame mates at the solver boundary: a `frameA/frameB` side becomes
// an ordinary connector ref on the synthetic grounded world body
// (makeOriginBody), so the solver needs no frame awareness — the origin is
// always a grounded BFS root, i.e. the mate's driver, and mate options read
// in world coordinates.

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

function originMate(
  type: MateRecord['type'],
  axis: 'x' | 'y' | 'z',
  instanceId: string,
  options: MateRecord['options'] = {},
): MateRecord {
  return {
    mateId: 'mate-0',
    type,
    connectorA: originConnectorRef({ axis }),
    connectorB: { instanceId, connectorId: 'c1' },
    options,
  };
}

const connectorWorld = (b: { position: Vector3; quaternion: Quaternion }) =>
  new Vector3(0, 0, 0).applyQuaternion(b.quaternion).add(b.position);

describe('origin-frame mates in the solver', () => {
  it('fastened to origin pins the body connector at the world origin, 0 DOF', () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [5, 5, 5]), makeOriginBody()],
      mates: [originMate('fastened', 'z', 'i1')],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    expect(connectorWorld(solved).length()).toBeLessThan(1e-6);
  });

  it("the mate's .offset() reads in world coordinates (origin is the driver)", () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [5, 5, 5]), makeOriginBody()],
      mates: [originMate('fastened', 'z', 'i1', { offset: [10, 0, 5] })],
    });
    expect(out.result).toBe('okay');
    const solved = out.bodies.find(b => b.instanceId === 'i1')!;
    const at = connectorWorld(solved);
    expect(at.distanceTo(new Vector3(10, 0, 5))).toBeLessThan(1e-6);
  });

  it("revolute to origin('x') hinges about the world X axis, 1 DOF", () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('i1', [3, 3, 3]), makeOriginBody()],
      mates: [originMate('revolute', 'x', 'i1')],
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

  it('a grounded body fastened to the origin reports the closure honestly', () => {
    // Both sides grounded: the mate is a closure between two roots — a
    // conflicting configuration must surface as failed, not vanish.
    const grounded: BodyState = { ...freeBody('i1', [5, 0, 0]), grounded: true };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [grounded, makeOriginBody()],
      mates: [originMate('fastened', 'z', 'i1')],
    });
    expect(out.result).toBe('inconsistent');
    expect(out.failed).toContain('mate-0');
  });

  it('matesReferenceOrigin gates the synthetic body', () => {
    expect(matesReferenceOrigin([originMate('fastened', 'z', 'i1')])).toBe(true);
    expect(matesReferenceOrigin([{
      mateId: 'm', type: 'fastened',
      connectorA: { instanceId: 'i1', connectorId: 'c1' },
      connectorB: { instanceId: 'i2', connectorId: 'c1' },
    }])).toBe(false);
  });
});
