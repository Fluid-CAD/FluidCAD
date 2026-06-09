import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { Solver, type BodyState, type ConnectorState, type MateRecord } from '../src/solver';

const ID = (n: number) => `b${n}`;

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
  return {
    instanceId,
    position,
    quaternion: new Quaternion(),
    grounded,
    connectors,
  };
}

function fastened(
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'fastened',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

describe('mate(fastened) — phase 06', () => {
  it('one grounded + one free, fastened: 0 DOF, free body lands at A', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
    const b1 = out.bodies.find(b => b.instanceId === ID(1))!;
    expect(b1.position.x).toBeCloseTo(0, 5);
    expect(b1.position.y).toBeCloseTo(0, 5);
    expect(b1.position.z).toBeCloseTo(0, 5);
  });

  it('two free bodies + fastened: 6 DOF (rigid pair)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), false, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(6);
  });

  it('offset(5, 0, 0) places B at A.connectorOrigin + (5, 0, 0)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0', 2, 3)]),
        body(ID(1), false, new Vector3(99, 99, 99), [flatConnector('c1')]),
      ],
      mates: [
        fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [5, 0, 0] }),
      ],
    });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === ID(1))!;
    // A's connector lives at body-A frame (2, 3, 0). With body A at origin
    // and identity orientation, world coords of A.connector = (2, 3, 0).
    // The offset shifts the target by (5, 0, 0) in body A's frame, so B's
    // connector should land at (7, 3, 0). Since B's connector is at B's
    // origin (localOrigin = 0,0,0), B's origin is also (7, 3, 0).
    expect(b1.position.x).toBeCloseTo(7, 5);
    expect(b1.position.y).toBeCloseTo(3, 5);
    expect(b1.position.z).toBeCloseTo(0, 5);
  });

  it('top-face connectors snap face-to-face and origins overlap', async () => {
    // Reproduces the user-reported case: two identical 10x10x10 boxes,
    // each with a connector on its top face. Default fastened mate should
    // stack them face-to-face with the connector origins coincident in
    // world space — not project the connectors onto the body's xy plane.
    const topConnector: ConnectorState = {
      connectorId: 'top',
      localOrigin: new Vector3(5, 5, 10),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [topConnector] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [topConnector] },
      ],
      mates: [{
        mateId: 'm1', type: 'fastened',
        connectorA: { instanceId: 'A', connectorId: 'top' },
        connectorB: { instanceId: 'B', connectorId: 'top' },
      }],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(0);
    const a = out.bodies.find(b => b.instanceId === 'A')!;
    const b = out.bodies.find(b => b.instanceId === 'B')!;

    // Connector A's world position (driver at origin, identity).
    const aConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    // Connector B's world position (follower).
    const bConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    expect(bConnWorld.x).toBeCloseTo(aConnWorld.x, 5);
    expect(bConnWorld.y).toBeCloseTo(aConnWorld.y, 5);
    expect(bConnWorld.z).toBeCloseTo(aConnWorld.z, 5);

    // Z directions should be anti-parallel (face-to-face).
    const aZ = topConnector.localNormal.clone().applyQuaternion(a.quaternion);
    const bZ = topConnector.localNormal.clone().applyQuaternion(b.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(-1, 5);
  });

  it('drag of follower keeps it locked to the grounded driver', async () => {
    // The user reported that dragging the ungrounded part broke the mate
    // (parts ended up parallel-Z, side-by-side). With the warm-start +
    // post-solve fixup, drag of the follower should leave it pinned to
    // the driver's connector — drag is overruled.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 5),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [flat] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'fastened',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      // User drags follower (B) toward (50, 50, 0) — should be ignored.
      draggedInstanceId: 'B',
      draggedTargetOrigin: new Vector3(50, 50, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(b => b.instanceId === 'A')!;
    const b = out.bodies.find(b => b.instanceId === 'B')!;
    const aConnWorld = flat.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = flat.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    expect(bConnWorld.distanceTo(aConnWorld)).toBeLessThan(1e-5);
  });

  it('drag of free driver translates the follower as a rigid pair', async () => {
    // Two free bodies fastened. Drag the driver (A); the follower (B)
    // tracks it via the post-solve fixup so the pair moves together.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'fastened',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      draggedInstanceId: 'A',
      draggedTargetOrigin: new Vector3(20, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(b => b.instanceId === 'A')!;
    const b = out.bodies.find(b => b.instanceId === 'B')!;
    expect(a.position.x).toBeCloseTo(20, 5);
    // B's connector is at B's origin; should land at A's connector.
    const aConnWorld = flat.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = flat.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    expect(bConnWorld.distanceTo(aConnWorld)).toBeLessThan(1e-5);
  });

  it('default fastened orients the follower face-to-face (Z anti-parallel)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(99, 99, 99), [flatConnector('c1')]),
      ],
      mates: [fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === ID(1))!;
    // Connector A's Z in world (driver at identity) = (0, 0, 1).
    // Connector B's local Z (0, 0, 1) rotated by follower body quat
    // should land on (0, 0, -1) for face-to-face mating.
    const followerConnectorZ = new Vector3(0, 0, 1).applyQuaternion(b1.quaternion);
    expect(followerConnectorZ.x).toBeCloseTo(0, 5);
    expect(followerConnectorZ.y).toBeCloseTo(0, 5);
    expect(followerConnectorZ.z).toBeCloseTo(-1, 5);
  });

  it('flip() produces back-to-back orientation (Z parallel)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { flip: true }),
      ],
    });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === ID(1))!;
    const followerConnectorZ = new Vector3(0, 0, 1).applyQuaternion(b1.quaternion);
    expect(followerConnectorZ.z).toBeCloseTo(1, 5);
  });

  it('rotate(90) rotates follower 90° about driver Z', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { rotate: 90 }),
      ],
    });
    expect(out.result).toBe('okay');
    const b1 = out.bodies.find(b => b.instanceId === ID(1))!;
    // Follower's connector X axis in world should land at (0, 1, 0) — driver
    // X rotated 90° around driver Z. (Default face-to-face Z still applies,
    // but X is rotated.)
    const followerConnectorX = new Vector3(1, 0, 0).applyQuaternion(b1.quaternion);
    expect(Math.abs(followerConnectorX.z)).toBeLessThan(1e-3);
    expect(Math.abs(Math.abs(followerConnectorX.y) - 1)).toBeLessThan(1e-3);
  });

  it('rotate option is recorded on the mate', () => {
    const m = fastened({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { rotate: 90 });
    expect(m.options?.rotate).toBe(90);
  });
});
