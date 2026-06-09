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
): BodyState {
  return {
    instanceId,
    position,
    quaternion: new Quaternion(),
    grounded,
    connectors,
  };
}

function revolute(
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId: `${a.i}:${a.c}->${b.i}:${b.c}`,
    type: 'revolute',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

describe('mate(revolute) — phase 07', () => {
  it('grounded + free body, revolute mate → 1 DOF', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 30, 0), [flatConnector('c1')]),
      ],
      mates: [revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
  });

  it('connector origins coincide after solve', async () => {
    const a = flatConnector('c0', 2, 3);
    const b = flatConnector('c1', -1, 4);
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [a]),
        body(ID(1), false, new Vector3(50, 0, 0), [b]),
      ],
      mates: [revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aWorld = a.localOrigin.clone().applyQuaternion(sa.quaternion).add(sa.position);
    const bWorld = b.localOrigin.clone().applyQuaternion(sb.quaternion).add(sb.position);
    expect(bWorld.distanceTo(aWorld)).toBeLessThan(1e-5);
  });

  it('connector Z axes are parallel after solve', async () => {
    const a = flatConnector('c0');
    const b = flatConnector('c1');
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [a]),
        body(ID(1), false, new Vector3(50, 0, 30), [b]),
      ],
      mates: [revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = a.localNormal.clone().applyQuaternion(sa.quaternion);
    const bZ = b.localNormal.clone().applyQuaternion(sb.quaternion);
    // PARALLEL allows either sign; default warm-start picks face-to-face.
    expect(Math.abs(Math.abs(aZ.dot(bZ)) - 1)).toBeLessThan(1e-5);
  });

  it('two free bodies + revolute → 7 DOF (12 - 5)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), false, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(7);
  });

  it('drag from either end of a centered bar rotates the same direction', async () => {
    // The reverse-rotation bug: a long bar with the connector at body
    // center, mated revolute at world origin. Grabbing the +x end and
    // dragging cursor +y should rotate the bar CCW; grabbing the -x end
    // and dragging cursor +y should rotate the bar CW. Pre-fix, the
    // body-origin formulation gave the same sign for both ends because
    // the grab point's arc direction wasn't considered.
    //
    // Concretely: drag-of-grab-+y should rotate the GRAB POINT in the
    // +y direction along its arc. The other end then moves in -y. Grab
    // direction differs → rotation sign differs.
    const solver = new Solver();
    // Bar from (-L, 0, 0) to (L, 0, 0), connector at body center
    // (which equals body origin for this test).
    const L = 10;
    const flat: ConnectorState = {
      connectorId: 'mid',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };

    // Driver bar grounded at origin, follower bar grounded somewhere else
    // (we use the follower for the rotation test).
    const dragOnce = (grabLocal: Vector3, cursorWorld: Vector3) => {
      return solver.solve({
        bodies: [
          { instanceId: 'A', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [flat] },
          { instanceId: 'B', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: false, connectors: [flat] },
        ],
        mates: [{
          mateId: 'm1', type: 'revolute',
          connectorA: { instanceId: 'A', connectorId: 'mid' },
          connectorB: { instanceId: 'B', connectorId: 'mid' },
        }],
        draggedInstanceId: 'B',
        draggedCursorWorld: cursorWorld,
        draggedGrabLocal: grabLocal,
      });
    };

    // Grab the +x end, drag cursor up in +y. Expected: B rotates CCW
    // about Z so the grab point moves +y. After rotation, grab world
    // should be in the +y half-plane.
    const outRight = dragOnce(new Vector3(L, 0, 0), new Vector3(L, 5, 0));
    const bRight = outRight.bodies.find(o => o.instanceId === 'B')!;
    const grabRightWorld = new Vector3(L, 0, 0).applyQuaternion(bRight.quaternion).add(bRight.position);
    expect(grabRightWorld.y).toBeGreaterThan(0);

    // Grab the -x end, drag cursor up in +y. Expected: B rotates CW so
    // the grab point moves +y. After rotation, grab world (which started
    // at -x) should be in the +y half-plane and -x quadrant.
    const outLeft = dragOnce(new Vector3(-L, 0, 0), new Vector3(-L, 5, 0));
    const bLeft = outLeft.bodies.find(o => o.instanceId === 'B')!;
    const grabLeftWorld = new Vector3(-L, 0, 0).applyQuaternion(bLeft.quaternion).add(bLeft.position);
    expect(grabLeftWorld.y).toBeGreaterThan(0);

    // Sanity check: the rotations are *opposite* signs (one CCW, one CW)
    // because the grab points are on opposite sides of the pivot.
    // Reading the body's qz (about world Z) gives the rotation sign
    // when the rotation axis is +Z.
    expect(bRight.quaternion.z * bLeft.quaternion.z).toBeLessThan(0);
  });

  it('default warm-starts face-to-face (Z anti-parallel)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' })],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    // Default revolute warm-start is face-to-face (anti-parallel), matching
    // fastened. Slvs's PARALLEL preserves whichever sign the warm-start chose.
    expect(bZ.dot(aZ)).toBeCloseTo(-1, 4);
  });

  it('flip() warm-starts back-to-back (Z parallel)', async () => {
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { flip: true }),
      ],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aZ = new Vector3(0, 0, 1).applyQuaternion(sa.quaternion);
    const bZ = new Vector3(0, 0, 1).applyQuaternion(sb.quaternion);
    expect(bZ.dot(aZ)).toBeCloseTo(1, 4);
  });

  it('offset(0, 0, 5) gaps the bodies along the shared Z', async () => {
    // The JS-side warm-start handles the offset analytically.
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        body(ID(0), true, new Vector3(0, 0, 0), [flatConnector('c0')]),
        body(ID(1), false, new Vector3(50, 0, 0), [flatConnector('c1')]),
      ],
      mates: [
        revolute({ i: ID(0), c: 'c0' }, { i: ID(1), c: 'c1' }, { offset: [0, 0, 5] }),
      ],
    });
    expect(out.result).toBe('okay');
    const sa = out.bodies.find(o => o.instanceId === ID(0))!;
    const sb = out.bodies.find(o => o.instanceId === ID(1))!;
    const aWorld = new Vector3(0, 0, 0).applyQuaternion(sa.quaternion).add(sa.position);
    const bWorld = new Vector3(0, 0, 0).applyQuaternion(sb.quaternion).add(sb.position);
    expect(bWorld.distanceTo(aWorld)).toBeCloseTo(5, 4);
  });

  it('top-face connectors meet face-to-face in world (no Z-projection bug)', async () => {
    // Reproduces the user-reported issue: two boxes 10x10x10 with a
    // connector on the top face. Default revolute should put them face-to-
    // face with the connector world positions coincident — not offset by
    // 20 in Z (the slvs POINT_IN_2D Z-projection bug that motivated
    // moving revolute to JS-side handling).
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
        mateId: 'm1', type: 'revolute',
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
    expect(bConnWorld.distanceTo(aConnWorld)).toBeLessThan(1e-5);
  });

  it('drag-of-driver pulls follower along (post-fixup)', async () => {
    // Both bodies free, revolute mate. Drag the driver (A); the follower
    // (B) should track A's connector via the post-solve fixup. Equivalent
    // to fastened's "driver drag carries follower" test for revolute.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 5),
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
        mateId: 'm1', type: 'revolute',
        connectorA: { instanceId: 'A', connectorId: 'c' },
        connectorB: { instanceId: 'B', connectorId: 'c' },
      }],
      draggedInstanceId: 'A',
      draggedTargetOrigin: new Vector3(20, 0, 0),
    });
    expect(out.result).toBe('okay');
    const a = out.bodies.find(o => o.instanceId === 'A')!;
    const b = out.bodies.find(o => o.instanceId === 'B')!;
    expect(a.position.x).toBeCloseTo(20, 4);
    const aConnWorld = flat.localOrigin.clone().applyQuaternion(a.quaternion).add(a.position);
    const bConnWorld = flat.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
    expect(bConnWorld.distanceTo(aConnWorld)).toBeLessThan(1e-4);
  });

  it('drag of fastened sibling rotates the cluster around the revolute pivot', async () => {
    // Layout:
    //   i1 grounded
    //   i2 fastened to i3
    //   i2 revolute to i1
    // Pre-fix: dragging i3 picked i3 as the fastened driver, which let
    //   the fastened fixup overwrite the revolute relation — i2 and i3
    //   moved freely with the cursor instead of pivoting around i1.
    // With cluster-aware role picking, i2 (which has the revolute mate)
    //   drives the fastened pair. Dragging i3 rotates the rigid cluster
    //   around i1's pivot, with i3's grab point tracking the cursor.
    const flat: ConnectorState = {
      connectorId: 'c',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();

    // Initial poses chosen so the mates are already satisfied:
    //   i1 at origin; i2 face-to-face fastened with i1's axis (will be
    //   placed by the warm-start). For test simplicity, seed i2 at origin
    //   facing the same way and let warm-start settle. i3 is fastened to
    //   i2 — also seeded near origin.
    const initial = (instanceId: string, grounded: boolean, x = 0) => ({
      instanceId,
      position: new Vector3(x, 0, 0),
      quaternion: new Quaternion(),
      grounded,
      connectors: [flat],
    });

    // Settle the cluster first (no drag).
    const settle = solver.solve({
      bodies: [
        initial('i1', true),
        initial('i2', false, 50),
        initial('i3', false, 100),
      ],
      mates: [
        {
          mateId: 'fast', type: 'fastened',
          connectorA: { instanceId: 'i2', connectorId: 'c' },
          connectorB: { instanceId: 'i3', connectorId: 'c' },
        },
        {
          mateId: 'rev', type: 'revolute',
          connectorA: { instanceId: 'i2', connectorId: 'c' },
          connectorB: { instanceId: 'i1', connectorId: 'c' },
        },
      ],
    });
    expect(settle.result).toBe('okay');
    const i2Settled = settle.bodies.find(b => b.instanceId === 'i2')!;
    const i3Settled = settle.bodies.find(b => b.instanceId === 'i3')!;
    // Connectors of the fastened pair must coincide and i2's connector
    // must coincide with i1's at world origin.
    const i2ConnWorld = flat.localOrigin.clone()
      .applyQuaternion(i2Settled.quaternion).add(i2Settled.position);
    const i3ConnWorld = flat.localOrigin.clone()
      .applyQuaternion(i3Settled.quaternion).add(i3Settled.position);
    expect(i2ConnWorld.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-4);
    expect(i3ConnWorld.distanceTo(i2ConnWorld)).toBeLessThan(1e-4);

    // Now grab a point on i3, far from the pivot (so a rotation produces
    // visible motion), and drag the cursor to a target on the rotation
    // circle. With the bug, i3 would just translate to the cursor and i2
    // would follow it, leaving the revolute violated.
    const grabLocalOnI3 = new Vector3(20, 0, 0);
    const grabBefore = grabLocalOnI3.clone()
      .applyQuaternion(i3Settled.quaternion).add(i3Settled.position);
    const radius = grabBefore.length(); // distance to pivot at world origin
    const cursor = new Vector3(0, radius, 0);

    const drag = solver.solve({
      bodies: [
        { instanceId: 'i1', position: new Vector3(0, 0, 0), quaternion: new Quaternion(), grounded: true, connectors: [flat] },
        { instanceId: 'i2', position: i2Settled.position.clone(), quaternion: i2Settled.quaternion.clone(), grounded: false, connectors: [flat] },
        { instanceId: 'i3', position: i3Settled.position.clone(), quaternion: i3Settled.quaternion.clone(), grounded: false, connectors: [flat] },
      ],
      mates: [
        {
          mateId: 'fast', type: 'fastened',
          connectorA: { instanceId: 'i2', connectorId: 'c' },
          connectorB: { instanceId: 'i3', connectorId: 'c' },
        },
        {
          mateId: 'rev', type: 'revolute',
          connectorA: { instanceId: 'i2', connectorId: 'c' },
          connectorB: { instanceId: 'i1', connectorId: 'c' },
        },
      ],
      draggedInstanceId: 'i3',
      draggedCursorWorld: cursor,
      draggedGrabLocal: grabLocalOnI3,
    });
    expect(drag.result).toBe('okay');

    const i2Drag = drag.bodies.find(b => b.instanceId === 'i2')!;
    const i3Drag = drag.bodies.find(b => b.instanceId === 'i3')!;
    // Revolute is preserved: i2's connector still at the pivot (origin).
    const i2ConnAfter = flat.localOrigin.clone()
      .applyQuaternion(i2Drag.quaternion).add(i2Drag.position);
    expect(i2ConnAfter.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-4);
    // Fastened is preserved: i3's connector coincides with i2's.
    const i3ConnAfter = flat.localOrigin.clone()
      .applyQuaternion(i3Drag.quaternion).add(i3Drag.position);
    expect(i3ConnAfter.distanceTo(i2ConnAfter)).toBeLessThan(1e-4);
    // Drag took effect: i3's grab point landed at (or very close to) the
    // cursor target on the rotation circle.
    const grabAfter = grabLocalOnI3.clone()
      .applyQuaternion(i3Drag.quaternion).add(i3Drag.position);
    expect(grabAfter.distanceTo(cursor)).toBeLessThan(1e-3);
  });

  it('chained revolutes sharing a body don\'t override each other on load', async () => {
    // Reproduces the example1.assembly.js bug:
    //   bottom grounded
    //   mate1 revolute(bottom.h1, left.h1)
    //   mate2 revolute(top.h1, left.h2)
    // Pre-fix: mate2's warm-start treated `left` as a free follower and
    //   reseeded its pose from `top`, breaking mate1 (the bottom-left
    //   connection visibly disconnected on load). With "priorlyLockedIds"
    //   threading, mate1 locks `left` first; mate2 sees `left` as fixed
    //   and instead computes `top` from it.
    const h1: ConnectorState = {
      connectorId: 'h1',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const h2: ConnectorState = {
      connectorId: 'h2',
      localOrigin: new Vector3(40, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    const out = solver.solve({
      bodies: [
        // Source-order: bottom, top, left.
        body('bottom', true, new Vector3(0, 0, 0), [h1, h2]),
        body('top', false, new Vector3(0, 50, 0), [h1, h2]),
        body('left', false, new Vector3(0, 100, 0), [h1, h2]),
      ],
      mates: [
        revolute({ i: 'bottom', c: 'h1' }, { i: 'left', c: 'h1' }),
        revolute({ i: 'top', c: 'h1' }, { i: 'left', c: 'h2' }),
      ],
    });
    expect(out.result).toBe('okay');
    const bottomOut = out.bodies.find(b => b.instanceId === 'bottom')!;
    const topOut = out.bodies.find(b => b.instanceId === 'top')!;
    const leftOut = out.bodies.find(b => b.instanceId === 'left')!;
    // mate1: bottom.h1 ↔ left.h1 must coincide.
    const bottomH1 = h1.localOrigin.clone()
      .applyQuaternion(bottomOut.quaternion).add(bottomOut.position);
    const leftH1 = h1.localOrigin.clone()
      .applyQuaternion(leftOut.quaternion).add(leftOut.position);
    expect(leftH1.distanceTo(bottomH1)).toBeLessThan(1e-4);
    // mate2: top.h1 ↔ left.h2 must coincide.
    const topH1 = h1.localOrigin.clone()
      .applyQuaternion(topOut.quaternion).add(topOut.position);
    const leftH2 = h2.localOrigin.clone()
      .applyQuaternion(leftOut.quaternion).add(leftOut.position);
    expect(topH1.distanceTo(leftH2)).toBeLessThan(1e-4);
  });

  it('chained revolutes preserve mate1 when dragging the tip body', async () => {
    // Same chain as above, but now drag `top` (the tip). Pre-fix, mate2
    // would re-pose `left` to follow `top`, breaking mate1 (bottom-left
    // visibly disconnects). With the lock-respect fix, mate1 stays
    // satisfied: `left` is locked at bottom-h1 first, then mate2 makes
    // `top` follow `left` (top can rotate around left.h2 with 1 DOF).
    const h1: ConnectorState = {
      connectorId: 'h1',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const h2: ConnectorState = {
      connectorId: 'h2',
      localOrigin: new Vector3(40, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const solver = new Solver();
    // First settle the assembly with no drag.
    const settle = solver.solve({
      bodies: [
        body('bottom', true, new Vector3(0, 0, 0), [h1, h2]),
        body('top', false, new Vector3(0, 50, 0), [h1, h2]),
        body('left', false, new Vector3(0, 100, 0), [h1, h2]),
      ],
      mates: [
        revolute({ i: 'bottom', c: 'h1' }, { i: 'left', c: 'h1' }),
        revolute({ i: 'top', c: 'h1' }, { i: 'left', c: 'h2' }),
      ],
    });
    expect(settle.result).toBe('okay');
    // Now drag `top` to a new cursor target. mate1 (bottom↔left) must
    // remain satisfied; the chain should not break apart.
    const settledBodies: BodyState[] = settle.bodies.map(b => ({
      instanceId: b.instanceId,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      grounded: b.instanceId === 'bottom',
      connectors: [h1, h2],
    }));
    const topSettled = settle.bodies.find(b => b.instanceId === 'top')!;
    const grabLocalOnTop = new Vector3(0, 0, 0);
    const grabBefore = grabLocalOnTop.clone()
      .applyQuaternion(topSettled.quaternion).add(topSettled.position);
    const cursor = grabBefore.clone().add(new Vector3(30, 30, 0));
    const out = solver.solve({
      bodies: settledBodies,
      mates: [
        revolute({ i: 'bottom', c: 'h1' }, { i: 'left', c: 'h1' }),
        revolute({ i: 'top', c: 'h1' }, { i: 'left', c: 'h2' }),
      ],
      draggedInstanceId: 'top',
      draggedTargetOrigin: cursor.clone(),
      draggedCursorWorld: cursor.clone(),
      draggedGrabLocal: grabLocalOnTop.clone(),
    });
    expect(out.result).toBe('okay');
    const bottomOut = out.bodies.find(b => b.instanceId === 'bottom')!;
    const leftOut = out.bodies.find(b => b.instanceId === 'left')!;
    const topOut = out.bodies.find(b => b.instanceId === 'top')!;
    // mate1 must still be satisfied — this is the regression.
    const bottomH1 = h1.localOrigin.clone()
      .applyQuaternion(bottomOut.quaternion).add(bottomOut.position);
    const leftH1 = h1.localOrigin.clone()
      .applyQuaternion(leftOut.quaternion).add(leftOut.position);
    expect(leftH1.distanceTo(bottomH1)).toBeLessThan(1e-4);
    // mate2 also satisfied.
    const topH1 = h1.localOrigin.clone()
      .applyQuaternion(topOut.quaternion).add(topOut.position);
    const leftH2 = h2.localOrigin.clone()
      .applyQuaternion(leftOut.quaternion).add(leftOut.position);
    expect(topH1.distanceTo(leftH2)).toBeLessThan(1e-4);
  });
});
