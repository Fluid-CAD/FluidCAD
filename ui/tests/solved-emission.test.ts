import { describe, it, expect } from 'vitest';
import {
  chainAngleConstraint,
  dimMagnitude,
  emittedPointOnSnap,
  sameVertexRef,
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
  centerMidpoint,
  isPointSnapRef,
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
  it('circumscribed: n lines + a guide circle, chain coincidents, one variadic equal, n tangents', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 5, mode: 'circumscribed' });
    expect(e.geometry).toHaveLength(6);
    expect(e.geometry[5]).toEqual({ kind: 'circle', text: 'circle([0, 0], 20)', guide: true });
    // Guide ⌀20 across flats: vertices on the circumscribed radius
    // 10/cos(36°) ≈ 12.36, first vertex at +X (the preview's convention).
    expect(e.geometry[0].text).toBe('line([12.36, 0], [3.82, 11.76])');
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(5);
    const equal = e.constraints.filter(c => c.kind === 'equal');
    expect(equal).toHaveLength(1);
    expect(equal[0].targets).toHaveLength(5);
    expect(e.constraints.filter(c => c.kind === 'tangent')).toHaveLength(5);
    // Odd n: fully pinned without an angle.
    expect(e.constraints.filter(c => c.kind === 'angle')).toHaveLength(0);
  });

  it('circumscribed even n: leaves the last side out of the equal and pins one corner angle', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 6, mode: 'circumscribed' });
    const equal = e.constraints.filter(c => c.kind === 'equal');
    expect(equal).toHaveLength(1);
    // Pitot: the 6th side's equality is implied by the tangents; keeping it
    // would add a redundant row and leave the squished-hexagon freedom.
    expect(equal[0].targets).toEqual([0, 1, 2, 3, 4].map(i => ({ newIndex: i })));
    expect(e.constraints.filter(c => c.kind === 'tangent')).toHaveLength(6);
    const angles = e.constraints.filter(c => c.kind === 'angle');
    expect(angles).toHaveLength(1);
    expect(angles[0]).toEqual({ kind: 'angle', targets: [{ newIndex: 0 }, { newIndex: 1 }], valueExpr: '60' });
  });

  it('inscribed: vertices ride the guide circle instead of tangent sides', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 4, mode: 'inscribed' });
    expect(e.geometry).toHaveLength(5);
    expect(e.geometry[4]).toEqual({ kind: 'circle', text: 'circle([0, 0], 20)', guide: true });
    // Guide ⌀20 across corners: vertices at radius 10.
    expect(e.geometry[0].text).toBe('line([10, 0], [0, 10])');
    // 4 chain junctions + 4 vertex-on-circle.
    expect(e.constraints.filter(c => c.kind === 'coincident')).toHaveLength(8);
    expect(e.constraints.filter(c => c.kind === 'equal')[0].targets).toHaveLength(4);
    expect(e.constraints.filter(c => c.kind === 'tangent')).toHaveLength(0);
    expect(e.constraints.filter(c => c.kind === 'angle')).toHaveLength(0);
  });

  it('dims a typed ⌀ on the guide circle', () => {
    const e = polygonEmission({ center: [0, 0], diameter: 20, sides: 5, mode: 'circumscribed', diameterDim: '20' });
    const dim = e.constraints.find(c => c.kind === 'diameter');
    expect(dim?.targets).toEqual([{ newIndex: 5 }]);
    expect(dim?.valueExpr).toBe('20');
  });
});

describe('emittedPointOnSnap', () => {
  it('matches up to the 2dp rounding every emission applies', () => {
    // Solver-adjusted vertices rarely sit on the 2dp grid; the emitted
    // literal is their rounding, and the coincident must survive that.
    expect(emittedPointOnSnap([40, 0], [40.004, -0.003])).toBe(true);
    expect(emittedPointOnSnap([40, 0], [40, 0])).toBe(true);
  });

  it('rejects a point a quantization actually moved off the vertex', () => {
    expect(emittedPointOnSnap([40, 0], [40.02, 0])).toBe(false);
    expect(emittedPointOnSnap([40, 0], [40, 1.5])).toBe(false);
  });
});

describe('sameVertexRef', () => {
  it('compares line, occurrence, role and pointIndex', () => {
    expect(sameVertexRef(
      { line: 7, role: 'end', featureType: 'line' },
      { line: 7, role: 'end', featureType: 'line' },
    )).toBe(true);
    expect(sameVertexRef(
      { line: 7, role: 'end', featureType: 'line' },
      { line: 7, role: 'start', featureType: 'line' },
    )).toBe(false);
    expect(sameVertexRef(
      { line: 7, occurrence: 0, featureType: 'circle' },
      { line: 7, occurrence: 1, featureType: 'circle' },
    )).toBe(false);
  });

  it('axis datums are lines, not points — two snaps on one axis are distinct', () => {
    // The naive field comparison read undefined === undefined here and
    // swallowed the second coincident of every axis-snapped shape.
    expect(sameVertexRef({ datum: 'x-axis' }, { datum: 'x-axis' })).toBe(false);
    expect(sameVertexRef({ datum: 'y-axis' }, { datum: 'y-axis' })).toBe(false);
    expect(sameVertexRef({ datum: 'x-axis' }, { datum: 'y-axis' })).toBe(false);
    // The origin IS a point.
    expect(sameVertexRef({ datum: 'origin' }, { datum: 'origin' })).toBe(true);
    // A datum never equals a statement vertex.
    expect(sameVertexRef({ datum: 'x-axis' }, { line: 7, role: 'end', featureType: 'line' })).toBe(false);
  });
});

describe('slotEmission snap coincidents', () => {
  it('pins snapped cap centres onto their vertices', () => {
    const e = slotEmission({
      p0: [0, 0],
      p1: [40, 0],
      radius: 5,
      p0Snap: { line: 3, role: 'end', featureType: 'line' },
      p1Snap: { datum: 'origin' },
    });
    const coincidents = e.constraints.filter(c => c.kind === 'coincident');
    // 4 chain junctions + the two cap-centre pins.
    expect(coincidents).toHaveLength(6);
    // Snap pins are gesture inference — marked for the rail's redundancy trial.
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 3, role: 'center' }, { line: 3, role: 'end', featureType: 'line' }],
      inferred: true,
    });
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 1, role: 'center' }, { datum: 'origin' }],
      inferred: true,
    });
    expect(coincidents.filter(c => c.inferred)).toHaveLength(2);
  });
});

describe('rectEmission snap coincidents', () => {
  it('pins the snapped anchor and opposite corners onto their vertices', () => {
    const e = rectEmission({
      corner: [0, 0],
      w: 30,
      h: 20,
      cornerSnap: { line: 5, role: 'start', featureType: 'line' },
      oppositeSnap: { line: 9, role: 'center', featureType: 'circle' },
    });
    const coincidents = e.constraints.filter(c => c.kind === 'coincident');
    // 4 chain junctions + the two corner pins.
    expect(coincidents).toHaveLength(6);
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 0, role: 'start' }, { line: 5, role: 'start', featureType: 'line' }],
      inferred: true,
    });
    expect(coincidents).toContainEqual({
      kind: 'coincident',
      targets: [{ newIndex: 2, role: 'start' }, { line: 9, role: 'center', featureType: 'circle' }],
      inferred: true,
    });
    // The recipe's own rows (chain junctions, H/V) are explicit.
    expect(coincidents.filter(c => c.inferred)).toHaveLength(2);
    expect(e.constraints.filter(c => c.kind !== 'coincident').some(c => c.inferred)).toBe(false);
  });
});

describe('centered-gesture centre snaps (midpoint pins)', () => {
  it('rect: the snapped centre is the midpoint of the p0–p2 diagonal', () => {
    const e = rectEmission({
      corner: [-20, -15], w: 40, h: 30,
      centerSnap: { line: 5, role: 'start', featureType: 'line' },
    });
    expect(e.constraints.filter(c => c.kind === 'midpoint')).toEqual([{
      kind: 'midpoint',
      targets: [
        { line: 5, role: 'start', featureType: 'line' },
        { newIndex: 0, role: 'start' },
        { newIndex: 2, role: 'start' },
      ],
      inferred: true,
    }]);
    // The chain junctions and H/V stay explicit; nothing else is inferred.
    expect(e.constraints.filter(c => c.inferred)).toHaveLength(1);
  });

  it('rounded rect: the snapped centre is the midpoint of two diagonal arc centres', () => {
    const e = roundedRectEmission({
      corner: [-20, -15], w: 40, h: 30, radius: 5, centerSnap: { datum: 'origin' },
    });
    expect(e.constraints.filter(c => c.kind === 'midpoint')).toEqual([{
      kind: 'midpoint',
      targets: [{ datum: 'origin' }, { newIndex: 7, role: 'center' }, { newIndex: 3, role: 'center' }],
      inferred: true,
    }]);
    // Arc 7 centres at (xMin + r, yMin + r), arc 3 at (xMax − r, yMax − r):
    // their midpoint is the rect centre.
    expect(e.geometry[7].text).toBe('arc([-20, -10], [-15, -15], [-15, -10])');
    expect(e.geometry[3].text).toBe('arc([20, 10], [15, 15], [15, 10])');
  });

  it('slot: the snapped centre is the midpoint of the two cap centres', () => {
    const e = slotEmission({
      p0: [-20, 0], p1: [20, 0], radius: 5, centerSnap: { datum: 'origin' },
    });
    expect(e.constraints.filter(c => c.kind === 'midpoint')).toEqual([{
      kind: 'midpoint',
      targets: [{ datum: 'origin' }, { newIndex: 3, role: 'center' }, { newIndex: 1, role: 'center' }],
      inferred: true,
    }]);
  });

  it('axis datums are not points: no midpoint row for a centre-on-axis snap', () => {
    expect(isPointSnapRef({ datum: 'x-axis' })).toBe(false);
    expect(isPointSnapRef({ datum: 'y-axis' })).toBe(false);
    expect(isPointSnapRef({ datum: 'origin' })).toBe(true);
    expect(isPointSnapRef({ line: 5, role: 'end', featureType: 'line' })).toBe(true);
    expect(centerMidpoint({ datum: 'y-axis' }, { newIndex: 0, role: 'start' }, { newIndex: 2, role: 'start' })).toBeNull();
    for (const e of [
      rectEmission({ corner: [0, 0], w: 40, h: 30, centerSnap: { datum: 'x-axis' } }),
      roundedRectEmission({ corner: [0, 0], w: 40, h: 30, radius: 5, centerSnap: { datum: 'y-axis' } }),
      slotEmission({ p0: [0, 0], p1: [40, 0], radius: 5, centerSnap: { datum: 'x-axis' } }),
    ]) {
      expect(e.constraints.filter(c => c.kind === 'midpoint')).toHaveLength(0);
      expect(e.constraints.some(c => c.inferred)).toBe(false);
    }
  });
});

describe('emittedPointOnSnap with axis-datum refs', () => {
  it('validates point-on-axis, not point-near-cursor', () => {
    // An axis snap keeps the cursor's free coordinate — the snapped point can
    // sit far from where the geometry meets the axis.
    expect(emittedPointOnSnap([-10, 0], [-5, 0], { datum: 'x-axis' })).toBe(true);
    expect(emittedPointOnSnap([0, 7], [0, 2], { datum: 'y-axis' })).toBe(true);
    expect(emittedPointOnSnap([-10, 1.5], [-5, 0], { datum: 'x-axis' })).toBe(false);
    expect(emittedPointOnSnap([1.5, 7], [0, 2], { datum: 'y-axis' })).toBe(false);
  });

  it('origin and statement refs keep the pointwise comparison', () => {
    expect(emittedPointOnSnap([0, 0], [0, 0], { datum: 'origin' })).toBe(true);
    expect(emittedPointOnSnap([5, 0], [0, 0], { datum: 'origin' })).toBe(false);
    expect(emittedPointOnSnap([40, 0], [40.004, -0.003], { line: 7, role: 'end', featureType: 'line' })).toBe(true);
  });
});
