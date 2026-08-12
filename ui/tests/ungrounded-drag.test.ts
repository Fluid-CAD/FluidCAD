import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Regression: dragging an ungrounded part (or a member of an ungrounded
// fastened cluster) must translate it rigidly — no rotation bleed. The
// joint-space LM briefly ran on these drag-only components with the
// free root's 6 DOF as variables against only the 3-row drag residual;
// the under-determined damped step leaked into rotation and the cluster
// visibly tumbled while following the cursor ("juggles and moves
// strangely").

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
  position: Vector3,
  connectors: ConnectorState[],
): BodyState {
  return {
    instanceId,
    position,
    quaternion: new Quaternion(),
    grounded: false,
    connectors,
  };
}

function fastened(
  a: { i: string; c: string },
  b: { i: string; c: string },
): MateRecord {
  return {
    mateId: 'm1',
    type: 'fastened',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
  };
}

// Rotation drift of a solved body relative to its input orientation.
function orientationDrift(
  solved: { quaternion: Quaternion },
  reference: Quaternion,
): number {
  return 1 - Math.abs(solved.quaternion.dot(reference));
}

describe('dragging ungrounded parts translates rigidly (no tumble)', () => {
  it('a mateless free body follows the cursor without rotating', () => {
    const out = new Solver().solve({
      bodies: [body('A', new Vector3(10, 20, 0), [flatConnector('c')])],
      mates: [],
      draggedInstanceId: 'A',
      draggedCursorWorld: new Vector3(60, 45, 5),
      draggedGrabLocal: new Vector3(5, 2, 0),
    });
    const A = out.bodies.find(b => b.instanceId === 'A')!;
    expect(orientationDrift(A, new Quaternion())).toBeLessThan(1e-12);
    const grab = new Vector3(5, 2, 0).applyQuaternion(A.quaternion).add(A.position);
    expect(grab.distanceTo(new Vector3(60, 45, 5))).toBeLessThan(1e-9);
  });

  it('dragging the CHILD of an ungrounded fastened pair moves the whole cluster rigidly', () => {
    const solver = new Solver();
    const mates = [fastened({ i: 'A', c: 'ca' }, { i: 'B', c: 'cb' })];
    const build = () => [
      body('A', new Vector3(0, 0, 0), [flatConnector('ca', 10, 0)]),
      body('B', new Vector3(0, 0, 0), [flatConnector('cb')]),
    ];
    const settle = solver.solve({ bodies: build(), mates });
    expect(settle.result).toBe('okay');
    const a0 = settle.bodies.find(b => b.instanceId === 'A')!;
    const b0 = settle.bodies.find(b => b.instanceId === 'B')!;

    // Drag B (the tree child, warm-start-locked) by 30 mm.
    const dragged = solver.solve({
      bodies: build().map(bd => {
        const s = settle.bodies.find(o => o.instanceId === bd.instanceId)!;
        return { ...bd, position: s.position.clone(), quaternion: s.quaternion.clone() };
      }),
      mates,
      draggedInstanceId: 'B',
      draggedCursorWorld: b0.position.clone().add(new Vector3(30, -12, 7)),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    expect(dragged.result).toBe('okay');

    const A = dragged.bodies.find(b => b.instanceId === 'A')!;
    const B = dragged.bodies.find(b => b.instanceId === 'B')!;
    // No rotation on either body.
    expect(orientationDrift(A, a0.quaternion)).toBeLessThan(1e-12);
    expect(orientationDrift(B, b0.quaternion)).toBeLessThan(1e-12);
    // The grab (B's origin) sits exactly on the cursor and the cluster
    // moved as one rigid piece.
    expect(B.position.distanceTo(b0.position.clone().add(new Vector3(30, -12, 7))))
      .toBeLessThan(1e-9);
    expect(A.position.clone().sub(B.position)
      .distanceTo(a0.position.clone().sub(b0.position))).toBeLessThan(1e-9);
  });

  it('dragging the ROOT of an ungrounded fastened pair carries the follower', () => {
    const solver = new Solver();
    const mates = [fastened({ i: 'A', c: 'ca' }, { i: 'B', c: 'cb' })];
    const bodies = [
      body('A', new Vector3(0, 0, 0), [flatConnector('ca', 10, 0)]),
      body('B', new Vector3(0, 0, 0), [flatConnector('cb')]),
    ];
    const settle = solver.solve({ bodies, mates, draggedInstanceId: 'A' });
    const a0 = settle.bodies.find(b => b.instanceId === 'A')!;
    const b0 = settle.bodies.find(b => b.instanceId === 'B')!;

    const dragged = solver.solve({
      bodies: bodies.map(bd => {
        const s = settle.bodies.find(o => o.instanceId === bd.instanceId)!;
        return { ...bd, position: s.position.clone(), quaternion: s.quaternion.clone() };
      }),
      mates,
      draggedInstanceId: 'A',
      draggedCursorWorld: a0.position.clone().add(new Vector3(-20, 8, 0)),
      draggedGrabLocal: new Vector3(0, 0, 0),
    });
    const A = dragged.bodies.find(b => b.instanceId === 'A')!;
    const B = dragged.bodies.find(b => b.instanceId === 'B')!;
    expect(orientationDrift(A, a0.quaternion)).toBeLessThan(1e-12);
    expect(orientationDrift(B, b0.quaternion)).toBeLessThan(1e-12);
    expect(A.position.distanceTo(a0.position.clone().add(new Vector3(-20, 8, 0))))
      .toBeLessThan(1e-9);
    expect(B.position.clone().sub(A.position)
      .distanceTo(b0.position.clone().sub(a0.position))).toBeLessThan(1e-9);
  });

  it('dragging the follower of an ungrounded revolute keeps the mate exact and reaches the cursor', () => {
    const solver = new Solver();
    const aConn = flatConnector('ca');
    const bConn = flatConnector('cb');
    const mates: MateRecord[] = [{
      mateId: 'm1',
      type: 'revolute',
      connectorA: { instanceId: 'A', connectorId: 'ca' },
      connectorB: { instanceId: 'B', connectorId: 'cb' },
    }];
    const bodies = [
      body('A', new Vector3(0, 0, 0), [aConn]),
      body('B', new Vector3(0, 0, 0), [bConn]),
    ];
    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('okay');

    const cursor = new Vector3(25, 40, 0);
    const dragged = solver.solve({
      bodies: bodies.map(bd => {
        const s = settle.bodies.find(o => o.instanceId === bd.instanceId)!;
        return { ...bd, position: s.position.clone(), quaternion: s.quaternion.clone() };
      }),
      mates,
      draggedInstanceId: 'B',
      draggedCursorWorld: cursor,
      draggedGrabLocal: new Vector3(10, 0, 0),
    });
    expect(dragged.result).toBe('okay');
    expect(dragged.failed).toEqual([]);

    const A = dragged.bodies.find(b => b.instanceId === 'A')!;
    const B = dragged.bodies.find(b => b.instanceId === 'B')!;
    // Grab exactly on the cursor (joint arc + rigid translation).
    const grab = new Vector3(10, 0, 0).applyQuaternion(B.quaternion).add(B.position);
    expect(grab.distanceTo(cursor)).toBeLessThan(1e-6);
    // Revolute still exact: connector origins coincide.
    const aWorld = aConn.localOrigin.clone().applyQuaternion(A.quaternion).add(A.position);
    const bWorld = bConn.localOrigin.clone().applyQuaternion(B.quaternion).add(B.position);
    expect(bWorld.distanceTo(aWorld)).toBeLessThan(1e-9);
  });

  it('repeating the same drag is a fixed point (no per-frame creep)', () => {
    const solver = new Solver();
    const mates = [fastened({ i: 'A', c: 'ca' }, { i: 'B', c: 'cb' })];
    const base = [
      body('A', new Vector3(0, 0, 0), [flatConnector('ca', 10, 0)]),
      body('B', new Vector3(0, 0, 0), [flatConnector('cb')]),
    ];
    const cursor = new Vector3(15, 15, 15);
    let current = solver.solve({ bodies: base, mates }).bodies;
    const posesAfter = (n: number) => {
      for (let i = 0; i < n; i++) {
        current = solver.solve({
          bodies: base.map(bd => {
            const s = current.find(o => o.instanceId === bd.instanceId)!;
            return { ...bd, position: s.position.clone(), quaternion: s.quaternion.clone() };
          }),
          mates,
          draggedInstanceId: 'B',
          draggedCursorWorld: cursor.clone(),
          draggedGrabLocal: new Vector3(0, 0, 0),
        }).bodies;
      }
      return current.map(b => ({ id: b.instanceId, p: b.position.clone(), q: b.quaternion.clone() }));
    };
    const first = posesAfter(1);
    const tenth = posesAfter(9);
    for (const f of first) {
      const t = tenth.find(o => o.id === f.id)!;
      expect(t.p.distanceTo(f.p)).toBeLessThan(1e-12);
      expect(1 - Math.abs(t.q.dot(f.q))).toBeLessThan(1e-12);
    }
  });
});
