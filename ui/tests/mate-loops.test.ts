import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Connector with localOrigin at (ox, oy, 0), Z normal up, X along world X.
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
  quaternion: Quaternion,
  connectors: ConnectorState[],
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors };
}

function revolute(
  mateId: string,
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type: 'revolute',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

function fastened(
  mateId: string,
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type: 'fastened',
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

// Quaternion for rotation about world Z by `degrees`.
function quatZ(degrees: number): Quaternion {
  const half = (degrees * Math.PI) / 360;
  return new Quaternion(0, 0, Math.sin(half), Math.cos(half));
}

// World position of a body's connector origin.
function connectorWorld(b: BodyState | { position: Vector3; quaternion: Quaternion }, conn: ConnectorState): Vector3 {
  return conn.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
}

describe('mate-loops — closed loops via LM relaxation', () => {
  // Parallelogram 4-bar:
  //   A (ground): h1 at local (0,0,0), h2 at local (100,0,0).
  //   B (crank): h1 at local (0,0,0), h2 at local (30,0,0).
  //   C (coupler): h1 at local (0,0,0), h2 at local (100,0,0).
  //   D (rocker): h1 at local (0,0,0), h2 at local (30,0,0).
  // Mates:
  //   m1: A.h1 ↔ B.h1   (crank pivot on ground)
  //   m2: B.h2 ↔ C.h1   (crank end to coupler start)
  //   m3: C.h2 ↔ D.h1   (coupler end to rocker start)
  //   m4: D.h2 ↔ A.h2   (rocker end to ground — CLOSURE)
  //
  // Canonical config: B and D both straight up by 90°, C at y=30.
  //   A=(0,0,0) identity. B=(0,0,0) +90°Z. C=(0,30,0) identity. D=(100,30,0) -90°Z.

  function buildParallelogram(): {
    bodies: BodyState[];
    mates: MateRecord[];
    aH1: ConnectorState; aH2: ConnectorState;
    bH1: ConnectorState; bH2: ConnectorState;
    cH1: ConnectorState; cH2: ConnectorState;
    dH1: ConnectorState; dH2: ConnectorState;
  } {
    const aH1 = flatConnector('h1', 0, 0);
    const aH2 = flatConnector('h2', 100, 0);
    const bH1 = flatConnector('h1', 0, 0);
    const bH2 = flatConnector('h2', 30, 0);
    const cH1 = flatConnector('h1', 0, 0);
    const cH2 = flatConnector('h2', 100, 0);
    const dH1 = flatConnector('h1', 0, 0);
    const dH2 = flatConnector('h2', 30, 0);

    const bodies = [
      body('A', true,  new Vector3(0, 0, 0),    new Quaternion(),         [aH1, aH2]),
      body('B', false, new Vector3(0, 0, 0),    quatZ(90),                [bH1, bH2]),
      body('C', false, new Vector3(0, 30, 0),   new Quaternion(),         [cH1, cH2]),
      body('D', false, new Vector3(100, 30, 0), quatZ(-90),               [dH1, dH2]),
    ];
    const mates: MateRecord[] = [
      revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      revolute('m3', { i: 'C', c: 'h2' }, { i: 'D', c: 'h1' }),
      revolute('m4', { i: 'D', c: 'h2' }, { i: 'A', c: 'h2' }),
    ];
    return { bodies, mates, aH1, aH2, bH1, bH2, cH1, cH2, dH1, dH2 };
  }

  it('planar 4-bar at canonical config keeps closure satisfied', async () => {
    // Pre-place bodies at the parallelogram config; verify the solver
    // doesn't break the closure. Without the LM relaxation pass, the
    // closure mate (m4) would be silently ignored — but the warm-start
    // alone already satisfies all 4 mates here, so LM is a no-op. Real
    // value: this proves no regression when a closure happens to be
    // pre-satisfied.
    const setup = buildParallelogram();
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C'), D = get('D');

    // m1: A.h1 ↔ B.h1
    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1))).toBeLessThan(1e-4);
    // m2: B.h2 ↔ C.h1
    expect(connectorWorld(C, setup.cH1).distanceTo(connectorWorld(B, setup.bH2))).toBeLessThan(1e-4);
    // m3: C.h2 ↔ D.h1
    expect(connectorWorld(D, setup.dH1).distanceTo(connectorWorld(C, setup.cH2))).toBeLessThan(1e-4);
    // m4: D.h2 ↔ A.h2 — the closure. THIS is the regression target.
    expect(connectorWorld(A, setup.aH2).distanceTo(connectorWorld(D, setup.dH2))).toBeLessThan(1e-4);
  });

  it('planar 4-bar from a non-canonical seed converges to a closed config', async () => {
    // Same parallelogram, but perturb the coupler and rocker poses by a
    // few millimeters. The warm-start re-seeds tree-edge followers from
    // their drivers (so B → C → D end up daisy-chained from A's h1
    // along x, well off the parallelogram), and LM has to bend the
    // chain back so the closure m4 is satisfied. We accept any LM-valid
    // configuration that closes all four mates.
    const setup = buildParallelogram();
    // Perturb C and D to non-trivial poses so the warm-start must
    // re-seed them (the existing parallelogram config lets warm-start
    // skip re-seeding; we want LM exercise here).
    setup.bodies[2].position.set(50, 30, 0);
    setup.bodies[3].position.set(60, 0, 0);
    setup.bodies[3].quaternion.set(0, 0, 0, 1); // identity → not on parallelogram

    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C'), D = get('D');

    // All four closures within LM tolerance.
    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1))).toBeLessThan(1e-3);
    expect(connectorWorld(C, setup.cH1).distanceTo(connectorWorld(B, setup.bH2))).toBeLessThan(1e-3);
    expect(connectorWorld(D, setup.dH1).distanceTo(connectorWorld(C, setup.cH2))).toBeLessThan(1e-3);
    expect(connectorWorld(A, setup.aH2).distanceTo(connectorWorld(D, setup.dH2))).toBeLessThan(1e-3);
  });

  it('two-body revolute + slider closure stays satisfied', async () => {
    // Tree pick: revolute (more rigid) becomes the tree edge; slider
    // becomes the closure. The connectors are arranged so the
    // warm-start lands directly on the closure-satisfying config; the
    // point is to exercise `residualSlider` in the LM dispatcher and
    // verify it agrees with zero at a known-good pose.
    const aH1 = flatConnector('h1', 0, 0); aH1.localOrigin.set(0, 0, 0);
    const aH2 = flatConnector('h2', 0, 0); aH2.localOrigin.set(0, 0, 30);
    const bH1 = flatConnector('h1', 0, 0); bH1.localOrigin.set(0, 0, 0);
    const bH2 = flatConnector('h2', 0, 0); bH2.localOrigin.set(0, 0, -30);
    // Pre-place B at the face-to-face pose (180° around X) so the
    // tree-edge warm-start is a no-op and LM exercises the slider
    // residual at a known-good state. LM convergence from a 180° rotation
    // away is a stage 4+ concern (better drag handling / warm-start
    // priors).
    const bodies = [
      body('A', true,  new Vector3(0, 0, 0), new Quaternion(),         [aH1, aH2]),
      body('B', false, new Vector3(0, 0, 0), new Quaternion(1, 0, 0, 0), [bH1, bH2]),
    ];
    const mates: MateRecord[] = [
      revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      {
        mateId: 'm2', type: 'slider',
        connectorA: { instanceId: 'A', connectorId: 'h2' },
        connectorB: { instanceId: 'B', connectorId: 'h2' },
      },
    ];
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({ bodies, mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B');
    // Revolute (tree) closure.
    expect(connectorWorld(B, bH1).distanceTo(connectorWorld(A, aH1))).toBeLessThan(1e-4);
    // Slider (closure) — origin must lie on driver Z-axis through A.h2.
    const dZ = aH2.localNormal.clone().applyQuaternion(A.quaternion).normalize();
    const dOrigin = connectorWorld(A, aH2);
    const fOrigin = connectorWorld(B, bH2);
    const diff = fOrigin.sub(dOrigin);
    const along = diff.dot(dZ);
    const perp = diff.sub(dZ.clone().multiplyScalar(along)).length();
    expect(perp).toBeLessThan(1e-4);
  });

  it('drag through revolute chain rotates upstream link', async () => {
    // 3-body chain (no closure):
    //   A (grounded) — revolute — B — revolute — C
    // Each link has connectors h1 at local origin and h2 at local (50, 0, 0).
    // Drag C's far tip; B *and* C must rotate so the grab tracks the
    // cursor. Pre-stage-4 the cluster lookup was fastened-only, so
    // dragging C only rotated C around B.h2 — B stayed put. Stage 4's
    // chain-aware drag (LM treats both B and C as variables, drag is a
    // soft residual) propagates the cursor target through the whole
    // chain.
    const aH1: ConnectorState = {
      connectorId: 'h1',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const aH2: ConnectorState = {
      connectorId: 'h2',
      localOrigin: new Vector3(50, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const bH1 = { ...aH1 };
    const bH2 = { ...aH2 };
    const cH1 = { ...aH1 };
    const cH2 = { ...aH2 };

    const solver = new Solver();
    await solver.ensureReady();

    // Settle the chain at the canonical face-to-face seed (B and C
    // stretched along world +x from A).
    const settle = solver.solve({
      bodies: [
        body('A', true,  new Vector3(0, 0, 0), new Quaternion(),         [aH1, aH2]),
        body('B', false, new Vector3(0, 0, 0), new Quaternion(),         [bH1, bH2]),
        body('C', false, new Vector3(50, 0, 0), new Quaternion(),        [cH1, cH2]),
      ],
      mates: [
        revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
        revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      ],
    });
    expect(settle.result).toBe('okay');

    // Now drag C's far tip (its h2 connector origin) to a target that
    // sits diagonally — reachable but only if BOTH B and C rotate. The
    // chain has total length 100 (50 + 50); cursor at distance ~85 is
    // well inside the reachable annulus.
    const cSettled = settle.bodies.find(b => b.instanceId === 'C')!;
    const grabLocalOnC = new Vector3(50, 0, 0);
    const cursor = new Vector3(60, 60, 0);

    const draggedBodies: BodyState[] = settle.bodies.map(b => ({
      instanceId: b.instanceId,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      grounded: b.instanceId === 'A',
      connectors: b.instanceId === 'A'
        ? [aH1, aH2]
        : b.instanceId === 'B'
          ? [bH1, bH2]
          : [cH1, cH2],
    }));
    void cSettled;

    const out = solver.solve({
      bodies: draggedBodies,
      mates: [
        revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
        revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      ],
      draggedInstanceId: 'C',
      draggedCursorWorld: cursor,
      draggedGrabLocal: grabLocalOnC,
    });
    expect(out.result).toBe('okay');

    const A = out.bodies.find(b => b.instanceId === 'A')!;
    const B = out.bodies.find(b => b.instanceId === 'B')!;
    const C = out.bodies.find(b => b.instanceId === 'C')!;

    // Mate constraints stay satisfied.
    expect(connectorWorld(B, bH1).distanceTo(connectorWorld(A, aH1))).toBeLessThan(1e-3);
    expect(connectorWorld(C, cH1).distanceTo(connectorWorld(B, bH2))).toBeLessThan(1e-3);

    // The grab on C lands at the cursor (within LM tolerance).
    const grabWorld = grabLocalOnC.clone()
      .applyQuaternion(C.quaternion).add(C.position);
    expect(grabWorld.distanceTo(cursor)).toBeLessThan(1e-2);

    // Critically: B rotated. Pre-fix it stayed identity (face-to-face
    // along world +x); a meaningful rotation here proves chain-aware
    // drag is propagating through the upstream revolute.
    const bAxisAngle = 2 * Math.atan2(
      Math.sqrt(B.quaternion.x * B.quaternion.x
        + B.quaternion.y * B.quaternion.y
        + B.quaternion.z * B.quaternion.z),
      Math.abs(B.quaternion.w),
    );
    expect(bAxisAngle).toBeGreaterThan(0.05); // > ~3°
  });

  it('triangle of fastened mates: consistent closure', async () => {
    // Three bodies pinned together at a single connector each, with all
    // three pairs fastened. This is over-constrained but consistent
    // (loop_dof = 0). The orientation parity around the loop forces
    // back-to-back (.flip()) on every edge so the three "Z anti-parallel"
    // rotations cancel on closure. The point is to exercise
    // `residualFastened` (the 6-D residual) inside the LM pass.
    const h: ConnectorState = {
      connectorId: 'h',
      localOrigin: new Vector3(0, 0, 0),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    };
    const bodies = [
      body('A', true,  new Vector3(0, 0, 0), new Quaternion(), [h]),
      body('B', false, new Vector3(0, 0, 0), new Quaternion(), [h]),
      body('C', false, new Vector3(0, 0, 0), new Quaternion(), [h]),
    ];
    const mates: MateRecord[] = [
      fastened('m1', { i: 'A', c: 'h' }, { i: 'B', c: 'h' }, { flip: true }),
      fastened('m2', { i: 'B', c: 'h' }, { i: 'C', c: 'h' }, { flip: true }),
      fastened('m3', { i: 'A', c: 'h' }, { i: 'C', c: 'h' }, { flip: true }),
    ];
    const solver = new Solver();
    await solver.ensureReady();
    const out = solver.solve({ bodies, mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C');
    expect(connectorWorld(B, h).distanceTo(connectorWorld(A, h))).toBeLessThan(1e-4);
    expect(connectorWorld(C, h).distanceTo(connectorWorld(B, h))).toBeLessThan(1e-4);
    expect(connectorWorld(C, h).distanceTo(connectorWorld(A, h))).toBeLessThan(1e-4);
  });

  // Regression for the rhombus 4-bar from
  // ~/projects/sample-cad/assembly/example1.assembly.js — original
  // symptom was a visible ~5–10 mm gap at the closure corner during
  // drag, plus visible body wiggle frame-to-frame. Both came from LM
  // balancing the soft drag residual against the closure mate
  // residuals: with a positive DRAG_WEIGHT, LM compromised drag-vs-
  // closure and converged to a state where neither was zero. The fix
  // is to set CLOSURE_DRAG_WEIGHT = 0 in `loop-relaxation.ts` —
  // warm-start's mate-aware drag rotation already places the dragged
  // body's grab at the cursor analytically, so LM only needs to
  // close the loop. Both happen exactly.
  //
  // Connectors at local Z = 5 (top-face connectors, like the user's
  // extruded slot part) — the original failure mode required this
  // out-of-XY-plane offset for the LM to misconverge.
  //
  // Topology:
  //   bottom — left  (m1, .rotate(-45))   tree
  //   top    — left  (m2)                 tree (left → top)
  //   bottom — right (m3)                 tree
  //   top    — right (m4, .rotate(45))    closure
  // BFS from `bottom`: layer-1 picks {left via m1, right via m3}; layer-2
  // picks top via m2 (from left); m4 becomes the closure.
  it('rhombus 4-bar drag steps preserve closure (regression)', async () => {
    const c1 = (): ConnectorState => ({
      connectorId: 'handle1',
      localOrigin: new Vector3(0, 0, 5),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    });
    const c2 = (): ConnectorState => ({
      connectorId: 'handle2',
      localOrigin: new Vector3(50, 0, 5),
      localXDirection: new Vector3(1, 0, 0),
      localNormal: new Vector3(0, 0, 1),
    });

    const solver = new Solver();
    await solver.ensureReady();

    // Settle from the user's seed: bottom grounded at origin; top, left,
    // right placed with meaningful offsets so the warm-start has work to
    // do but the closure has a valid configuration.
    let bodies: BodyState[] = [
      body('bottom', true,  new Vector3(0, 0, 0),     new Quaternion(),       [c1(), c2()]),
      body('top',    false, new Vector3(0, 50, 0),    new Quaternion(),       [c1(), c2()]),
      body('left',   false, new Vector3(0, 100, 0),   new Quaternion(),       [c1(), c2()]),
      body('right',  false, new Vector3(0, 100, 0),   new Quaternion(),       [c1(), c2()]),
    ];
    const mates: MateRecord[] = [
      revolute('m1', { i: 'bottom', c: 'handle1' }, { i: 'left',  c: 'handle1' }, { rotate: -45 }),
      revolute('m2', { i: 'top',    c: 'handle1' }, { i: 'left',  c: 'handle2' }),
      revolute('m3', { i: 'bottom', c: 'handle2' }, { i: 'right', c: 'handle1' }),
      revolute('m4', { i: 'top',    c: 'handle2' }, { i: 'right', c: 'handle2' }, { rotate: 45 }),
    ];

    const settle = solver.solve({ bodies, mates });
    expect(settle.result).toBe('okay');

    // Closure-corner check helper. The closure mate (m4) coincides
    // top.handle2 with right.handle2; the headline bug was a 5–10 mm
    // gap here during drag.
    const closureGap = (out: { bodies: { instanceId: string; position: Vector3; quaternion: Quaternion }[] }): number => {
      const top = out.bodies.find(b => b.instanceId === 'top')!;
      const right = out.bodies.find(b => b.instanceId === 'right')!;
      const topH2 = c2().localOrigin.applyQuaternion(top.quaternion).add(top.position);
      const rightH2 = c2().localOrigin.applyQuaternion(right.quaternion).add(right.position);
      return topH2.distanceTo(rightH2);
    };
    expect(closureGap(settle)).toBeLessThan(0.1);

    // Drag `left` in 10 mm cursor steps along +x for 10 frames. The
    // direction is partly radial (cursor often unreachable past the
    // kinematic limit), which is the exact case that used to break
    // closure in pre-fix LM. Closure must hold at every frame
    // regardless of whether the cursor is reachable — the body just
    // stops at the boundary while the loop stays exactly closed.
    bodies = settle.bodies.map(b => ({
      instanceId: b.instanceId,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      grounded: b.instanceId === 'bottom',
      connectors: [c1(), c2()],
    }));
    const grabLocal = new Vector3(25, 0, 0); // mid-link on `left`

    for (let step = 0; step < 10; step++) {
      const leftIn = bodies.find(b => b.instanceId === 'left')!;
      const grabBefore = grabLocal.clone()
        .applyQuaternion(leftIn.quaternion).add(leftIn.position);
      const cursor = grabBefore.clone().add(new Vector3(10, 0, 0));

      const out = solver.solve({
        bodies,
        mates,
        draggedInstanceId: 'left',
        draggedCursorWorld: cursor,
        draggedGrabLocal: grabLocal.clone(),
      });
      expect(out.result).toBe('okay');
      // Closure stays within 0.1 mm even after 100mm of cumulative
      // cursor motion through partially-radial drag steps. The
      // original failure mode produced 1–10 mm gaps here.
      expect(closureGap(out)).toBeLessThan(0.1);

      bodies = out.bodies.map(b => ({
        instanceId: b.instanceId,
        position: b.position.clone(),
        quaternion: b.quaternion.clone(),
        grounded: b.instanceId === 'bottom',
        connectors: [c1(), c2()],
      }));
    }
  });

  it('planar 4-bar drag a coupler joint preserves closure', async () => {
    // Settle the parallelogram, then drag B's tip (which carries C
    // along) by a small cursor delta. After the drag-solve, all four
    // mates must still be satisfied.
    const setup = buildParallelogram();
    const solver = new Solver();
    await solver.ensureReady();
    const settle = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(settle.result).toBe('okay');

    // Dragged body: C (the coupler), grabbing its center.
    // C.center traces a 30mm-radius circle around world (50,0,0) as B
    // sweeps. We drag tangent to that circle (cursor in +x with no y
    // shift) so the target stays reachable; perpendicular drags would
    // hit the linkage's range-of-motion boundary, which stage 4 covers
    // explicitly with a closure-priority weighting.
    const cSettled = settle.bodies.find(b => b.instanceId === 'C')!;
    const grabLocalOnC = new Vector3(50, 0, 0); // halfway along the coupler
    const grabBefore = grabLocalOnC.clone()
      .applyQuaternion(cSettled.quaternion).add(cSettled.position);
    const cursor = grabBefore.clone().add(new Vector3(2, 0, 0));

    const draggedBodies: BodyState[] = settle.bodies.map(b => ({
      instanceId: b.instanceId,
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      grounded: b.instanceId === 'A',
      connectors: setup.bodies.find(orig => orig.instanceId === b.instanceId)!.connectors,
    }));

    const out = solver.solve({
      bodies: draggedBodies,
      mates: setup.mates,
      draggedInstanceId: 'C',
      draggedCursorWorld: cursor,
      draggedGrabLocal: grabLocalOnC,
    });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C'), D = get('D');

    // All four closures within LM tolerance after the drag.
    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1))).toBeLessThan(1e-3);
    expect(connectorWorld(C, setup.cH1).distanceTo(connectorWorld(B, setup.bH2))).toBeLessThan(1e-3);
    expect(connectorWorld(D, setup.dH1).distanceTo(connectorWorld(C, setup.cH2))).toBeLessThan(1e-3);
    expect(connectorWorld(A, setup.aH2).distanceTo(connectorWorld(D, setup.dH2))).toBeLessThan(1e-3);
  });
});
