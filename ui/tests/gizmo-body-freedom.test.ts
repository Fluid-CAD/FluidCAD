import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  bodyFreedom,
  buildMateGraph,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';

// The transform gizmo shows only the handles a part's mates to ground leave
// usable: bodyFreedom reads the spanning-tree path to a grounded root and
// reports whether the ORIGIN can move and which world axes it can spin
// about. Grounded / fastened-only chains have nothing (the gizmo stays
// hidden, as isInstanceFullyLocked already says); a revolute to the origin
// keeps its hinge ring and drops the translate handles.

// Connector at (ox, oy, oz) whose normal (the joint axis) is `normal`.
function connector(connectorId: string, origin: Vector3, normal = new Vector3(0, 0, 1)): ConnectorState {
  const x = Math.abs(normal.x) > 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return {
    connectorId,
    localOrigin: origin,
    localXDirection: x,
    localNormal: normal.clone().normalize(),
  };
}

function body(
  instanceId: string,
  grounded: boolean,
  position: Vector3,
  connectors: ConnectorState[] = [],
  quaternion = new Quaternion(),
): BodyState {
  return { instanceId, position, quaternion, grounded, connectors };
}

function mate(
  type: MateRecord['type'],
  a: { i: string; c: string },
  b: { i: string; c: string },
): MateRecord {
  return {
    mateId: `${type}:${a.i}:${a.c}->${b.i}:${b.c}`,
    type,
    connectorA: { instanceId: a.i, connectorId: a.c },
    connectorB: { instanceId: b.i, connectorId: b.c },
  };
}

const NONE = { translates: false, rotates: [false, false, false] };
const ALL = { translates: true, rotates: [true, true, true] };

describe('bodyFreedom — what a part can still do relative to ground', () => {
  it('a grounded body and a fastened chain to it have no freedom', () => {
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('c', new Vector3(10, 0, 0))]),
      body('F', false, new Vector3(10, 0, 0), [connector('c', new Vector3(0, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [mate('fastened', { i: 'G', c: 'c' }, { i: 'F', c: 'c' })]);
    expect(bodyFreedom('G', graph)).toEqual(NONE);
    expect(bodyFreedom('F', graph)).toEqual(NONE);
  });

  it('a revolute to ground about a world axis through the origin: one ring, no translate', () => {
    // Crank on a world-Y hinge whose axis passes through the crank origin.
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('y', new Vector3(0, 0, 0), new Vector3(0, 1, 0))]),
      body('crank', false, new Vector3(0, 285, 0), [connector('c1', new Vector3(0, -285, 0), new Vector3(0, 1, 0))]),
    ];
    const graph = buildMateGraph(bodies, [mate('revolute', { i: 'crank', c: 'c1' }, { i: 'G', c: 'y' })]);
    expect(bodyFreedom('crank', graph)).toEqual({ translates: false, rotates: [false, true, false] });
  });

  it('a revolute whose axis misses the origin lets the origin swing', () => {
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))]),
      body('arm', false, new Vector3(50, 0, 0), [connector('h', new Vector3(-50, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [mate('revolute', { i: 'G', c: 'h' }, { i: 'arm', c: 'h' })]);
    expect(bodyFreedom('arm', graph)).toEqual({ translates: true, rotates: [false, false, true] });
  });

  it('a body fastened below a hinge inherits the hinge, measured at ITS origin', () => {
    // G —revolute(Z through world origin)— arm —fastened— tip. The arm
    // origin sits on the axis (no swing); the tip origin is 40 mm off it.
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))]),
      body('arm', false, new Vector3(0, 0, 0), [
        connector('h', new Vector3(0, 0, 0)),
        connector('end', new Vector3(40, 0, 0)),
      ]),
      body('tip', false, new Vector3(40, 0, 0), [connector('end', new Vector3(0, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [
      mate('revolute', { i: 'G', c: 'h' }, { i: 'arm', c: 'h' }),
      mate('fastened', { i: 'arm', c: 'end' }, { i: 'tip', c: 'end' }),
    ]);
    expect(bodyFreedom('arm', graph)).toEqual({ translates: false, rotates: [false, false, true] });
    expect(bodyFreedom('tip', graph)).toEqual({ translates: true, rotates: [false, false, true] });
  });

  it('two hinges about different world axes compose to both rings', () => {
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('z', new Vector3(0, 0, 0))]),
      body('mid', false, new Vector3(0, 0, 0), [
        connector('z', new Vector3(0, 0, 0)),
        connector('x', new Vector3(0, 0, 0), new Vector3(1, 0, 0)),
      ]),
      body('end', false, new Vector3(0, 0, 0), [connector('x', new Vector3(0, 0, 0), new Vector3(1, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [
      mate('revolute', { i: 'G', c: 'z' }, { i: 'mid', c: 'z' }),
      mate('revolute', { i: 'mid', c: 'x' }, { i: 'end', c: 'x' }),
    ]);
    expect(bodyFreedom('end', graph)).toEqual({ translates: false, rotates: [true, false, true] });
  });

  it('a hinge off the world axes leaves every ring', () => {
    const diagonal = new Vector3(1, 1, 0);
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('d', new Vector3(0, 0, 0), diagonal)]),
      body('B', false, new Vector3(0, 0, 0), [connector('d', new Vector3(0, 0, 0), diagonal)]),
    ];
    const graph = buildMateGraph(bodies, [mate('revolute', { i: 'G', c: 'd' }, { i: 'B', c: 'd' })]);
    expect(bodyFreedom('B', graph)).toEqual({ translates: false, rotates: [true, true, true] });
  });

  it('a slider to ground translates and never rotates', () => {
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('s', new Vector3(0, 0, 0))]),
      body('B', false, new Vector3(0, 0, 0), [connector('s', new Vector3(0, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [mate('slider', { i: 'G', c: 's' }, { i: 'B', c: 's' })]);
    expect(bodyFreedom('B', graph)).toEqual({ translates: true, rotates: [false, false, false] });
  });

  it('a hinge axis reads from the LIVE parent pose, not the connector local frame', () => {
    // The ground body is rotated 90° about X, so its local-Z connector normal
    // points along world -Y: the ring is Y, not Z.
    const halfX = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))], halfX),
      body('B', false, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))], halfX),
    ];
    const graph = buildMateGraph(bodies, [mate('revolute', { i: 'G', c: 'h' }, { i: 'B', c: 'h' })]);
    expect(bodyFreedom('B', graph)).toEqual({ translates: false, rotates: [false, true, false] });
  });

  it('unconstrained bodies are unrestricted: no mates, an ungrounded chain, an unknown id', () => {
    const bodies = [
      body('A', false, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))]),
      body('B', false, new Vector3(0, 0, 0), [connector('h', new Vector3(0, 0, 0))]),
      body('loose', false, new Vector3(5, 5, 5)),
    ];
    const graph = buildMateGraph(bodies, [mate('revolute', { i: 'A', c: 'h' }, { i: 'B', c: 'h' })]);
    expect(bodyFreedom('A', graph)).toEqual(ALL);
    expect(bodyFreedom('B', graph)).toEqual(ALL);
    expect(bodyFreedom('loose', graph)).toEqual(ALL);
    expect(bodyFreedom('nope', graph)).toEqual(ALL);
  });

  it('a joint the walk does not model (parallel) leaves the body unrestricted', () => {
    const bodies = [
      body('G', true, new Vector3(0, 0, 0), [connector('p', new Vector3(0, 0, 0))]),
      body('B', false, new Vector3(0, 0, 0), [connector('p', new Vector3(0, 0, 0))]),
    ];
    const graph = buildMateGraph(bodies, [mate('parallel', { i: 'G', c: 'p' }, { i: 'B', c: 'p' })]);
    expect(bodyFreedom('B', graph)).toEqual(ALL);
  });
});
