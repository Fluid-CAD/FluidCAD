import { describe, it, expect } from 'vitest';
import {
  chainAngleConstraint,
  dimMagnitude,
  lineText,
  arcText,
  circleText,
  pointText,
  solvedPointText,
  rectEmission,
  refTarget,
  roundedRectEmission,
  slotEmission,
  polygonEmission,
} from '../src/interactive/tools/solved-emission';

// The shared solved-sketch emission formatters (sketch-rewrite P5): tools
// stop hand-rolling template strings; every shape gesture lowers to
// primitives + explicit constraints here.

describe('statement text formatters', () => {
  it('renders 2dp literals, typed expressions verbatim, and pre-formatted strings', () => {
    expect(solvedPointText([1.234, -0.006])).toBe('[1.23, -0.01]');
    expect(solvedPointText({
      value: [5, 10], xExpr: 'w / 2', yExpr: '10', newVariables: [], typed: true,
    })).toBe('[w / 2, 10]');
    expect(lineText([0, 0], [40.129, 0])).toBe('line([0, 0], [40.13, 0])');
    expect(arcText([0, 0], [10, 10], [10, 0], true)).toBe('arc([0, 0], [10, 10], [10, 0]).cw()');
    expect(circleText([1, 2], 30)).toBe('circle([1, 2], 30)');
    expect(circleText([1, 2], 'd')).toBe('circle([1, 2], d)');
    expect(pointText([3, 4])).toBe('point([3, 4])');
  });

  it('dimMagnitude strips the sign from numeric text only', () => {
    expect(dimMagnitude('-30')).toBe('30');
    expect(dimMagnitude('30')).toBe('30');
    expect(dimMagnitude('w')).toBe('w');
    expect(dimMagnitude('-(w)')).toBe('-(w)');
  });
});

describe('refTarget', () => {
  it('addresses a statement by line, role optional', () => {
    expect(refTarget({ line: 7, role: 'end', featureType: 'line' }))
      .toEqual({ line: 7, role: 'end', featureType: 'line' });
    expect(refTarget({ line: 9, featureType: 'point' }))
      .toEqual({ line: 9, featureType: 'point' });
  });

  it('carries a loop-instance ref\'s occurrence through to the target', () => {
    expect(refTarget({ line: 7, occurrence: 2, role: 'start', featureType: 'line' }))
      .toEqual({ line: 7, occurrence: 2, role: 'start', featureType: 'line' });
    // Occurrence 0 is a real instance index, not a falsy nothing.
    expect(refTarget({ line: 7, occurrence: 0, featureType: 'circle' }))
      .toEqual({ line: 7, occurrence: 0, featureType: 'circle' });
  });

  it('renders datum refs by name only', () => {
    expect(refTarget({ datum: 'origin' })).toEqual({ datum: 'origin' });
  });
});

describe('chainAngleConstraint (P4 CCW ≤ 180° rule)', () => {
  it('emits the natural order for a CCW turn under 180°', () => {
    const c = chainAngleConstraint({ line: 5 }, { newIndex: 0 }, [1, 0], [0, 1]);
    expect(c).toEqual({
      kind: 'angle',
      targets: [{ line: 5 }, { newIndex: 0 }],
      valueExpr: '90',
    });
  });

  it('swaps the pair when the CCW turn exceeds 180°', () => {
    const c = chainAngleConstraint({ line: 5 }, { newIndex: 0 }, [1, 0], [0, -1]);
    expect(c).toEqual({
      kind: 'angle',
      targets: [{ newIndex: 0 }, { line: 5 }],
      valueExpr: '90',
    });
  });

  it('returns null for a degenerate direction pair', () => {
    expect(chainAngleConstraint({ line: 5 }, { newIndex: 0 }, [0, 0], [0, 0])).toBeNull();
  });
});

describe('rectEmission', () => {
  it('emits 4 lines + 4 coincident + 2 horizontal + 2 vertical', () => {
    const e = rectEmission({ corner: [0, 0], w: 40, h: 30 });
    expect(e.geometry.map(g => g.text)).toEqual([
      'line([0, 0], [40, 0])',
      'line([40, 0], [40, 30])',
      'line([40, 30], [0, 30])',
      'line([0, 30], [0, 0])',
    ]);
    expect(e.constraints).toHaveLength(8);
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(4);
    expect(e.constraints.filter(c => c.kind === 'horizontal')).toHaveLength(2);
    expect(e.constraints.filter(c => c.kind === 'vertical')).toHaveLength(2);
  });

  it('adds distance dims for typed sizes and handles negative extents', () => {
    const e = rectEmission({ corner: [10, 10], w: -20, h: 5, widthDim: 'w', heightDim: '5' });
    expect(e.geometry[0].text).toBe('line([10, 10], [-10, 10])');
    const dims = e.constraints.filter(c => c.kind === 'distance');
    expect(dims).toHaveLength(2);
    expect(dims[0].valueExpr).toBe('w');
    expect(dims[0].targets).toEqual([{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }]);
    expect(dims[1].valueExpr).toBe('5');
  });
});

describe('roundedRectEmission', () => {
  it('emits the 8-piece CCW loop with tangents, h/v and equal radii', () => {
    const e = roundedRectEmission({ corner: [0, 0], w: 40, h: 30, radius: 5 });
    expect(e.geometry).toHaveLength(8);
    expect(e.geometry.filter(g => g.kind === 'line')).toHaveLength(4);
    expect(e.geometry.filter(g => g.kind === 'arc')).toHaveLength(4);
    // Bottom edge inset by the radius; the BR corner arc closes onto the
    // right edge.
    expect(e.geometry[0].text).toBe('line([5, 0], [35, 0])');
    expect(e.geometry[1].text).toBe('arc([35, 0], [40, 5], [35, 5])');
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(8);
    expect(e.constraints.filter(c => c.kind === 'tangent')).toHaveLength(8);
    expect(e.constraints.filter(c => c.kind === 'horizontal')).toHaveLength(2);
    expect(e.constraints.filter(c => c.kind === 'vertical')).toHaveLength(2);
    expect(e.constraints.filter(c => c.kind === 'equal')).toHaveLength(3);
  });

  it('dims typed sizes as line–line distances + a radius', () => {
    const e = roundedRectEmission({
      corner: [0, 0], w: 40, h: 30, radius: 5,
      widthDim: '40', heightDim: '30', radiusDim: '5',
    });
    const dims = e.constraints.filter(c => c.kind === 'distance');
    expect(dims).toHaveLength(2);
    expect(dims[0].targets).toEqual([{ newIndex: 6 }, { newIndex: 2 }]);
    expect(e.constraints.filter(c => c.kind === 'radius')).toHaveLength(1);
  });
});

describe('slotEmission', () => {
  it('emits a CCW stadium loop with tangent caps and equal radii', () => {
    const e = slotEmission({ p0: [0, 0], p1: [50, 0], radius: 10 });
    expect(e.geometry.map(g => g.text)).toEqual([
      'line([0, -10], [50, -10])',
      'arc([50, -10], [50, 10], [50, 0])',
      'line([50, 10], [0, 10])',
      'arc([0, 10], [0, -10], [0, 0])',
    ]);
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(4);
    expect(e.constraints.filter(c => c.kind === 'tangent')).toHaveLength(4);
    expect(e.constraints.filter(c => c.kind === 'equal')).toHaveLength(1);
  });

  it('dims typed sizes as a center–center distance + a radius', () => {
    const e = slotEmission({ p0: [0, 0], p1: [50, 0], radius: 10, lengthDim: '50', radiusDim: 'r' });
    const dist = e.constraints.find(c => c.kind === 'distance');
    expect(dist?.targets).toEqual([{ newIndex: 3, role: 'center' }, { newIndex: 1, role: 'center' }]);
    expect(e.constraints.find(c => c.kind === 'radius')?.valueExpr).toBe('r');
  });
});

describe('polygonEmission', () => {
  it('emits n lines with chain coincidents, n−1 equal, n−3 turn angles', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 4 });
    expect(e.geometry).toHaveLength(4);
    // Across-flats ⌀20 square: vertices on the circumscribed radius
    // 10/cos(45°) ≈ 14.14, first vertex at +X (the preview's convention).
    expect(e.geometry[0].text).toBe('line([14.14, 0], [0, 14.14])');
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(4);
    expect(e.constraints.filter(c => c.kind === 'equal')).toHaveLength(3);
    const angles = e.constraints.filter(c => c.kind === 'angle');
    expect(angles).toHaveLength(1);
    expect(angles[0]).toEqual({ kind: 'angle', targets: [{ newIndex: 0 }, { newIndex: 1 }], valueExpr: '90' });
  });

  it('dims a typed ⌀ as the opposite-side distance for even n', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 6, diameterDim: '20' });
    const dim = e.constraints.find(c => c.kind === 'distance');
    expect(dim?.targets).toEqual([{ newIndex: 0 }, { newIndex: 3 }]);
    expect(dim?.valueExpr).toBe('20');
  });

  it('converts a typed ⌀ to a numeric side length for odd n', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 5, diameterDim: '20' });
    const dim = e.constraints.find(c => c.kind === 'distance');
    expect(dim?.targets).toEqual([{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }]);
    // side = ⌀ · tan(π/5)
    expect(dim?.valueExpr).toBe('14.53');
  });
});
