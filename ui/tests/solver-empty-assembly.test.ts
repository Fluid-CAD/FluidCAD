import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, type BodyState } from '../src/solver';

function freeBody(id: string, x = 0, y = 0, z = 0): BodyState {
  return {
    instanceId: id,
    position: new Vector3(x, y, z),
    quaternion: new Quaternion(),
    grounded: false,
    connectors: [],
  };
}

function groundedBody(id: string, x = 0, y = 0, z = 0): BodyState {
  return { ...freeBody(id, x, y, z), grounded: true };
}

describe('Solver — empty assembly (phase 05)', () => {
  it('grounded body alone has 0 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({ bodies: [groundedBody('a')], mates: [] });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
  });

  it('one grounded + one free body has 6 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [groundedBody('g'), freeBody('a', 5, 5, 5)],
      mates: [],
    });
    expect(out.result).toBe('okay');
    // 7 quat+pos params - 1 implicit unit-norm constraint = 6 free DOFs.
    expect(out.dof).toBe(6);
  });

  it('drag a free body to (10, 0, 0)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [groundedBody('g'), freeBody('a')],
      mates: [],
      draggedInstanceId: 'a',
      draggedTargetOrigin: new Vector3(10, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(b => b.instanceId === 'a')!;
    expect(a.position.x).toBeCloseTo(10, 6);
    expect(a.position.y).toBeCloseTo(0, 6);
    expect(a.position.z).toBeCloseTo(0, 6);
  });

  it('two free bodies report 12 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [freeBody('a'), freeBody('b', 1, 2, 3)],
      mates: [],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(12);
  });

  it('zero bodies returns okay with 0 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({ bodies: [], mates: [] });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
  });
});
