import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, type BodyState } from '../src/solver';

function body(id: string, grounded: boolean, x = 0, y = 0, z = 0): BodyState {
  return {
    instanceId: id,
    position: new Vector3(x, y, z),
    quaternion: new Quaternion(),
    grounded,
    connectors: [],
  };
}

describe('Solver drag round-trip (no constraints)', () => {
  it('50 successive drags to the same point produce no drift', async () => {
    const solver = new Solver();

    let bodies: BodyState[] = [body('g', true), body('a', false)];
    const target = new Vector3(7, 3, -2);
    let lastPose: { position: Vector3; quaternion: Quaternion } | null = null;

    for (let i = 0; i < 50; i++) {
      const out = solver.solve({
        bodies,
        mates: [],
        draggedInstanceId: 'a',
        draggedTargetOrigin: target,
      });
      expect(out.result).toBe('okay');
      const a = out.bodies.find(b => b.instanceId === 'a')!;
      expect(a.position.x).toBeCloseTo(target.x, 6);
      expect(a.position.y).toBeCloseTo(target.y, 6);
      expect(a.position.z).toBeCloseTo(target.z, 6);
      // Use solved poses as the next iteration's input — same shape as
      // the live drag loop in AssemblyController.
      bodies = bodies.map(b => {
        const solved = out.bodies.find(s => s.instanceId === b.instanceId)!;
        return { ...b, position: solved.position, quaternion: solved.quaternion };
      });
      if (lastPose) {
        // Grounded body must not drift between solves.
        const g = bodies.find(b => b.instanceId === 'g')!;
        expect(g.position.distanceTo(new Vector3())).toBeLessThan(1e-9);
      }
      lastPose = { position: a.position.clone(), quaternion: a.quaternion.clone() };
    }
  });

  it('grounded body stays put across solves', async () => {
    const solver = new Solver();

    let bodies: BodyState[] = [body('g', true, 1, 2, 3), body('a', false)];
    const targets = [new Vector3(0, 0, 0), new Vector3(5, 0, 0), new Vector3(0, 5, 0)];

    for (const target of targets) {
      const out = solver.solve({
        bodies,
        mates: [],
        draggedInstanceId: 'a',
        draggedTargetOrigin: target,
      });
      expect(out.result).toBe('okay');
      const g = out.bodies.find(b => b.instanceId === 'g')!;
      expect(g.position.x).toBeCloseTo(1, 9);
      expect(g.position.y).toBeCloseTo(2, 9);
      expect(g.position.z).toBeCloseTo(3, 9);
      bodies = bodies.map(b => {
        const solved = out.bodies.find(s => s.instanceId === b.instanceId)!;
        return { ...b, position: solved.position, quaternion: solved.quaternion };
      });
    }
  });
});
