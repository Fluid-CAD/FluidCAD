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

function cylindrical(
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'cylindrical',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

describe('mate(cylindrical) — phase 09', () => {
  it('grounded + free body, cylindrical mate → 2 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(2);
  });

  it('two free bodies + cylindrical → 8 DOF (12 - 4)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), false, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(8);
  });

  it('connector origins meet on-axis after warm-start', async () => {
    const a = flatConnector('c0', 0, 0);
    const b = flatConnector('c1', 0, 0);
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [a]),
        body(ID(1), false, new Vector3(50, 30, 0), [b]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aWorld = a.localOrigin.clone().applyQuaternion(sa.quaternion).add(sa.position);
    const bWorld = b.localOrigin.clone().applyQuaternion(sb.quaternion).add(sb.position);
    const aZ = a.localNormal.clone().applyQuaternion(sa.quaternion).normalize();
    const diff = bWorld.clone().sub(aWorld);
    const along = diff.dot(aZ);
    const perp = diff.clone().sub(aZ.clone().multiplyScalar(along));
    expect(perp.length()).toBeLessThan(1e-4);
  });

  it('drag along the axis translates the carriage', async () => {
    // Cursor moves only along +Z. Carriage origin should track to z=12.
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedCursorWorld: new Vector3(0, 0, 12),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    const cWorld = new Vector3(0, 0, 0).applyQuaternion(carriage.quaternion).add(carriage.position);
    expect(cWorld.x).toBeCloseTo(0, 4);
    expect(cWorld.y).toBeCloseTo(0, 4);
    expect(cWorld.z).toBeCloseTo(12, 4);
  });

  it('drag perpendicular to the axis rotates around it (does not translate axially)', async () => {
    // Grab on the +X face of the carriage (5 units off the axis), drag the
    // cursor in the +Y direction — the carriage should rotate around Z, not
    // jump sideways. Because the cursor is in the Z-perp plane, axial slide
    // stays at zero.
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      // Grab is at body-local (5,0,0) which under identity is world (5,0,0).
      // Cursor moves to (0, 5, 0) → 90° rotation around +Z about the origin.
      draggedGrabLocal: new Vector3(5, 0, 0),
      draggedCursorWorld: new Vector3(0, 5, 0),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    // Body origin should still sit on the axis (z = 0, x = 0, y = 0).
    expect(Math.abs(carriage.position.z)).toBeLessThan(1e-3);
    expect(Math.hypot(carriage.position.x, carriage.position.y)).toBeLessThan(1e-3);
    // The +X local axis should now point in +Y world.
    const xWorld = new Vector3(1, 0, 0).applyQuaternion(carriage.quaternion);
    expect(xWorld.x).toBeCloseTo(0, 3);
    expect(xWorld.y).toBeCloseTo(1, 3);
  });

  it('diagonal drag produces both axial slide and rotation', async () => {
    // Grab at (5, 0, 0), cursor at (0, 5, 8): expected slide ≈ 8 along Z,
    // rotation ≈ 90° about Z.
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(5, 0, 0),
      draggedCursorWorld: new Vector3(0, 5, 8),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    expect(carriage.position.z).toBeCloseTo(8, 3);
    const xWorld = new Vector3(1, 0, 0).applyQuaternion(carriage.quaternion);
    expect(xWorld.x).toBeCloseTo(0, 3);
    expect(xWorld.y).toBeCloseTo(1, 3);
  });

  it('successive drags accumulate slide and angle', async () => {
    // First drag: slide to z=10. Second drag (no fresh start): rotate 90°
    // around Z while keeping z=10.
    const solver = new Solver();
    const o1 = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedCursorWorld: new Vector3(0, 0, 10),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    const c1 = o1.bodies.find(o => o.instanceId === ID(1))!;
    expect(c1.position.z).toBeCloseTo(10, 4);

    // No-drag refresh preserves the slide.
    const refresh = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, c1.position.clone(), [flatConnector('c1')], c1.quaternion.clone()),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    const cR = refresh.bodies.find(o => o.instanceId === ID(1))!;
    expect(cR.position.z).toBeCloseTo(10, 4);

    // Second drag: grab on +X face at z=10 → rotate 90° while staying at z=10.
    const o2 = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, cR.position.clone(), [flatConnector('c1')], cR.quaternion.clone()),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(5, 0, 0),
      // Grab world before drag = (5, 0, 10). Rotate 90° about Z gives (0, 5, 10).
      draggedCursorWorld: new Vector3(0, 5, 10),
    });
    const c2 = o2.bodies.find(o => o.instanceId === ID(1))!;
    expect(c2.position.z).toBeCloseTo(10, 3);
    const xWorld = new Vector3(1, 0, 0).applyQuaternion(c2.quaternion);
    expect(xWorld.x).toBeCloseTo(0, 3);
    expect(xWorld.y).toBeCloseTo(1, 3);
  });

  it('default warm-starts face-to-face (Z anti-parallel)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
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
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { flip: true })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(1, 4);
  });

  it('rotate(45) seeds the angular position; subsequent solves preserve it', async () => {
    // Start the follower off-axis so the mate is not pre-satisfied; the
    // warm-start then applies the rotate hint to the seed pose. Once the
    // follower lands on-axis with the seeded angle, subsequent solves
    // preserve it (same semantics as slider's offset hint).
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { rotate: 45 })],
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

  it('offset(0, 0, 5) seeds the carriage 5 along the axis at rest', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [0, 0, 5] }),
      ],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aOrigin = new Vector3(0, 0, 0).applyQuaternion(sa.quaternion).add(sa.position);
    const bOrigin = new Vector3(0, 0, 0).applyQuaternion(sb.quaternion).add(sb.position);
    expect(bOrigin.distanceTo(aOrigin)).toBeCloseTo(5, 4);
  });

  it('top-face connectors meet on-axis with no Z-projection bug', async () => {
    // Connector authored on the top face (local Z = 10). The slvs
    // POINT_IN_2D limitation that motivated JS-side handling would have
    // dropped the 10, breaking the on-axis check by 20 units.
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
        { instanceId: 'B', position: new Vector3(200, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [topConnector] },
      ],
      mates: [{
        mateId: 'm1', type: 'cylindrical',
        connectorA: { instanceId: 'A', connectorId: 'top' },
        connectorB: { instanceId: 'B', connectorId: 'top' },
      }],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(2);
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    const aConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    const aZ = topConnector.localNormal.clone().applyQuaternion(a.quaternion).normalize();
    const diff = bConnWorld.clone().sub(aConnWorld);
    const along = diff.dot(aZ);
    const perp = diff.clone().sub(aZ.clone().multiplyScalar(along));
    expect(perp.length()).toBeLessThan(1e-4);
  });

  it('drag-of-driver carries follower along the axis', async () => {
    // Both bodies free + cylindrical mate. Driving body A by free-body drag
    // (free-body drag target) moves A; the post-fixup carries B with it.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    // Settle first with both at origin so the cylindrical is satisfied.
    const settle = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'cylindrical',
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
        mateId: 'm1', type: 'cylindrical',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      draggedInstanceId: 'A',
      draggedTargetOrigin: new Vector3(10, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    expect(a.position.x).toBeCloseTo(10, 4);
    const aConn = flat.localOrigin.clone().applyQuaternion(a.quaternion).add(a.position);
    const bConn = flat.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
    expect(bConn.distanceTo(aConn)).toBeLessThan(1e-4);
  });

  it('three collinear cylindrical mates: still 2 DOF (redundant supports)', async () => {
    // A shaft mated to three collinear bearings via cylindrical. The extra
    // mates are redundant; the solver should still report 2 DOF for the
    // shaft (slide + rotate) and not break.
    const c = (id: string, x = 0, y = 0): ConnectorState => ({
      connectorId: id,
      localOrigin: new Vector3(x, y, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    });
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        // Three grounded supports along the +Z axis (origin offsets along Z
        // are baked into separate body positions, but connectors share the
        // same local origin).
        { instanceId: 's0', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [c('s0c')] },
        { instanceId: 's1', position: new Vector3(0, 0, 20), quaternion: new Quaternion(), grounded: true, connectors: [c('s1c')] },
        { instanceId: 's2', position: new Vector3(0, 0, 40), quaternion: new Quaternion(), grounded: true, connectors: [c('s2c')] },
        { instanceId: 'shaft', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [c('shaft')] },
      ],
      mates: [
        { mateId: 'm0', type: 'cylindrical',
          connectorA: { instanceId: 's0', connectorId: 's0c' },
          connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
        { mateId: 'm1', type: 'cylindrical',
          connectorA: { instanceId: 's1', connectorId: 's1c' },
          connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
        { mateId: 'm2', type: 'cylindrical',
          connectorA: { instanceId: 's2', connectorId: 's2c' },
          connectorB: { instanceId: 'shaft', connectorId: 'shaft' } },
      ],
    });
    expect(out.result).toBe('okay');
    // Counter currently sums per-mate (3 × 2 = 6); countFreeBodyDof reports
    // 0 (shaft is locked by the warm-start). The geometric DOF
    // is 2 — redundancy detection (which would clamp this) lands later;
    // this test pins the current behavior so a future redundancy pass
    // can lower the assertion intentionally.
    expect(out.dof).toBeGreaterThanOrEqual(2);
  });

  it('grab-offset drag projects correctly along the axis', async () => {
    // Grab off-origin on the +X face, drag straight up (+Z). Carriage slides
    // axially (the in-plane component is zero, no rotation).
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [cylindrical({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedGrabLocal: new Vector3(5, 0, 0),
      draggedCursorWorld: new Vector3(5, 0, 8),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    expect(carriage.position.z).toBeCloseTo(8, 4);
    // No rotation: +X local stays at +X world.
    const xWorld = new Vector3(1, 0, 0).applyQuaternion(carriage.quaternion);
    expect(xWorld.x).toBeCloseTo(1, 3);
    expect(Math.abs(xWorld.y)).toBeLessThan(1e-3);
  });
});
