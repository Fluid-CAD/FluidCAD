import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  mateReadoutValue,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Direction-aware mate semantics: options (rotate/offset/flip/limits)
// are authored in connector A's frame, and the solver must honor that
// REGARDLESS of which side the spanning tree drives the mate from.
// Before this fix, a mate whose anchored part was written second (the
// cnc-cad2 x-axis bug) had its options silently applied from the wrong
// side — geometry depended on traversal direction, and the stage-C
// health check flagged the mates as failing.

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
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function mateRecord(
  type: MateRecord['type'],
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: 'm1',
    type,
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

function connWorld(
  b: { position: Vector3; quaternion: Quaternion },
  conn: ConnectorState,
): Vector3 {
  return conn.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
}

function axisWorld(
  b: { position: Vector3; quaternion: Quaternion },
  local: Vector3,
): Vector3 {
  return local.clone().applyQuaternion(b.quaternion).normalize();
}

describe('mate direction awareness — options always mean A-frame', () => {
  it('reversed fastened rotate+offset lands at the AUTHORED position', () => {
    // mate('fastened', A, B).rotate(90).offset(5, 0, 0) with B grounded
    // at world identity. Authored: B's connector sits at
    // A.origin + 5·Ax, face-to-face, B.X = A.X rotated +90° about A.Z.
    // Inverting by hand: A's connector must land at (0, −5, 0) with
    // X = +ŷ and Z = −ẑ. (The old wrong-side behavior put A's
    // connector at (5, 0, 0).)
    const aConn = flatConnector('ac');
    const bConn = flatConnector('bc');
    const bodies = [
      body('A', false, new Vector3(30, 20, 10), [aConn]),
      body('B', true, new Vector3(0, 0, 0), [bConn]),
    ];
    const out = new Solver().solve({
      bodies,
      mates: [mateRecord('fastened', { i: 'A', c: 'ac' }, { i: 'B', c: 'bc' },
        { rotate: 90, offset: [5, 0, 0] })],
    });
    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);

    const A = out.bodies.find(b => b.instanceId === 'A')!;
    expect(connWorld(A, aConn).distanceTo(new Vector3(0, -5, 0))).toBeLessThan(1e-9);
    expect(axisWorld(A, new Vector3(1, 0, 0)).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    expect(axisWorld(A, new Vector3(0, 0, 1)).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('the relative pose is identical whichever side is grounded', () => {
    // Same mate solved twice: once with B grounded (reversed edge),
    // once with A grounded (forward edge). The authored relation must
    // produce the same RELATIVE pose in both solves.
    const aConn = flatConnector('ac', 2, 1);
    const bConn = flatConnector('bc', -3, 4);
    const options: MateRecord['options'] = { rotate: -37, offset: [4, -6, 2.5], flip: true };

    const solveWith = (groundA: boolean) => {
      const bodies = [
        body('A', groundA, new Vector3(groundA ? 0 : 25, 0, 5), [aConn]),
        body('B', !groundA, new Vector3(groundA ? 25 : 0, 0, 5), [bConn]),
      ];
      const out = new Solver().solve({
        bodies,
        mates: [mateRecord('fastened', { i: 'A', c: 'ac' }, { i: 'B', c: 'bc' }, options)],
      });
      expect(out.result).toBe('okay');
      const A = out.bodies.find(b => b.instanceId === 'A')!;
      const B = out.bodies.find(b => b.instanceId === 'B')!;
      // B's pose expressed in A's body frame.
      const relPos = B.position.clone().sub(A.position)
        .applyQuaternion(A.quaternion.clone().invert());
      const relQuat = A.quaternion.clone().invert().multiply(B.quaternion);
      return { relPos, relQuat };
    };

    const fwd = solveWith(true);
    const rev = solveWith(false);
    expect(rev.relPos.distanceTo(fwd.relPos)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(rev.relQuat.dot(fwd.relQuat)) - 1)).toBeLessThan(1e-9);
  });

  it('reversed revolute with lateral offset stays on the authored orbit under drag', () => {
    // mate('revolute', A, B).offset(5, 0, 0), B grounded: authored,
    // A.origin = B.origin − 5·Ax, so A's connector orbits B's at radius
    // 5 as the hinge turns — the option-fixed components rotate with
    // the free angle. Drag A and check the authored relation still
    // holds exactly.
    const aConn = flatConnector('ac');
    const bConn = flatConnector('bc');
    const bodies = [
      body('A', false, new Vector3(10, 0, 0), [aConn]),
      body('B', true, new Vector3(0, 0, 0), [bConn]),
    ];
    const mates = [mateRecord('revolute', { i: 'A', c: 'ac' }, { i: 'B', c: 'bc' },
      { offset: [5, 0, 0] })];
    const solver = new Solver();
    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('okay');

    // Drag A's grab handle to swing the hinge.
    const settled = settle.bodies.find(b => b.instanceId === 'A')!;
    const dragged = solver.solve({
      bodies: [
        { ...bodies[0], position: settled.position.clone(), quaternion: settled.quaternion.clone() },
        bodies[1],
      ],
      mates,
      draggedInstanceId: 'A',
      draggedCursorWorld: new Vector3(3, 7, 0),
      draggedGrabLocal: new Vector3(10, 0, 0),
    });
    expect(dragged.result).toBe('okay');
    expect(dragged.failed).toEqual([]);

    const A = dragged.bodies.find(b => b.instanceId === 'A')!;
    const B = dragged.bodies.find(b => b.instanceId === 'B')!;
    // Authored relation: B.connOrigin − A.connOrigin = 5·Ax exactly.
    const diff = connWorld(B, bConn).sub(connWorld(A, aConn));
    const ax = axisWorld(A, new Vector3(1, 0, 0));
    expect(diff.distanceTo(ax.multiplyScalar(5))).toBeLessThan(1e-6);
  });

  it('reversed slider seeds from the authored z-offset and accumulates drags', () => {
    // mate('slider', A, B).offset(0, 0, 10), B grounded: authored slide
    // datum is A's Z, so A's connector must sit at B.origin + 10·Bz
    // (face-to-face: the two measures agree in sign).
    const aConn = flatConnector('ac');
    const bConn = flatConnector('bc');
    const mates = [mateRecord('slider', { i: 'A', c: 'ac' }, { i: 'B', c: 'bc' },
      { offset: [0, 0, 10] })];
    const solver = new Solver();
    const out1 = solver.solve({
      bodies: [
        body('A', false, new Vector3(7, 7, 7), [aConn]),
        body('B', true, new Vector3(0, 0, 0), [bConn]),
      ],
      mates,
    });
    expect(out1.result).toBe('okay');
    const a1 = out1.bodies.find(b => b.instanceId === 'A')!;
    expect(connWorld(a1, aConn).distanceTo(new Vector3(0, 0, 10))).toBeLessThan(1e-9);

    // Drag the carriage +5 along the axis; the slide accumulates.
    const out2 = solver.solve({
      bodies: [
        { ...body('A', false, a1.position.clone(), [aConn]), quaternion: a1.quaternion.clone() },
        body('B', true, new Vector3(0, 0, 0), [bConn]),
      ],
      mates,
      draggedInstanceId: 'A',
      draggedCursorWorld: new Vector3(0, 0, 15),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    expect(out2.result).toBe('okay');
    const a2 = out2.bodies.find(b => b.instanceId === 'A')!;
    expect(connWorld(a2, aConn).distanceTo(new Vector3(0, 0, 15))).toBeLessThan(1e-6);
  });

  it('reversed+flip limits clamp in AUTHORED space and the readout reads the bound', () => {
    // mate('revolute', A, B).flip().limits(0, 45), B grounded. Under
    // flip the B-side measured angle is the NEGATED authored angle, so
    // the box constraint must clamp against [−45, 0] in B-space while
    // the drag pill still reads the authored value (+45 at the bound).
    const aConn = flatConnector('ac');
    const bConn = flatConnector('bc');
    const mates = [mateRecord('revolute', { i: 'A', c: 'ac' }, { i: 'B', c: 'bc' },
      { flip: true, limits: [0, 45] })];
    const solver = new Solver();
    const settle = solver.solve({
      bodies: [
        body('A', false, new Vector3(1, 2, 3), [aConn]),
        body('B', true, new Vector3(0, 0, 0), [bConn]),
      ],
      mates,
    });
    expect(settle.result).toBe('okay');

    // Drag a handle at A-local (10,0,0) toward −y: A wants to rotate
    // −90° about ẑ (authored angle → +90°), which exceeds the authored
    // max of 45° → pins at authored 45 (actual rotation −45°).
    const settled = settle.bodies.find(b => b.instanceId === 'A')!;
    const out = solver.solve({
      bodies: [
        { ...body('A', false, settled.position.clone(), [aConn]), quaternion: settled.quaternion.clone() },
        body('B', true, new Vector3(0, 0, 0), [bConn]),
      ],
      mates,
      draggedInstanceId: 'A',
      draggedCursorWorld: new Vector3(0, -10, 0),
      draggedGrabLocal: new Vector3(10, 0, 0),
    });
    expect(out.result).toBe('okay');

    const A = out.bodies.find(b => b.instanceId === 'A')!;
    const B = out.bodies.find(b => b.instanceId === 'B')!;
    const grabWorld = new Vector3(10, 0, 0).applyQuaternion(A.quaternion).add(A.position);
    expect(grabWorld.distanceTo(
      new Vector3(10 * Math.cos(-Math.PI / 4), 10 * Math.sin(-Math.PI / 4), 0),
    )).toBeLessThan(1e-6);

    // Readout measured with the tree driver (B) still reports the
    // AUTHORED angle — exactly the clamped bound.
    const driver: BodyState = { ...body('B', true, B.position.clone(), [bConn]), quaternion: B.quaternion.clone() };
    const follower: BodyState = { ...body('A', false, A.position.clone(), [aConn]), quaternion: A.quaternion.clone() };
    const readout = mateReadoutValue(mates[0], driver, bConn, follower, aConn);
    expect(readout?.kind).toBe('angle');
    expect(readout?.value).toBeCloseTo(45, 6);
  });
});
