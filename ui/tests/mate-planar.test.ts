import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

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
  quaternion: Quaternion = new Quaternion(),
): BodyState {
  return {
    instanceId,
    position,
    quaternion,
    grounded,
    connectors,
  };
}

function planar(
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'planar',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

describe('mate(planar) — phase 10', () => {
  it('grounded + free body, planar mate → 3 DOF', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(3);
  });

  it('two free bodies + planar → 9 DOF (12 - 3)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), false, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(9);
  });

  it('follower-connector origin lies on driver plane after warm-start', async () => {
    const a = flatConnector('c0', 0, 0);
    const b = flatConnector('c1', 0, 0);
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [a]),
        body(ID(1), false, new Vector3(50, 30, 70), [b]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aWorld = a.localOrigin.clone().applyQuaternion(sa.quaternion).add(sa.position);
    const bWorld = b.localOrigin.clone().applyQuaternion(sb.quaternion).add(sb.position);
    const aZ = a.localNormal.clone().applyQuaternion(sa.quaternion).normalize();
    const along = bWorld.clone().sub(aWorld).dot(aZ);
    expect(Math.abs(along)).toBeLessThan(1e-4);
  });

  it('drag in-plane translates the book to the cursor', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(0, 0, 0),
      draggedCursorWorld: new Vector3(7, -4, 0),
    });
    expect(out.result).toBe('okay');
    const book = out.bodies.find(o => o.instanceId === ID(1))!;
    const conn = new Vector3(0, 0, 0).applyQuaternion(book.quaternion).add(book.position);
    expect(conn.x).toBeCloseTo(7, 4);
    expect(conn.y).toBeCloseTo(-4, 4);
    expect(conn.z).toBeCloseTo(0, 4);
  });

  it('drag perpendicular to plane is projected onto the plane', async () => {
    // Cursor includes a Z component (into/out of the plane). The book
    // should ignore that Z and just slide to the in-plane projection.
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(0, 0, 0),
      // Cursor 5 above the plane and 3 along +X; only the +X component should land.
      draggedCursorWorld: new Vector3(3, 0, 5),
    });
    expect(out.result).toBe('okay');
    const book = out.bodies.find(o => o.instanceId === ID(1))!;
    const conn = new Vector3(0, 0, 0).applyQuaternion(book.quaternion).add(book.position);
    expect(conn.x).toBeCloseTo(3, 4);
    expect(conn.y).toBeCloseTo(0, 4);
    expect(conn.z).toBeCloseTo(0, 4);
  });

  it('successive drags accumulate (slide preserved across solves)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const o1 = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(0, 0, 0),
      draggedCursorWorld: new Vector3(5, 0, 0),
    });
    const b1 = o1.bodies.find(o => o.instanceId === ID(1))!;
    expect(b1.position.x).toBeCloseTo(5, 4);

    // Re-solve with no drag: position must persist.
    const refresh = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, b1.position.clone(), [flatConnector('c1')], b1.quaternion.clone()),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    const bR = refresh.bodies.find(o => o.instanceId === ID(1))!;
    expect(bR.position.x).toBeCloseTo(5, 4);

    // Second drag adds a Y component starting from the preserved x=5.
    // grabLocal=(0,0,0), grabWorld = (5, 0, 0); cursor = (5, 6, 0) → +Y delta of 6.
    const o2 = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, bR.position.clone(), [flatConnector('c1')], bR.quaternion.clone()),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(0, 0, 0),
      draggedCursorWorld: new Vector3(5, 6, 0),
    });
    const b2 = o2.bodies.find(o => o.instanceId === ID(1))!;
    expect(b2.position.x).toBeCloseTo(5, 4);
    expect(b2.position.y).toBeCloseTo(6, 4);
  });

  it('default warm-starts face-to-face (Z anti-parallel)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(-1, 4);
  });

  it('flip() warm-starts back-to-back (Z parallel)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { flip: true })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(1, 4);
  });

  it('rotate(45) seeds the angular position', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 50), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { rotate: 45 })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aX = new Vector3(1, 0, 0).applyQuaternion(sa.quaternion);
    const bX = new Vector3(1, 0, 0).applyQuaternion(sb.quaternion);
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion).normalize();
    const cos = aX.dot(bX);
    const sin = new Vector3().crossVectors(aX, bX).dot(aZ);
    const angle = (Math.atan2(sin, cos) * 180) / Math.PI;
    expect(Math.abs(angle)).toBeCloseTo(45, 3);
  });

  it('offset(0, 0, 5) lifts the book 5 above the table; in-plane drag preserves the gap', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 0), [flatConnector('c1')]),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [0, 0, 5] })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aOrigin = new Vector3(0, 0, 0).applyQuaternion(sa.quaternion).add(sa.position);
    const bOrigin = new Vector3(0, 0, 0).applyQuaternion(sb.quaternion).add(sb.position);
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion).normalize();
    // Plane gap is 5 along driver Z (regardless of in-plane position).
    const along = bOrigin.clone().sub(aOrigin).dot(aZ);
    expect(along).toBeCloseTo(5, 4);

    // Now drag in plane — the book should slide and stay 5 above.
    const dragged = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, sb.position.clone(), [flatConnector('c1')], sb.quaternion.clone()),
      ],
      mates: [planar({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [0, 0, 5] })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(0, 0, 0),
      // Move the book to in-plane (10, 0); cursor's Z is the offset gap.
      draggedCursorWorld: new Vector3(10, 0, 5),
    });
    const sd = dragged.bodies.find(o => o.instanceId === ID(1))!;
    const sdConn = new Vector3(0, 0, 0).applyQuaternion(sd.quaternion).add(sd.position);
    expect(sdConn.x).toBeCloseTo(10, 4);
    expect(sdConn.y).toBeCloseTo(0, 4);
    expect(sdConn.z).toBeCloseTo(5, 4);
  });

  it('top-face connectors meet on plane with no Z-projection bug', async () => {
    // Connector authored on the top face (local Z = 10). The slvs
    // POINT_IN_2D limitation that motivated JS-side handling would have
    // dropped the 10, breaking the on-plane check.
    const topConnector: ConnectorState = {
      connectorId: 'top',
      localOrigin: new Vector3(5, 5, 10),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [topConnector] },
        { instanceId: 'B', position: new Vector3(200, 50, 100), quaternion: new Quaternion(), grounded: false, connectors: [topConnector] },
      ],
      mates: [{
        mateId: 'm1', type: 'planar',
        connectorA: { instanceId: 'A', connectorId: 'top' },
        connectorB: { instanceId: 'B', connectorId: 'top' },
      }],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(3);
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    const aConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    const aZ = topConnector.localNormal.clone().applyQuaternion(a.quaternion).normalize();
    const along = Math.abs(bConnWorld.clone().sub(aConnWorld).dot(aZ));
    expect(along).toBeLessThan(1e-4);
  });

  it('drag-of-driver carries follower on the plane', async () => {
    // Both bodies free + planar mate. Driving body A by free-body drag
    // (slvs `dragged[]`) translates A; the post-fixup carries B with it.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    await solver.ensureReady();
    // Settle first with both at origin so the planar is satisfied.
    const settle = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'planar',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
    });
    expect(settle.result).toBe('okay');
    const aSettled = settle.bodies.find(o => o.instanceId === 'A')!;
    const bSettled = settle.bodies.find(o => o.instanceId === 'B')!;

    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: aSettled.position.clone(), quaternion: aSettled.quaternion.clone(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: bSettled.position.clone(), quaternion: bSettled.quaternion.clone(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'planar',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      draggedInstanceId: 'A',
      // Drag A by 12 along +X (in plane); B should follow because the
      // (x, y, angle) state read from the settled poses is (0, 0, 0).
      draggedTargetOrigin: new Vector3(12, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    expect(a.position.x).toBeCloseTo(12, 4);
    const aConn = flat.localOrigin.clone().applyQuaternion(a.quaternion).add(a.position);
    const bConn = flat.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
    // B's connector still in A's plane (perpendicular distance ≈ 0) and
    // in-plane offset preserved (zero).
    const aZWorld = flat.localNormal.clone().applyQuaternion(a.quaternion).normalize();
    const along = Math.abs(bConn.clone().sub(aConn).dot(aZWorld));
    expect(along).toBeLessThan(1e-4);
    expect(bConn.distanceTo(aConn)).toBeLessThan(1e-3);
  });
});
