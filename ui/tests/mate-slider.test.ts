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

function slider(
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'slider',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

describe('mate(slider) — phase 08', () => {
  it('grounded + free body, slider mate → 1 DOF', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
  });

  it('two free bodies + slider → 7 DOF (12 - 5)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), false, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(7);
  });

  it('drag along the slider axis translates the carriage', async () => {
    // Rail grounded with Z axis as the slider direction. Drag the carriage
    // by its origin along +Z; carriage origin should track the cursor.
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedCursorWorld: new Vector3(0, 0, 12),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    // The carriage's connector world position should sit 12 units along +Z
    // (the rail's Z axis through origin).
    const cWorld = new Vector3(0, 0, 0).applyQuaternion(carriage.quaternion).add(carriage.position);
    expect(cWorld.x).toBeCloseTo(0, 4);
    expect(cWorld.y).toBeCloseTo(0, 4);
    expect(cWorld.z).toBeCloseTo(12, 4);
  });

  it('drag perpendicular to the axis only moves along the axis (line projection)', async () => {
    // Cursor moves only in +X (perpendicular to the +Z slider axis); the
    // carriage should not move at all (zero axial component). Without line
    // projection the carriage would jitter sideways before snapping back.
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedCursorWorld: new Vector3(50, 0, 0),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    const cWorld = new Vector3(0, 0, 0).applyQuaternion(carriage.quaternion).add(carriage.position);
    expect(Math.abs(cWorld.z)).toBeLessThan(1e-4);
    // x/y stay on the axis line (origin), regardless of cursor x.
    expect(Math.abs(cWorld.x)).toBeLessThan(1e-4);
    expect(Math.abs(cWorld.y)).toBeLessThan(1e-4);
  });

  it('successive drags accumulate the slide value', async () => {
    // After dragging to z=10, a second solve with no drag should preserve
    // z=10 (the slide value persists across solves). Then a fresh drag to
    // z=25 should land there.
    const solver = new Solver();
    await solver.ensureReady();
    const dragTo = (carriagePos: Vector3, cursorZ: number) => solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, carriagePos, [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      draggedCursorWorld: new Vector3(0, 0, cursorZ),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    const o1 = dragTo(new Vector3(0, 0, 0), 10);
    const c1 = o1.bodies.find(o => o.instanceId === ID(1))!;
    expect(c1.position.z).toBeCloseTo(10, 4);

    // No-drag solve preserves position.
    const refresh = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, c1.position.clone(), [flatConnector('c1')], c1.quaternion.clone()),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    const cRefresh = refresh.bodies.find(o => o.instanceId === ID(1))!;
    expect(cRefresh.position.z).toBeCloseTo(10, 4);

    // Subsequent drag continues from the preserved value.
    const o2 = dragTo(cRefresh.position.clone(), 25);
    const c2 = o2.bodies.find(o => o.instanceId === ID(1))!;
    expect(c2.position.z).toBeCloseTo(25, 4);
  });

  it('default warm-starts face-to-face (Z anti-parallel)', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
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
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { flip: true })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(1, 4);
  });

  it('rotate(45) fixes carriage X 45° from rail X around the shared Z', async () => {
    // The slider locks rotation about the shared Z (X axes parallel by
    // default). `.rotate(deg)` shifts the locked angle.
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { rotate: 45 })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aX = new Vector3(1, 0, 0).applyQuaternion(sa.quaternion);
    const bX = new Vector3(1, 0, 0).applyQuaternion(sb.quaternion);
    // Default face-to-face flips Z; the sign of the cross product against
    // shared world Z encodes rotation direction. Use atan2 of (sin, cos)
    // where sin = (aX × bX) · zAxis, cos = aX · bX.
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion).normalize();
    const cos = aX.dot(bX);
    const sin = new Vector3().crossVectors(aX, bX).dot(aZ);
    const angle = (Math.atan2(sin, cos) * 180) / Math.PI;
    expect(Math.abs(angle)).toBeCloseTo(45, 3);
  });

  it('offset(0, 0, 5) gaps the carriage by 5 along the axis at rest', async () => {
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [0, 0, 5] }),
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
    // dropped that 10, breaking the on-axis check by exactly 20 units.
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
        { instanceId: 'B', position: new Vector3(200, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [topConnector] },
      ],
      mates: [{
        mateId: 'm1', type: 'slider',
        connectorA: { instanceId: 'A', connectorId: 'top' },
        connectorB: { instanceId: 'B', connectorId: 'top' },
      }],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    const aConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = topConnector.localOrigin.clone()
      .applyQuaternion(b.quaternion).add(b.position);
    // Both connectors meet on the rail axis (perpendicular distance ≈ 0).
    const aZ = topConnector.localNormal.clone().applyQuaternion(a.quaternion).normalize();
    const diff = bConnWorld.clone().sub(aConnWorld);
    const along = diff.dot(aZ);
    const perp = diff.clone().sub(aZ.clone().multiplyScalar(along));
    expect(perp.length()).toBeLessThan(1e-4);
  });

  it('drag-of-driver carries follower along the axis', async () => {
    // Both bodies free, slider mate. Driving body A by slvs free-body drag
    // moves A; the post-fixup carries B with it.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    await solver.ensureReady();
    // Settle first with both bodies at origin so the slider is satisfied.
    const settle = solver.solve({
      bodies: [
        { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'slider',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
    });
    expect(settle.result).toBe('okay');
    const aSettled = settle.bodies.find(o => o.instanceId === 'A')!;
    const bSettled = settle.bodies.find(o => o.instanceId === 'B')!;

    // Drag A by free-body translation. The slvs dragged[] path moves A's
    // origin to (10, 0, 0); the slider fixup re-derives B from solved A,
    // preserving the slide value (zero in this case).
    const out = solver.solve({
      bodies: [
        { instanceId: 'A', position: aSettled.position.clone(), quaternion: aSettled.quaternion.clone(), grounded: false, connectors: [flat] },
        { instanceId: 'B', position: bSettled.position.clone(), quaternion: bSettled.quaternion.clone(), grounded: false, connectors: [flat] },
      ],
      mates: [{
        mateId: 'm1', type: 'slider',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      draggedInstanceId: 'A',
      draggedTargetOrigin: new Vector3(10, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    // A's origin tracks the drag target.
    expect(a.position.x).toBeCloseTo(10, 4);
    // B's connector still meets A's connector (slide value preserved at 0).
    const aConn = flat.localOrigin.clone().applyQuaternion(a.quaternion).add(a.position);
    const bConn = flat.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
    expect(bConn.distanceTo(aConn)).toBeLessThan(1e-4);
  });

  it('two carriages on one rail slide independently under perpendicular cursor', async () => {
    // Two slider followers sharing one driver (rail fastened to a grounded
    // beam). Dragging carriage1 with a cursor that has a perpendicular
    // component (the camera-aligned drag plane always produces some) used
    // to drag carriage3 along the rail too: LM's chain-drag residual ran
    // with the perp component as the residual (the projection dropped
    // axial, kept perp), so LM compromised by nudging rail/c1/c3 together
    // and c3 inherited a small slide each frame.
    const solver = new Solver();
    await solver.ensureReady();

    const beamConn: ConnectorState = {
      connectorId: 'attach',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 1, 0),
    };
    const railStart: ConnectorState = {
      connectorId: 'start',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 1, 0),
    };
    const railTop: ConnectorState = {
      connectorId: 'top',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const carrConn: ConnectorState = {
      connectorId: 'main',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };

    const mates: MateRecord[] = [
      {
        mateId: 'fasten',
        type: 'fastened',
        connectorA: { instanceId: 'beam', connectorId: 'attach' },
        connectorB: { instanceId: 'rail', connectorId: 'start' },
      },
      {
        mateId: 'sl1',
        type: 'slider',
        connectorA: { instanceId: 'rail', connectorId: 'top' },
        connectorB: { instanceId: 'c1', connectorId: 'main' },
      },
      {
        mateId: 'sl3',
        type: 'slider',
        connectorA: { instanceId: 'rail', connectorId: 'top' },
        connectorB: { instanceId: 'c3', connectorId: 'main' },
      },
    ];

    let bodies: BodyState[] = [
      { instanceId: 'beam', grounded: true, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [beamConn] },
      { instanceId: 'rail', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [railStart, railTop] },
      { instanceId: 'c1', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [carrConn] },
      { instanceId: 'c3', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [carrConn] },
    ];

    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('okay');
    bodies = bodies.map(b => {
      const s = settle.bodies.find(x => x.instanceId === b.instanceId)!;
      return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
    });

    // Drag c1 along +Z with a 3-unit perpendicular (X) cursor offset, which
    // is what the camera-aligned drag plane produces in practice.
    for (let step = 1; step <= 8; step++) {
      const out = solver.solve({
        bodies,
        mates,
        draggedInstanceId: 'c1',
        draggedCursorWorld: new Vector3(3, 0, step * 5),
        draggedGrabLocal: new Vector3(0, 0, 0),
      });
      expect(out.result).toBe('okay');
      bodies = bodies.map(b => {
        const s = out.bodies.find(x => x.instanceId === b.instanceId)!;
        return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
      });
    }

    const c3 = bodies.find(b => b.instanceId === 'c3')!;
    expect(c3.position.z).toBeCloseTo(0, 4);
  });

  it('dragging a rail fastened to a grounded beam does not slide its carriages', async () => {
    // Rail is fully locked (fastened path to a grounded ancestor), so a drag
    // on the rail has no DOFs to consume. Without the fully-locked short-
    // circuit, LM perturbed the rail's pose chasing the drag; the rail
    // itself snapped back via the fastened fixup, but the slider fixup for
    // each carriage projected the perturbed rail pose onto its slide value
    // and the carriages walked along the rail every frame.
    const solver = new Solver();
    await solver.ensureReady();

    const beamConn: ConnectorState = {
      connectorId: 'attach',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 1, 0),
    };
    const railStart: ConnectorState = {
      connectorId: 'start',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 1, 0),
    };
    const railTop: ConnectorState = {
      connectorId: 'top',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const carrConn: ConnectorState = {
      connectorId: 'main',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const mates: MateRecord[] = [
      { mateId: 'fasten', type: 'fastened',
        connectorA: { instanceId: 'beam', connectorId: 'attach' },
        connectorB: { instanceId: 'rail', connectorId: 'start' } },
      { mateId: 'sl1', type: 'slider',
        connectorA: { instanceId: 'rail', connectorId: 'top' },
        connectorB: { instanceId: 'c1', connectorId: 'main' } },
      { mateId: 'sl3', type: 'slider',
        connectorA: { instanceId: 'rail', connectorId: 'top' },
        connectorB: { instanceId: 'c3', connectorId: 'main' } },
    ];

    let bodies: BodyState[] = [
      { instanceId: 'beam', grounded: true, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [beamConn] },
      { instanceId: 'rail', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [railStart, railTop] },
      { instanceId: 'c1', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [carrConn] },
      { instanceId: 'c3', grounded: false, position: new Vector3(0, 0, 0), quaternion: new Quaternion(), connectors: [carrConn] },
    ];

    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('okay');
    bodies = bodies.map(b => {
      const s = settle.bodies.find(x => x.instanceId === b.instanceId)!;
      return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
    });

    for (let step = 1; step <= 5; step++) {
      const out = solver.solve({
        bodies, mates,
        draggedInstanceId: 'rail',
        draggedCursorWorld: new Vector3(3, 0, step * 5),
        draggedGrabLocal: new Vector3(0, 0, 0),
      });
      expect(out.result).toBe('okay');
      bodies = bodies.map(b => {
        const s = out.bodies.find(x => x.instanceId === b.instanceId)!;
        return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
      });
    }

    const c1 = bodies.find(b => b.instanceId === 'c1')!;
    const c3 = bodies.find(b => b.instanceId === 'c3')!;
    expect(c1.position.z).toBeCloseTo(0, 4);
    expect(c3.position.z).toBeCloseTo(0, 4);
  });

  it('grab-offset drag projects correctly along the axis', async () => {
    // Grab the carriage at a point off its body origin (grab on +X face).
    // Cursor moves along +Z; the grab point should track the cursor and
    // body should translate so the grab world equals the cursor.
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(0, 0, 0), [flatConnector('c1')]),
      ],
      mates: [slider({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
      draggedInstanceId: ID(1),
      // Grab on the +X face of the carriage (5 units off origin), drag
      // cursor to (5, 0, 8). Axial component along axis (Z) is 8 → carriage
      // slides to z=8.
      draggedGrabLocal: new Vector3(5, 0, 0),
      draggedCursorWorld: new Vector3(5, 0, 8),
    });
    expect(out.result).toBe('okay');
    const carriage = out.bodies.find(o => o.instanceId === ID(1))!;
    expect(carriage.position.z).toBeCloseTo(8, 4);
  });
});
