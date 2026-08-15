import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  buildMateGraph,
  isInstanceFullyLocked,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// Stage A of the joint-model plan: a grounded body must NEVER be
// relocated by the solver. Before the multi-source BFS fix, a component
// with two grounded bodies picked only the first as the spanning-tree
// seed; the second grounded body became a tree-edge follower and the
// warm-start relocated it (F1 in the solver review).

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

// Quaternion for rotation about world Z by `degrees`.
function quatZ(degrees: number): Quaternion {
  const half = (degrees * Math.PI) / 360;
  return new Quaternion(0, 0, Math.sin(half), Math.cos(half));
}

// World position of a body's connector origin.
function connectorWorld(
  b: { position: Vector3; quaternion: Quaternion },
  conn: ConnectorState,
): Vector3 {
  return conn.localOrigin.clone().applyQuaternion(b.quaternion).add(b.position);
}

describe('mate-grounding — grounded bodies are never relocated', () => {
  // The verified F1 repro:
  //   A (grounded at origin) — revolute — B — revolute — C (grounded at (80,0,0)).
  //   Connectors: A.h1@(0,0,0); B.h1@(0,0,0), B.h2@(50,0,0); C.h1@(0,0,0).
  // Before the fix, the BFS made C a tree child of B and the warm-start
  // relocated C to (50,0,0) — a 30 mm error on a GROUNDED body.
  // With link length 50 and |AC| = 80 the m2 closure is geometrically
  // unsatisfiable (triangle inequality leaves a ≥30 mm gap); the solver
  // must leave both grounded bodies exactly in place and keep the tree
  // mate m1 exact, letting the gap live on the closure edge m2.
  function buildTwoGroundChain(linkLength: number): {
    bodies: BodyState[];
    mates: MateRecord[];
    aH1: ConnectorState;
    bH1: ConnectorState; bH2: ConnectorState;
    cH1: ConnectorState;
  } {
    const aH1 = flatConnector('h1');
    const bH1 = flatConnector('h1');
    const bH2 = flatConnector('h2', linkLength, 0);
    const cH1 = flatConnector('h1');
    const bodies = [
      body('A', true,  new Vector3(0, 0, 0),  new Quaternion(), [aH1]),
      body('B', false, new Vector3(20, 10, 0), new Quaternion(), [bH1, bH2]),
      body('C', true,  new Vector3(80, 0, 0), new Quaternion(), [cH1]),
    ];
    const mates: MateRecord[] = [
      revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
    ];
    return { bodies, mates, aH1, bH1, bH2, cH1 };
  }

  it('second grounded body stays put even when the closure is unsatisfiable (F1 repro)', () => {
    const setup = buildTwoGroundChain(50);
    const solver = new Solver();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C');

    // Grounded bodies untouched. Before the fix C landed at (50,0,0).
    expect(A.position.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-9);
    expect(C.position.distanceTo(new Vector3(80, 0, 0))).toBeLessThan(1e-9);
    expect(Math.abs(1 - Math.abs(C.quaternion.dot(new Quaternion())))).toBeLessThan(1e-9);

    // Tree mate m1 stays exact (warm-start + fixup).
    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1)))
      .toBeLessThan(1e-3);

    // Closure m2 keeps its irreducible 30 mm gap — nothing "fixed" it by
    // moving a grounded body.
    const gap = connectorWorld(B, setup.bH2).distanceTo(connectorWorld(C, setup.cH1));
    expect(gap).toBeGreaterThan(30 - 1e-3);
    expect(gap).toBeLessThan(30.5);

    // Stage C diagnostics: the unreachable closure is reported, the
    // exact tree mate is not.
    expect(out.result).toBe('inconsistent');
    expect(out.failed).toEqual(['m2']);
  });

  it('second grounded body stays put and a reachable closure closes', () => {
    // Same topology with link length 80: B can span A→C, so BOTH mates
    // are satisfiable. B starts at a garbage pose; the warm-start seeds
    // it from A and the closure lands on C without moving any ground.
    const setup = buildTwoGroundChain(80);
    setup.bodies[1].position.set(10, 20, 0);
    setup.bodies[1].quaternion.copy(quatZ(30));
    const solver = new Solver();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C');

    expect(A.position.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-9);
    expect(C.position.distanceTo(new Vector3(80, 0, 0))).toBeLessThan(1e-9);

    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1)))
      .toBeLessThan(1e-3);
    expect(connectorWorld(B, setup.bH2).distanceTo(connectorWorld(C, setup.cH1)))
      .toBeLessThan(1e-3);
    expect(out.result).toBe('okay');
    expect(out.failed).toEqual([]);
  });

  it('F1 topology: graph makes both grounded bodies roots and m2 a closure', () => {
    const setup = buildTwoGroundChain(50);
    const graph = buildMateGraph(setup.bodies, setup.mates);
    expect(graph.components).toHaveLength(1);
    const component = graph.components[0];
    expect(component.roots.map(r => r.instanceId).sort()).toEqual(['A', 'C']);
    expect(component.treeEdges).toHaveLength(1);
    expect(component.treeEdges[0].mate.mateId).toBe('m1');
    expect(component.closureEdges.map(m => m.mateId)).toEqual(['m2']);
    // Closure endpoints live in two different trees of the forest (B under
    // A, C its own root) — no LCA, both full paths are marked as loop.
    expect([...component.loopBodies].sort()).toEqual(['A', 'B', 'C']);
  });

  it('a grounded body is fully locked even when mated through non-fastened mates', () => {
    // Before the fix, C sat below a revolute tree edge, so
    // isInstanceFullyLocked('C') returned false — a grounded body that
    // drags/picks treated as movable. As a root it is trivially locked.
    const setup = buildTwoGroundChain(50);
    const graph = buildMateGraph(setup.bodies, setup.mates);
    expect(isInstanceFullyLocked('A', graph)).toBe(true);
    expect(isInstanceFullyLocked('C', graph)).toBe(true);
    expect(isInstanceFullyLocked('B', graph)).toBe(false);
  });

  // Parallelogram 4-bar (same geometry as mate-loops.test.ts) but with
  // BOTH ground pivots grounded — the scissor-lift-style topology that
  // motivated the multi-source BFS:
  //   A (ground): h1@(0,0,0), h2@(100,0,0)
  //   B (crank):  h1@(0,0,0), h2@(30,0,0)
  //   C (coupler): h1@(0,0,0), h2@(100,0,0)
  //   D (rocker, ALSO grounded): h1@(0,0,0), h2@(30,0,0)
  // Canonical config: B and D straight up by ±90°, C at y=30.
  function buildTwoGroundParallelogram(): {
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
      body('A', true,  new Vector3(0, 0, 0),    new Quaternion(), [aH1, aH2]),
      body('B', false, new Vector3(0, 0, 0),    quatZ(90),        [bH1, bH2]),
      body('C', false, new Vector3(0, 30, 0),   new Quaternion(), [cH1, cH2]),
      body('D', true,  new Vector3(100, 30, 0), quatZ(-90),       [dH1, dH2]),
    ];
    const mates: MateRecord[] = [
      revolute('m1', { i: 'A', c: 'h1' }, { i: 'B', c: 'h1' }),
      revolute('m2', { i: 'B', c: 'h2' }, { i: 'C', c: 'h1' }),
      revolute('m3', { i: 'C', c: 'h2' }, { i: 'D', c: 'h1' }),
      revolute('m4', { i: 'D', c: 'h2' }, { i: 'A', c: 'h2' }),
    ];
    return { bodies, mates, aH1, aH2, bH1, bH2, cH1, cH2, dH1, dH2 };
  }

  it('two-ground 4-bar: spanning forest has one tree per ground', () => {
    const setup = buildTwoGroundParallelogram();
    const graph = buildMateGraph(setup.bodies, setup.mates);
    expect(graph.components).toHaveLength(1);
    const component = graph.components[0];
    expect(component.roots.map(r => r.instanceId).sort()).toEqual(['A', 'D']);
    // m1 (A→B) and m3 (D→C) are the tree edges; m2 bridges the two trees
    // and m4 connects the two roots — both closures.
    expect(component.treeEdges.map(e => e.mate.mateId).sort()).toEqual(['m1', 'm3']);
    expect(component.closureEdges.map(m => m.mateId).sort()).toEqual(['m2', 'm4']);
    expect([...component.loopBodies].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('two-ground 4-bar at canonical config keeps closure and both grounds', () => {
    const setup = buildTwoGroundParallelogram();
    const solver = new Solver();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C'), D = get('D');

    expect(A.position.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-9);
    expect(D.position.distanceTo(new Vector3(100, 30, 0))).toBeLessThan(1e-9);
    expect(Math.abs(1 - Math.abs(D.quaternion.dot(quatZ(-90))))).toBeLessThan(1e-9);

    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1))).toBeLessThan(1e-4);
    expect(connectorWorld(C, setup.cH1).distanceTo(connectorWorld(B, setup.bH2))).toBeLessThan(1e-4);
    expect(connectorWorld(D, setup.dH1).distanceTo(connectorWorld(C, setup.cH2))).toBeLessThan(1e-4);
    expect(connectorWorld(A, setup.aH2).distanceTo(connectorWorld(D, setup.dH2))).toBeLessThan(1e-4);
  });

  it('two-ground 4-bar from a perturbed seed re-closes without touching grounds', () => {
    const setup = buildTwoGroundParallelogram();
    // Knock B and C off the parallelogram so the warm-start reseeds C
    // from D's tree and LM has to swing the two trees back together.
    setup.bodies[1].quaternion.copy(quatZ(80));
    setup.bodies[2].position.set(4, 26, 0);

    const solver = new Solver();
    const out = solver.solve({ bodies: setup.bodies, mates: setup.mates });
    expect(out.result).toBe('okay');

    const get = (id: string) => out.bodies.find(b => b.instanceId === id)!;
    const A = get('A'), B = get('B'), C = get('C'), D = get('D');

    expect(A.position.distanceTo(new Vector3(0, 0, 0))).toBeLessThan(1e-9);
    expect(D.position.distanceTo(new Vector3(100, 30, 0))).toBeLessThan(1e-9);

    expect(connectorWorld(B, setup.bH1).distanceTo(connectorWorld(A, setup.aH1))).toBeLessThan(1e-3);
    expect(connectorWorld(C, setup.cH1).distanceTo(connectorWorld(B, setup.bH2))).toBeLessThan(1e-3);
    expect(connectorWorld(D, setup.dH1).distanceTo(connectorWorld(C, setup.cH2))).toBeLessThan(1e-3);
    expect(connectorWorld(A, setup.aH2).distanceTo(connectorWorld(D, setup.dH2))).toBeLessThan(1e-3);
  });
});
