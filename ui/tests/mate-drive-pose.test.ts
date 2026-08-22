import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  buildMateGraph,
  mateReadoutValue,
  type BodyState,
  type ConnectorState,
  type MateRecord,
  type SolverInput,
} from '../src/solver';

// SolverInput.drivenJoint — the Animate bar's kinematic driver. Solving
// with a mate driven to `value` must read back `value` from either
// traversal side (with flip), hold it through a loop relaxation instead
// of letting LM move it, and still respect `.limits()`.

function flatConnector(connectorId: string, ox = 0, oy = 0, oz = 0): ConnectorState {
  return {
    connectorId,
    localOrigin: new Vector3(ox, oy, oz),
    localXDirection: new Vector3(1, 0, 0),
    localNormal: new Vector3(0, 0, 1),
  };
}

function body(instanceId: string, grounded: boolean, connectors: ConnectorState[], position = new Vector3()): BodyState {
  return { instanceId, position, quaternion: new Quaternion(), grounded, connectors };
}

function mateRecord(
  mateId: string,
  type: MateRecord['type'],
  a: { i: string; c: string },
  b: { i: string; c: string },
  options?: MateRecord['options'],
): MateRecord {
  return {
    mateId,
    type,
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
    options,
  };
}

/** Authored-space value of `mateId` at the solved poses. */
function readBack(input: SolverInput, out: ReturnType<Solver['solve']>, mateId: string): number {
  const solved = new Map(out.bodies.map(b => [b.instanceId, b]));
  const at = (id: string): BodyState => {
    const b = input.bodies.find(x => x.instanceId === id)!;
    const s = solved.get(id)!;
    return { ...b, position: s.position, quaternion: s.quaternion };
  };
  const graph = buildMateGraph(input.bodies.map(b => at(b.instanceId)), input.mates);
  for (const comp of graph.components) {
    for (const edge of comp.treeEdges) {
      if (edge.mate.mateId !== mateId) continue;
      return mateReadoutValue(edge.mate, edge.parent, edge.parentConn, edge.child, edge.childConn)!.value;
    }
  }
  throw new Error(`${mateId} is not a tree edge`);
}

describe('drivenJoint', () => {
  it('revolute: driven angle reads back from the authored (A-driver) side', () => {
    const aConn = flatConnector('a', 5, 0);
    const bConn = flatConnector('b');
    const mates = [mateRecord('m1', 'revolute', { i: 'A', c: 'a' }, { i: 'B', c: 'b' })];
    for (const v of [0, 30, -75, 120]) {
      const input: SolverInput = {
        bodies: [body('A', true, [aConn]), body('B', false, [bConn])],
        mates,
        drivenJoint: { mateId: 'm1', value: v },
      };
      const out = new Solver().solve(input);
      expect(out.result).toBe('okay');
      expect(readBack(input, out, 'm1')).toBeCloseTo(v, 6);
    }
  });

  it('revolute: reversed traversal with flip still reads back the authored value', () => {
    const aConn = flatConnector('a');
    const bConn = flatConnector('b');
    const mates = [mateRecord('m1', 'revolute', { i: 'A', c: 'a' }, { i: 'B', c: 'b' }, { flip: true })];
    for (const v of [0, 45, -60]) {
      // B grounded → the tree drives the mate from its B side.
      const input: SolverInput = {
        bodies: [body('A', false, [aConn]), body('B', true, [bConn])],
        mates,
        drivenJoint: { mateId: 'm1', value: v },
      };
      const out = new Solver().solve(input);
      expect(out.result).toBe('okay');
      expect(readBack(input, out, 'm1')).toBeCloseTo(v, 6);
    }
  });

  it('slider: driven travel moves the follower along the axis only', () => {
    const aConn = flatConnector('a');
    const bConn = flatConnector('b');
    const input: SolverInput = {
      bodies: [body('A', true, [aConn]), body('B', false, [bConn])],
      mates: [mateRecord('m1', 'slider', { i: 'A', c: 'a' }, { i: 'B', c: 'b' })],
      drivenJoint: { mateId: 'm1', value: 12.5 },
    };
    const out = new Solver().solve(input);
    const B = out.bodies.find(b => b.instanceId === 'B')!;
    expect(B.position.x).toBeCloseTo(0, 9);
    expect(B.position.y).toBeCloseTo(0, 9);
    expect(B.position.z).toBeCloseTo(12.5, 9);
  });

  it('clamps the driven value to .limits()', () => {
    const aConn = flatConnector('a');
    const bConn = flatConnector('b');
    const input: SolverInput = {
      bodies: [body('A', true, [aConn]), body('B', false, [bConn])],
      mates: [mateRecord('m1', 'revolute', { i: 'A', c: 'a' }, { i: 'B', c: 'b' }, { limits: [-30, 30] })],
      drivenJoint: { mateId: 'm1', value: 80 },
    };
    const out = new Solver().solve(input);
    expect(readBack(input, out, 'm1')).toBeCloseTo(30, 6);
  });

  it('holds the driven crank angle through a closed loop (slider-crank)', () => {
    // Ground G: crank pivot at origin, slider axis along world X.
    // Crank C (length 20) — revolute to ground; coupler L (length 50) —
    // revolute to crank tip; piston P — slider on ground, revolute to
    // the coupler's far end (the closure). Driving the crank must leave
    // LM to place the coupler + piston, not re-negotiate the crank.
    const gPivot = flatConnector('pivot');
    const gSlide = { ...flatConnector('slide'), localNormal: new Vector3(1, 0, 0), localXDirection: new Vector3(0, 1, 0) };
    const cRoot = flatConnector('root');
    const cTip = flatConnector('tip', 20, 0);
    const lNear = flatConnector('near');
    const lFar = flatConnector('far', 50, 0);
    const pSlide = { ...flatConnector('slide'), localNormal: new Vector3(1, 0, 0), localXDirection: new Vector3(0, 1, 0) };
    const pPin = flatConnector('pin');
    const mates = [
      mateRecord('crank', 'revolute', { i: 'G', c: 'pivot' }, { i: 'C', c: 'root' }),
      mateRecord('elbow', 'revolute', { i: 'C', c: 'tip' }, { i: 'L', c: 'near' }),
      mateRecord('piston', 'slider', { i: 'G', c: 'slide' }, { i: 'P', c: 'slide' }),
      mateRecord('wrist', 'revolute', { i: 'L', c: 'far' }, { i: 'P', c: 'pin' }),
    ];
    let bodies = [
      body('G', true, [gPivot, gSlide]),
      body('C', false, [cRoot, cTip]),
      body('L', false, [lNear, lFar], new Vector3(20, 0, 0)),
      body('P', false, [pSlide, pPin], new Vector3(70, 0, 0)),
    ];
    const solver = new Solver();
    for (const angle of [0, 20, 45, 90, 135]) {
      const input: SolverInput = { bodies, mates, drivenJoint: { mateId: 'crank', value: angle } };
      const out = solver.solve(input);
      expect(out.result, `angle ${angle}`).toBe('okay');
      expect(readBack(input, out, 'crank')).toBeCloseTo(angle, 3);
      // Piston stays on its axis at the slider-crank position.
      const P = out.bodies.find(b => b.instanceId === 'P')!;
      const rad = (angle * Math.PI) / 180;
      const x = 20 * Math.cos(rad) + Math.sqrt(50 * 50 - (20 * Math.sin(rad)) ** 2);
      expect(P.position.x).toBeCloseTo(x, 2);
      expect(Math.abs(P.position.y)).toBeLessThan(1e-3);
      // Feed the solved poses forward, as the controller does per tick.
      bodies = bodies.map(b => {
        const s = out.bodies.find(o => o.instanceId === b.instanceId)!;
        return { ...b, position: s.position.clone(), quaternion: s.quaternion.clone() };
      });
    }
  });
});
