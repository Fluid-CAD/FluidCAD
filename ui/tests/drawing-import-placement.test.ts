import { describe, expect, it } from 'vitest';
import { DrawingPlacements } from '../src/interactive/tools/drawing-import-placement';
import { DrawingImportEmission } from '../src/interactive/tools/drawing-import-emission';
import { Affine } from '../../lib/io/drawing/affine.js';
import type { SketchImportPlan } from '../../lib/io/drawing/sketch-import.js';

// The import's two pure halves: where a placed drawing's points land, and
// the source text its plan is written as.

const BOUNDS = { min: { x: 100, y: 20 }, max: { x: 140, y: 40 } };

describe('DrawingPlacements', () => {
  it('as drawn, file coordinates are sketch coordinates times the scale', () => {
    const placement = DrawingPlacements.asDrawn(BOUNDS, 2);
    expect(placement).toEqual({ at: [240, 60], angle: 0, scale: 2 });
    const m = DrawingPlacements.affine(placement, BOUNDS);
    expect(Affine.point(m, { x: 100, y: 20 })).toEqual({ x: 200, y: 40 });
    expect(Affine.point(m, { x: 7, y: -3 })).toEqual({ x: 14, y: -6 });
    expect(DrawingPlacements.isAsDrawn(placement, BOUNDS)).toBe(true);
  });

  it('turns and scales about the centre of the bounds, which lands on `at`', () => {
    const m = DrawingPlacements.affine({ at: [0, 0], angle: 90, scale: 0.5 }, BOUNDS);
    const center = Affine.point(m, { x: 120, y: 30 });
    expect(center.x).toBeCloseTo(0, 12);
    expect(center.y).toBeCloseTo(0, 12);
    // The right end of the bounds is 20 from the centre: 10 after the scale, straight up after the quarter turn.
    const right = Affine.point(m, { x: 140, y: 30 });
    expect(right.x).toBeCloseTo(0, 12);
    expect(right.y).toBeCloseTo(10, 12);
  });

  it('frames the placed bounds, and reads a gesture on the frame back as a placement', () => {
    const placement = { at: [5, 6] as [number, number], angle: 30, scale: 2 };
    const frame = DrawingPlacements.frame(placement, BOUNDS);
    expect(frame.width).toBe(80);
    expect(frame.height).toBe(40);
    expect(DrawingPlacements.size(placement, BOUNDS)).toEqual({ width: 80, height: 40 });
    const moved = DrawingPlacements.fromFrame(frame.move([0, 0], [10, -4]), BOUNDS);
    expect(moved).toEqual({ at: [15, 2], angle: 30, scale: 2 });
    const turned = DrawingPlacements.fromFrame(frame.rotateTo([5, 100], null), BOUNDS);
    expect(turned).toEqual({ at: [5, 6], angle: 0, scale: 2 });
  });

  it('scales in proportion from a corner, the opposite corner staying put', () => {
    const frame = DrawingPlacements.frame({ at: [0, 0], angle: 0, scale: 1 }, BOUNDS);
    // The top-right corner (20, 10) dragged out along the diagonal to twice as far from the bottom-left one.
    const scaled = DrawingPlacements.fromFrame(frame.resizeFromCorner('tr', [60, 30], true), BOUNDS);
    expect(scaled.scale).toBeCloseTo(2, 12);
    expect(scaled.at[0]).toBeCloseTo(20, 12);
    expect(scaled.at[1]).toBeCloseTo(10, 12);
    expect(scaled.angle).toBe(0);
  });

  it('gives a drawing of one straight line a frame with a body, and still reads its scale from the long side', () => {
    const flat = { min: { x: 0, y: 5 }, max: { x: 50, y: 5 } };
    const frame = DrawingPlacements.frame({ at: [25, 5], angle: 0, scale: 1 }, flat);
    expect(frame.width).toBe(50);
    expect(frame.height).toBeGreaterThan(0);
    expect(frame.hitTest([25, 5 + frame.height / 4], { corner: 1, rotate: 1, stem: 5 })).toEqual({ part: 'body' });
    // From the bottom-left corner (0, 5 − h/2), the top-right one dragged twice as far along the diagonal.
    const scaled = DrawingPlacements.fromFrame(frame.resizeFromCorner('tr', [100, 5 + 1.5 * frame.height], true), flat);
    expect(scaled.scale).toBeCloseTo(2, 12);
    expect(DrawingPlacements.size(scaled, flat).height).toBe(0);
  });

  it('rescales a drawing left as drawn with its coordinates, and a moved one about its own centre', () => {
    const asDrawn = DrawingPlacements.asDrawn(BOUNDS, 1);
    expect(DrawingPlacements.rescaled(asDrawn, 25.4, BOUNDS)).toEqual(DrawingPlacements.asDrawn(BOUNDS, 25.4));
    const moved = { at: [0, 0] as [number, number], angle: 0, scale: 1 };
    expect(DrawingPlacements.isAsDrawn(moved, BOUNDS)).toBe(false);
    expect(DrawingPlacements.rescaled(moved, 25.4, BOUNDS)).toEqual({ at: [0, 0], angle: 0, scale: 25.4 });
    const turned = { ...asDrawn, angle: 15 };
    expect(DrawingPlacements.rescaled(turned, 3, BOUNDS)).toEqual({ at: [120, 30], angle: 15, scale: 3 });
  });

  it('centres on a point without changing the angle or the scale', () => {
    expect(DrawingPlacements.centeredOn({ at: [1, 2], angle: 40, scale: 3 }, [7, 8])).toEqual({ at: [7, 8], angle: 40, scale: 3 });
  });
});

describe('DrawingImportEmission', () => {
  it('writes numbers plainly: as rounded, no exponent, no negative zero', () => {
    expect(DrawingImportEmission.number(12)).toBe('12');
    expect(DrawingImportEmission.number(-3.25)).toBe('-3.25');
    expect(DrawingImportEmission.number(0.123457)).toBe('0.123457');
    expect(DrawingImportEmission.number(123456.789012)).toBe('123456.789012');
    expect(DrawingImportEmission.number(0.0000001)).toBe('0.0000001');
    expect(DrawingImportEmission.number(-0.00000025)).toBe('-0.00000025');
    expect(DrawingImportEmission.number(0)).toBe('0');
  });

  it('writes each primitive as its statement', () => {
    const text = (primitive: Parameters<typeof DrawingImportEmission.statement>[0]) => DrawingImportEmission.statement(primitive);
    expect(text({ kind: 'line', start: { x: 0, y: 0 }, end: { x: 40, y: 12.5 } }))
      .toEqual({ kind: 'line', text: 'line([0, 0], [40, 12.5])' });
    expect(text({ kind: 'arc', start: { x: 10, y: 0 }, end: { x: 0, y: 10 }, center: { x: 0, y: 0 } }))
      .toEqual({ kind: 'arc', text: 'arc([10, 0], [0, 10], [0, 0])' });
    expect(text({ kind: 'circle', center: { x: 20, y: 15 }, diameter: 10 }))
      .toEqual({ kind: 'circle', text: 'circle([20, 15], 10)' });
    expect(text({ kind: 'ellipse', center: { x: 5, y: -5 }, rx: 10, ry: 4, rotation: 30 }))
      .toEqual({ kind: 'ellipse', text: 'ellipse([5, -5], 10, 4, 30)' });
    expect(text({ kind: 'ellipse', center: { x: 5, y: -5 }, rx: 10, ry: 4, rotation: 0 }))
      .toEqual({ kind: 'ellipse', text: 'ellipse([5, -5], 10, 4)' });
    expect(text({ kind: 'bezier', points: [{ x: 0, y: 0 }, { x: 5, y: 8.5 }, { x: 10, y: 0 }] }))
      .toEqual({ kind: 'bezier', text: 'bezier([0, 0], [5, 8.5], [10, 0])' });
  });

  const PLAN: SketchImportPlan = {
    primitives: [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { kind: 'arc', start: { x: 10, y: 0 }, end: { x: 10, y: 10 }, center: { x: 10, y: 5 } },
      { kind: 'bezier', points: [{ x: 10, y: 10 }, { x: 5, y: 14 }, { x: 2, y: 6 }, { x: 0, y: 0 }] },
    ],
    joins: [
      { a: { primitive: 0, end: 'start' }, b: { primitive: 2, end: 'end' } },
      { a: { primitive: 0, end: 'end' }, b: { primitive: 1, end: 'start' } },
      { a: { primitive: 1, end: 'end' }, b: { primitive: 2, end: 'start' } },
    ],
    duplicates: 0,
    approximated: 0,
  };

  it('writes the plan as one emission: a statement each, a coincident per join, a bezier by its end points', () => {
    const request = DrawingImportEmission.request(PLAN, { joins: true });
    expect(request.geometry.map((g) => g.kind)).toEqual(['line', 'arc', 'bezier']);
    expect(request.constraints).toEqual([
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'start' }, { newIndex: 2, featureType: 'bezier', pointIndex: 3 }] },
      { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { newIndex: 1, role: 'start' }] },
      { kind: 'coincident', targets: [{ newIndex: 1, role: 'end' }, { newIndex: 2, featureType: 'bezier', pointIndex: 0 }] },
    ]);
    // Stated joins, not guesses a trial solve may drop.
    expect(request.constraints.some((c) => c.inferred)).toBe(false);
  });

  it('writes the geometry alone with joins off', () => {
    const request = DrawingImportEmission.request(PLAN, { joins: false });
    expect(request.geometry).toHaveLength(3);
    expect(request.constraints).toEqual([]);
  });
});
