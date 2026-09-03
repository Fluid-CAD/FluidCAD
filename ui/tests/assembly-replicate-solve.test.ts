import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  WORLD_BODY_ID,
  makeWorldBody,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Four replicated cylinders on one crank, as the replicate() statement
// produces them: per cylinder a rod and a piston, mated revolute to a crank
// pin, revolute to each other, and slider to the cylinder's bore (an
// assembly connector on the world body). The pins are phased 0/180/180/0
// (inline four), so the solve must place pistons 2 and 3 high and 1 and 4
// low — every loop solved independently from the same warm pose.

const PITCH = 114;
const ROD = 201;
const THROW = 44;
const BORE_Y0 = 159;

function connector(id: string, origin: [number, number, number], normal: [number, number, number], x: [number, number, number] = [1, 0, 0]): ConnectorState {
  return {
    connectorId: id,
    localOrigin: new Vector3(...origin),
    localXDirection: new Vector3(...x),
    localNormal: new Vector3(...normal),
  };
}

function body(instanceId: string, grounded: boolean, position: Vector3, connectors: ConnectorState[]): BodyState {
  return { instanceId, grounded, position, quaternion: new Quaternion(), connectors };
}

function revolute(mateId: string, a: { i: string; c: string }, b: { i: string; c: string }): MateRecord {
  return { mateId, type: 'revolute', connectorA: { instanceId: a.i, connectorId: a.c }, connectorB: { instanceId: b.i, connectorId: b.c } };
}

function slider(mateId: string, a: { i: string; c: string }, b: { i: string; c: string }): MateRecord {
  return { mateId, type: 'slider', connectorA: { instanceId: a.i, connectorId: a.c }, connectorB: { instanceId: b.i, connectorId: b.c } };
}

describe('replicated cylinders solve', () => {
  it('places four pistons on their pins with the crank\'s 0/180/180/0 phasing', () => {
    const phases = [1, -1, -1, 1];
    const pinY = (k: number) => BORE_Y0 + PITCH * k;
    // The crank: grounded at the origin, one pin connector per cylinder with
    // its axis along Y (the crank axis), each at its phase's Z.
    const crank = body('crank', true, new Vector3(0, 0, 0),
      phases.map((sign, k) => connector(`pin${k}`, [0, pinY(k), sign * THROW], [0, 1, 0])));
    const bodies: BodyState[] = [crank];
    const mates: MateRecord[] = [];
    // The bores: assembly connectors, Z up, on the world body.
    const bores = phases.map((_, k) => ({
      connectorId: `bore${k}`,
      name: `bore${k}`,
      owner: '',
      origin: { x: 0, y: pinY(k), z: 0 },
      xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    }));
    phases.forEach((_, k) => {
      // Every replica starts at the SEED's warm pose (cylinder 1's), as the
      // kernel copies it — the mates must pull each one onto its own pin.
      const rod = body(`rod${k}`, false, new Vector3(0, pinY(0), THROW), [
        connector('big', [0, 0, 0], [0, 1, 0]),
        connector('small', [0, 0, ROD], [0, 1, 0]),
      ]);
      const piston = body(`piston${k}`, false, new Vector3(0, pinY(0), THROW + ROD), [
        connector('pin', [0, 0, 0], [0, 1, 0]),
        connector('axis', [0, 0, 0], [0, 0, 1]),
      ]);
      bodies.push(rod, piston);
      mates.push(
        revolute(`m-crank-${k}`, { i: 'crank', c: `pin${k}` }, { i: `rod${k}`, c: 'big' }),
        revolute(`m-rod-${k}`, { i: `rod${k}`, c: 'small' }, { i: `piston${k}`, c: 'pin' }),
        slider(`m-bore-${k}`, { i: WORLD_BODY_ID, c: `bore${k}` }, { i: `piston${k}`, c: 'axis' }),
      );
    });
    bodies.push(makeWorldBody(bores));

    const out = new Solver().solve({ bodies, mates });
    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);
    const byId = new Map(out.bodies.map(b => [b.instanceId, b]));
    // A vertical rod has two closures (piston above or below its pin); the
    // loop relaxation picks a basin per cylinder, so assert what every
    // basin must satisfy: each piston on ITS bore axis, one rod length from
    // ITS pin, with the rod's big end on that pin.
    phases.forEach((sign, k) => {
      const piston = byId.get(`piston${k}`)!;
      const rod = byId.get(`rod${k}`)!;
      expect(piston.position.x).toBeCloseTo(0, 3);
      expect(piston.position.y).toBeCloseTo(pinY(k), 3);
      expect(Math.abs(piston.position.z - sign * THROW)).toBeCloseTo(ROD, 3);
      expect(rod.position.x).toBeCloseTo(0, 3);
      expect(rod.position.y).toBeCloseTo(pinY(k), 3);
      expect(rod.position.z).toBeCloseTo(sign * THROW, 3);
    });
    // The pins' 0/180/180/0 phasing shows in the rod big ends: cylinders 2
    // and 3 sit a full stroke below 1 and 4.
    const bigEndZ = (k: number) => byId.get(`rod${k}`)!.position.z;
    expect(bigEndZ(0) - bigEndZ(1)).toBeCloseTo(2 * THROW, 3);
    expect(bigEndZ(3) - bigEndZ(2)).toBeCloseTo(2 * THROW, 3);
    expect(bigEndZ(0)).toBeCloseTo(bigEndZ(3), 3);
  });
});
