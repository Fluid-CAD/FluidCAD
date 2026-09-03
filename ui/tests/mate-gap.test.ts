import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  Solver,
  dominantAxis,
  type BodyState,
  type ConnectorState,
  type MateRecord,
} from '../src/solver';
import { describeMateFailure } from '../src/ui/mate-failure-text';

// The failed-mates report carries a measured misclosure per mate
// (`SolverOutput.failures`): the connector-origin gap along the mate's
// constrained directions, named by world axis when axis-aligned, plus the
// orientation error in degrees. The engine slider-crank that motivated it:
// the slider's assembly connector sat 6 mm off the rod plane along world Y,
// and the solver blamed the pin↔rod fastened closure edge — the gap text is
// what points back at the misplaced connector.

const V = (x: number, y: number, z: number) => new Vector3(x, y, z);
const C = (id: string, o: number[], x: number[], n: number[]): ConnectorState => ({
  connectorId: id,
  localOrigin: V(o[0], o[1], o[2]),
  localXDirection: V(x[0], x[1], x[2]),
  localNormal: V(n[0], n[1], n[2]),
});
const B = (instanceId: string, grounded: boolean, pos: number[], connectors: ConnectorState[], quaternion = new Quaternion()): BodyState => ({
  instanceId, grounded, position: V(pos[0], pos[1], pos[2]), quaternion, connectors,
});
const M = (mateId: string, type: MateRecord['type'], a: [string, string], b: [string, string], options?: MateRecord['options']): MateRecord => ({
  mateId, type,
  connectorA: { instanceId: a[0], connectorId: a[1] },
  connectorB: { instanceId: b[0], connectorId: b[1] },
  options,
});

function engine(sliderY: number) {
  const bodies: BodyState[] = [
    B('__world__', true, [0, 0, 0], [
      C('origin', [0, 0, 0], [1, 0, 0], [0, 1, 0]),
      C('slide', [0, sliderY, 157.2], [1, 0, 0], [0, 0, 1]),
    ]),
    B('crank', false, [0, 285, 0], [
      C('c1', [0, -133, 0], [1, 0, 0], [0, -1, 0]),
      C('c2', [0, 23, -44], [1, 0, 0], [0, -1, 0]),
    ]),
    B('rod', false, [0, 0, 0], [
      C('c1', [-38, 0, 0], [-1, 0, 0], [0, 0, -1]),
      C('c2', [0, 0, 201.2], [1, 0, 0], [0, -1, 0]),
    ]),
    B('cap', false, [0, 0, -63], [
      C('c2', [0, -3, 0], [-1, 0, 0], [0, 1, 0]),
      C('c1', [-38, 0, 0], [1, 0, 0], [0, 0, 1]),
    ]),
    B('piston', false, [0, 0, 335], [
      C('c1', [0, 0, 27], [1, 0, 0], [0, -1, 0]),
      C('c2', [0, 0, 27], [1, 0, 0], [0, 0, -1]),
    ]),
    B('pin', false, [0, 146, 0], [
      C('c1', [0, 0, 41], [0, 1, 0], [0, 0, -1]),
    ]),
  ];
  const mates: MateRecord[] = [
    M('pin-rod', 'fastened', ['pin', 'c1'], ['rod', 'c2']),
    M('cap-rod', 'fastened', ['cap', 'c1'], ['rod', 'c1'], { rotate: 180 }),
    M('pin-piston', 'revolute', ['pin', 'c1'], ['piston', 'c1']),
    M('crank-world', 'revolute', ['crank', 'c1'], ['__world__', 'origin']),
    M('slider', 'slider', ['__world__', 'slide'], ['piston', 'c2']),
    M('cap-crank', 'revolute', ['cap', 'c2'], ['crank', 'c2']),
  ];
  return new Solver().solve({ bodies, mates });
}

describe('solver diagnostics — measured misclosure per failing mate', () => {
  it('engine slider-crank with the slider 6 mm off the rod plane: one failure, 6 mm gap along Y, no tilt', () => {
    const out = engine(153);
    expect(out.result).toBe('inconsistent');
    expect(out.failures.map(f => f.mateId)).toEqual(out.failed);
    expect(out.failures).toHaveLength(1);
    const [f] = out.failures;
    expect(f.gap).toBeCloseTo(6, 3);
    expect(f.gapAxis).toBe('y');
    expect(f.tiltDeg).toBeLessThan(0.01);
  });

  it('the same mechanism with the slider on the rod plane closes with 1 DOF and no failures', () => {
    const out = engine(159);
    expect(out.result).toBe('okay');
    expect(out.dof).toBe(1);
    expect(out.failures).toEqual([]);
  });

  it('an oblique gap between two grounded bodies reports its length and no axis', () => {
    // Both grounded → nothing moves; the fastened mate is evaluated as-is.
    const out = new Solver().solve({
      bodies: [
        B('a', true, [0, 0, 0], [C('p', [0, 0, 0], [1, 0, 0], [0, 0, 1])]),
        // Face-to-face at the same origin needs b's Z to point -Z; put b's
        // connector normal at -Z so the identity pose satisfies orientation.
        B('b', true, [3, 4, 0], [C('p', [0, 0, 0], [1, 0, 0], [0, 0, -1])]),
      ],
      mates: [M('ab', 'fastened', ['a', 'p'], ['b', 'p'])],
    });
    expect(out.result).toBe('inconsistent');
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].gap).toBeCloseTo(5, 6);
    expect(out.failures[0].gapAxis).toBeNull();
    expect(out.failures[0].tiltDeg).toBeCloseTo(0, 6);
  });

  it('a tilted hinge between two grounded bodies reports the axis angle, not a gap', () => {
    const tilt = new Quaternion().setFromAxisAngle(V(1, 0, 0), 10 * Math.PI / 180);
    const out = new Solver().solve({
      bodies: [
        B('a', true, [0, 0, 0], [C('h', [0, 0, 0], [1, 0, 0], [0, 0, 1])]),
        B('b', true, [0, 0, 0], [C('h', [0, 0, 0], [1, 0, 0], [0, 0, -1])], tilt),
      ],
      mates: [M('ab', 'revolute', ['a', 'h'], ['b', 'h'])],
    });
    expect(out.result).toBe('inconsistent');
    expect(out.failures[0].gap).toBeLessThan(1e-9);
    expect(out.failures[0].tiltDeg).toBeCloseTo(10, 6);
  });

  it('a slider never counts its free slide as a gap', () => {
    const out = new Solver().solve({
      bodies: [
        B('a', true, [0, 0, 0], [C('s', [0, 0, 0], [1, 0, 0], [0, 0, 1])]),
        // 40 along Z is the slide (free); 2 along Y is the gap.
        B('b', true, [0, 2, 40], [C('s', [0, 0, 0], [1, 0, 0], [0, 0, -1])]),
      ],
      mates: [M('ab', 'slider', ['a', 's'], ['b', 's'])],
    });
    expect(out.result).toBe('inconsistent');
    expect(out.failures[0].gap).toBeCloseTo(2, 6);
    expect(out.failures[0].gapAxis).toBe('y');
  });
});

describe('dominantAxis', () => {
  it('names an axis-aligned gap and stays null for oblique or zero ones', () => {
    expect(dominantAxis(V(0, -6, 0))).toBe('y');
    expect(dominantAxis(V(6, 0.05, 0))).toBe('x');
    expect(dominantAxis(V(0, 0, 0.3))).toBe('z');
    expect(dominantAxis(V(3, 4, 0))).toBeNull();
    expect(dominantAxis(V(0, 0, 0))).toBeNull();
  });
});

describe('describeMateFailure', () => {
  it('formats gap, axis and tilt in the document unit', () => {
    expect(describeMateFailure({ mateId: 'm', gap: 6, gapAxis: 'y', tiltDeg: 0 }, 'mm')).toBe('6.0 mm gap along Y');
    expect(describeMateFailure({ mateId: 'm', gap: 5, gapAxis: null, tiltDeg: 0 }, 'mm')).toBe('5.0 mm gap');
    expect(describeMateFailure({ mateId: 'm', gap: 0, gapAxis: null, tiltDeg: 10 }, 'mm')).toBe('10.0° tilt');
    expect(describeMateFailure({ mateId: 'm', gap: 0.25, gapAxis: 'x', tiltDeg: 1.25 }, 'in')).toBe('0.3 in gap along X · 1.3° tilt');
    expect(describeMateFailure({ mateId: 'm', gap: 0.001, gapAxis: null, tiltDeg: 0.01 }, 'mm')).toBe('');
  });
});
