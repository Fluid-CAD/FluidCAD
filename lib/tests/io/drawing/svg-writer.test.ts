import { describe, it, expect } from "vitest";
import { SvgWriter } from "../../../io/drawing/svg-writer.js";
import type { SvgWriterOptions } from "../../../io/drawing/svg-writer.js";
import { Curves, DRAWING_TOLERANCE_MM } from "../../../io/drawing/drawing.js";
import type { Curve2D, Drawing2D, DrawingEntity, Vec2 } from "../../../io/drawing/drawing.js";
import { BSplineCurve2D } from "../../../io/drawing/bspline.js";
import type { LengthUnit } from "../../../units/units.js";
import { SvgReader } from "./svg-reader.js";
import type { SvgElement, SvgSegment } from "./svg-reader.js";

function drawingOf(entities: DrawingEntity[], unit: LengthUnit = 'mm'): Drawing2D {
  return { unit, entities, bounds: Curves.boundsOf(entities), warnings: [] };
}

/** One of every curve kind, on every layer — the DXF writer's own set. */
function everyKind(): DrawingEntity[] {
  const curves: Curve2D[] = [
    { kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 12.5 } },
    { kind: 'circle', center: { x: 20, y: 15 }, radius: 5 },
    { kind: 'arc', center: { x: -3, y: 4 }, radius: 7.25, start: 0.4, end: 2.9 },
    // Crosses the zero angle: end is past a full turn.
    { kind: 'arc', center: { x: 10, y: 10 }, radius: 3, start: 5.5, end: 7.0 },
    { kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: 3, y: 4 }, ratio: 0.4, start: 0, end: 2 * Math.PI },
    { kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: -6, y: 2 }, ratio: 0.75, start: 4, end: 7.5 },
    {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 0.3, 0.7, 1, 1, 1, 1],
      poles: [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 11, y: -3 }, { x: 16, y: 8 }, { x: 22, y: 1 }, { x: 25, y: 6 }],
    },
    {
      // A quarter circle of radius 10 as a rational quadratic.
      kind: 'bspline',
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      weights: [1, Math.SQRT1_2, 1],
    },
    { kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 5, y: 4 }, { x: 2, y: 6 }], closed: false },
    { kind: 'polyline', points: [{ x: 30, y: 0 }, { x: 33, y: 0 }, { x: 33, y: 3 }], closed: true },
  ];
  return curves.map((curve, i) => ({ layer: (['visible', 'tangent', 'hidden'] as const)[i % 3], curve }));
}

/** Samples per written path segment in the round trip. */
const PER_SEGMENT = 12;

const TOLERANCE = DRAWING_TOLERANCE_MM;

/** The one element a single-curve drawing is written as. */
function written(curve: Curve2D, options: SvgWriterOptions = {}): { element: SvgElement; top: number } {
  const drawing = drawingOf([{ layer: 'visible', curve }]);
  const file = SvgReader.parse(SvgWriter.write(drawing, options));
  expect(file.groups).toHaveLength(1);
  expect(file.groups[0].elements).toHaveLength(1);
  return { element: file.groups[0].elements[0], top: drawing.bounds!.max.y };
}

/** A path's points back in the drawing's frame: Y measured up again. */
function unflipped(segments: SvgSegment[], top: number, perSegment = PER_SEGMENT): Vec2[] {
  const points: Vec2[] = [];
  segments.forEach((segment, index) => {
    const samples = SvgReader.sample(segment, perSegment);
    for (const p of index === 0 ? samples : samples.slice(1)) {
      points.push({ x: p.x, y: top - p.y });
    }
  });
  return points;
}

/** The farthest any point of `actual` is from its counterpart in `expected`, walked the same way or backwards. */
function deviation(actual: Vec2[], expected: Vec2[]): number {
  expect(actual).toHaveLength(expected.length);
  const worst = (other: Vec2[]) => Math.max(...actual.map((p, i) => Math.hypot(p.x - other[i].x, p.y - other[i].y)));
  return Math.min(worst(expected), worst([...expected].reverse()));
}

/**
 * Where the written Bézier pieces of a spline should lie: piece `k` covers
 * knot span `k` of `spans` (the curve the writer cut into pieces), sampled
 * evenly — on `curve` itself, at the same parameters.
 */
function onSpans(curve: Extract<Curve2D, { kind: 'bspline' }>, spans: Extract<Curve2D, { kind: 'bspline' }>, perSegment = PER_SEGMENT): Vec2[] {
  const points: Vec2[] = [];
  const distinct = [...new Set(spans.knots)];
  for (let k = 0; k + 1 < distinct.length; k++) {
    for (let i = k === 0 ? 0 : 1; i <= perSegment; i++) {
      points.push(BSplineCurve2D.evaluate(curve, distinct[k] + ((distinct[k + 1] - distinct[k]) * i) / perSegment));
    }
  }
  return points;
}

describe("SvgWriter structure", () => {
  const text = SvgWriter.write(drawingOf(everyKind()), { title: 'Top view' });
  const file = SvgReader.parse(text);

  it("is a well-formed SVG document with a title", () => {
    // SvgReader.parse above already threw on malformed XML or a foreign root.
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg ')).toBe(true);
    expect(text.endsWith('</svg>\n')).toBe(true);
    expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
    expect(file.attributes.xmlns).toBe('http://www.w3.org/2000/svg');
    expect(file.attributes.version).toBe('1.1');
    expect(file.title).toBe('Top view');
    expect(SvgReader.parse(SvgWriter.write(drawingOf(everyKind()))).title).toBe('Drawing');
  });

  it("carries nothing that runs, loads or styles from outside its attributes", () => {
    expect(new Set(file.all.map((e) => e.tag))).toEqual(new Set(['title', 'g', 'path', 'circle']));
    expect(/<script|<style|<!DOCTYPE|<!ENTITY|<foreignObject|<image|<use|href|url\(|javascript:| on[a-z]+=/i.test(text)).toBe(false);
    // The only URIs are the two namespace names, which nothing fetches.
    expect(text.match(/https?:\/\/[^"]+/g)).toEqual([
      'http://www.w3.org/2000/svg',
      'http://www.inkscape.org/namespaces/inkscape',
    ]);
    for (const element of file.all) {
      expect(Object.keys(element.attributes)).not.toContain('style');
      expect(Object.keys(element.attributes)).not.toContain('class');
    }
  });

  it("writes one group per layer, back to front, as Inkscape layers", () => {
    expect(file.groups.map((g) => g.id)).toEqual(['hidden', 'tangent', 'visible']);
    for (const group of file.groups) {
      expect(group.attributes['inkscape:groupmode']).toBe('layer');
      expect(group.attributes.fill).toBe('none');
      expect(group.attributes['stroke-linecap']).toBe('round');
    }
    expect(file.groups.map((g) => g.attributes['inkscape:label'])).toEqual(['Hidden', 'Tangent', 'Visible']);
    expect(file.groups.map((g) => g.attributes.stroke)).toEqual(['#808080', '#c0c0c0', '#000000']);
  });

  it("strokes visible edges at the full width, the others at half, and dashes only the hidden ones", () => {
    expect(file.groups.map((g) => g.attributes['stroke-width'])).toEqual(['0.125', '0.125', '0.25']);
    expect(file.groups.map((g) => g.attributes['stroke-dasharray'])).toEqual(['3 1', undefined, undefined]);
  });

  it("writes only the layers in use", () => {
    const visibleOnly = SvgReader.parse(SvgWriter.write(drawingOf(everyKind().filter((e) => e.layer === 'visible'))));
    expect(visibleOnly.groups.map((g) => g.id)).toEqual(['visible']);
  });

  it("writes a lone circle as a circle and everything else as a path", () => {
    const tags = (id: string) => SvgReader.group(file, id).elements.map((e) => e.tag);
    // tangent: the circle, the full ellipse, the rational quarter circle.
    expect(tags('tangent').sort()).toEqual(['circle', 'path', 'path']);
    expect(tags('visible').every((tag) => tag === 'path')).toBe(true);
    expect(tags('hidden').every((tag) => tag === 'path')).toBe(true);
  });

  it("writes a valid, blank page for an empty drawing", () => {
    const empty = SvgReader.parse(SvgWriter.write(drawingOf([])));
    expect(empty.groups).toHaveLength(0);
    expect(empty.viewBox).toEqual({ x: -5, y: -5, width: 10, height: 10 });
    expect(empty.attributes.width).toBe('10mm');
    // Even with no margin the page has a size: zero would render nothing, anywhere.
    const bare = SvgReader.parse(SvgWriter.write(drawingOf([]), { margin: 0 }));
    expect(bare.viewBox.width).toBeGreaterThan(0);
    expect(bare.viewBox.height).toBeGreaterThan(0);
  });

  it("is the same bytes for the same drawing", () => {
    expect(SvgWriter.write(drawingOf(everyKind()), { title: 'Top view' })).toBe(text);
  });
});

describe("SvgWriter page", () => {
  const box: DrawingEntity[] = [
    { layer: 'visible', curve: { kind: 'line', a: { x: 10, y: 20 }, b: { x: 50, y: 20 } } },
    { layer: 'visible', curve: { kind: 'line', a: { x: 50, y: 20 }, b: { x: 50, y: 50 } } },
  ];

  it("frames the drawing's bounds plus the margin, X as in the model and Y down from the top", () => {
    const file = SvgReader.parse(SvgWriter.write(drawingOf(box)));
    expect(file.viewBox).toEqual({ x: 5, y: -5, width: 50, height: 40 });
    expect(file.attributes.width).toBe('50mm');
    expect(file.attributes.height).toBe('40mm');
    // (10, 20) is the lowest point: 30 below the top. (50, 50) is the top.
    expect(file.groups[0].elements[0].attributes.d).toBe('M 10 30 L 50 30 L 50 0');
  });

  it("takes the margin and the stroke width in millimetres", () => {
    const file = SvgReader.parse(SvgWriter.write(drawingOf(box), { margin: 0, strokeWidth: 0.5 }));
    expect(file.viewBox).toEqual({ x: 10, y: 0, width: 40, height: 30 });
    expect(file.groups[0].attributes['stroke-width']).toBe('0.5');
    const hidden = SvgReader.parse(SvgWriter.write(drawingOf(box.map((e) => ({ ...e, layer: 'hidden' as const }))), { strokeWidth: 0.5 }));
    expect(hidden.groups[0].attributes['stroke-width']).toBe('0.25');
    expect(hidden.groups[0].attributes['stroke-dasharray']).toBe('6 2');
  });

  it("refuses a stroke width or margin it cannot draw with", () => {
    for (const strokeWidth of [0, -1, NaN, Infinity]) {
      expect(() => SvgWriter.write(drawingOf(box), { strokeWidth })).toThrow(/stroke width/);
    }
    for (const margin of [-1, NaN, Infinity]) {
      expect(() => SvgWriter.write(drawingOf(box), { margin })).toThrow(/margin/);
    }
  });

  it("gives a drawing with no height a page to be seen on", () => {
    const flat: DrawingEntity[] = [{ layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 3 }, b: { x: 40, y: 3 } } }];
    const file = SvgReader.parse(SvgWriter.write(drawingOf(flat), { margin: 0 }));
    expect(file.viewBox.width).toBe(40);
    expect(file.viewBox.height).toBe(0.25);
    // The line runs through the middle of the band.
    expect(file.viewBox.y).toBe(-0.125);
    expect(file.groups[0].elements[0].attributes.d).toBe('M 0 0 L 40 0');
  });

  // unit, viewBox, width, height, visible stroke width: a 2 × 1 drawing with the default 5 mm margin.
  const cases: [LengthUnit, string, string, string, string][] = [
    ['mm', '-5 -5 12 11', '12mm', '11mm', '0.25'],
    ['cm', '-0.5 -0.5 3 2', '30mm', '20mm', '0.025'],
    ['m', '-0.005 -0.005 2.01 1.01', '2010mm', '1010mm', '0.00025'],
    ['in', '-0.196850394 -0.196850394 2.393700787 1.393700787', '2.393700787in', '1.393700787in', '0.00984252'],
    ['ft', '-0.0164041995 -0.0164041995 2.032808399 1.032808399', '24.393700787in', '12.393700787in', '0.00082021'],
  ];

  it.each(cases)("keeps a %s drawing's numbers and gives the page its physical size", (unit, viewBox, width, height, stroke) => {
    const entities: DrawingEntity[] = [{ layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 1 } } }];
    const file = SvgReader.parse(SvgWriter.write(drawingOf(entities, unit)));
    expect(file.attributes.viewBox).toBe(viewBox);
    expect(file.attributes.width).toBe(width);
    expect(file.attributes.height).toBe(height);
    expect(file.groups[0].attributes['stroke-width']).toBe(stroke);
    // The numbers are the document's own: (0, 0) → (2, 1), Y from the top.
    expect(file.groups[0].elements[0].attributes.d).toBe('M 0 1 L 2 0');
  });
});

describe("SvgWriter geometry round trip", () => {
  // Every written curve, read back by the format's own rules and with the
  // Y flip undone, lies on the curve it was written from.
  it("line", () => {
    const curve: Curve2D = { kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 12.5 } };
    const { element, top } = written(curve);
    const segments = SvgReader.segments(element.attributes.d);
    expect(segments.map((s) => s.command)).toEqual(['L']);
    expect(deviation(unflipped(segments, top), Curves.sample(curve, PER_SEGMENT))).toBeLessThan(1e-6);
  });

  it("circle", () => {
    const { element, top } = written({ kind: 'circle', center: { x: 20, y: 15 }, radius: 5 });
    expect(element.tag).toBe('circle');
    expect(Number(element.attributes.cx)).toBe(20);
    expect(top - Number(element.attributes.cy)).toBe(15);
    expect(Number(element.attributes.r)).toBe(5);
  });

  const arcs: [string, Extract<Curve2D, { kind: 'arc' | 'ellipse' }>][] = [
    ['a short arc', { kind: 'arc', center: { x: -3, y: 4 }, radius: 7.25, start: 0.4, end: 1.9 }],
    ['an arc over a third of a turn', { kind: 'arc', center: { x: -3, y: 4 }, radius: 7.25, start: 0.4, end: 2.9 }],
    ['an arc across the zero angle', { kind: 'arc', center: { x: 10, y: 10 }, radius: 3, start: 5.5, end: 7.0 }],
    ['a half turn', { kind: 'arc', center: { x: 0, y: 0 }, radius: 10, start: 0, end: Math.PI }],
    ['an arc a hair short of a full turn', { kind: 'arc', center: { x: 1, y: 2 }, radius: 4, start: 0.1, end: 0.1 + 2 * Math.PI - 0.01 }],
    ['a full ellipse', { kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: 3, y: 4 }, ratio: 0.4, start: 0, end: 2 * Math.PI }],
    ['a turned elliptical arc', { kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: -6, y: 2 }, ratio: 0.75, start: 4, end: 7.5 }],
    ['an elliptical arc with a steep axis', { kind: 'ellipse', center: { x: 0, y: 0 }, major: { x: 0.5, y: -8 }, ratio: 0.2, start: 1, end: 2.2 }],
  ];

  it.each(arcs)("%s", (_name, curve) => {
    const { element, top } = written(curve);
    const segments = SvgReader.segments(element.attributes.d);
    const drawn = segments.filter((s) => s.command === 'A');
    // A full ellipse closes with a zero-length Z; nothing else is in the path.
    expect(segments.filter((s) => s.command !== 'A').every((s) => s.command === 'Z' && Math.hypot(s.from.x - s.to.x, s.from.y - s.to.y) < 1e-9)).toBe(true);
    // No piece is long enough for its centre to hang on the last decimal, and none needs the large-arc flag.
    expect(drawn).toHaveLength(Math.max(1, Math.ceil((curve.end - curve.start) / ((2 * Math.PI) / 3) - 1e-9)));
    for (const arc of drawn) {
      if (arc.command === 'A') {
        expect(arc.largeArc).toBe(false);
        expect(Math.abs(SvgReader.arcCenter(arc).delta)).toBeLessThan((2 * Math.PI) / 3 + 1e-6);
      }
    }
    // The pieces are equal shares of the sweep, so together they sample the curve evenly.
    const expected = Curves.sample(curve, drawn.length * PER_SEGMENT);
    expect(deviation(unflipped(drawn, top), expected)).toBeLessThan(1e-6);
  });

  it("turns each arc the way the drawing does: counter-clockwise is sweep flag 0 on a page whose Y runs down", () => {
    // Walked from its start (the lower end) the first is counter-clockwise, the second clockwise.
    const forward = SvgReader.segments(written({ kind: 'arc', center: { x: 0, y: 0 }, radius: 5, start: 0, end: 1 }).element.attributes.d);
    const backward = SvgReader.segments(written({ kind: 'arc', center: { x: 0, y: 0 }, radius: 5, start: 2, end: 3 }).element.attributes.d);
    expect(forward.map((s) => s.command === 'A' && s.sweep)).toEqual([false]);
    expect(backward.map((s) => s.command === 'A' && s.sweep)).toEqual([true]);
  });

  it("writes a circle's radii, an ellipse's two semi-axes and the major axis' angle on the page", () => {
    const arc = SvgReader.segments(written({ kind: 'arc', center: { x: 0, y: 0 }, radius: 5, start: 0, end: 1 }).element.attributes.d)[0];
    expect(arc.command === 'A' && [arc.rx, arc.ry, arc.rotation]).toEqual([5, 5, 0]);
    // Major axis along (3, 4): 53.13° up in the drawing, so −53.13° on the page.
    const ellipse = SvgReader.segments(written({ kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: 3, y: 4 }, ratio: 0.4, start: 0, end: 1 }).element.attributes.d)[0];
    expect(ellipse.command === 'A' && [ellipse.rx, ellipse.ry]).toEqual([5, 2]);
    expect(ellipse.command === 'A' && ellipse.rotation).toBeCloseTo(-53.13010235, 7);
  });

  it("writes a cubic spline as its exact Bézier pieces, one per knot span", () => {
    const curve: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 0.3, 0.7, 1, 1, 1, 1],
      poles: [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 11, y: -3 }, { x: 16, y: 8 }, { x: 22, y: 1 }, { x: 25, y: 6 }],
    };
    const { element, top } = written(curve);
    const segments = SvgReader.segments(element.attributes.d);
    expect(segments.map((s) => s.command)).toEqual(['C', 'C', 'C']);
    expect(deviation(unflipped(segments, top), onSpans(curve, curve))).toBeLessThan(1e-6);
  });

  it("writes a quadratic spline with Q and a degree-one spline with L", () => {
    const quadratic: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline', degree: 2, knots: [0, 0, 0, 0.5, 1, 1, 1],
      poles: [{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 6, y: -1 }, { x: 9, y: 3 }],
    };
    const q = written(quadratic);
    const qs = SvgReader.segments(q.element.attributes.d);
    expect(qs.map((s) => s.command)).toEqual(['Q', 'Q']);
    expect(deviation(unflipped(qs, q.top), onSpans(quadratic, quadratic))).toBeLessThan(1e-6);

    const linear: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline', degree: 1, knots: [0, 0, 1, 2, 3, 3],
      poles: [{ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 6, y: -1 }, { x: 9, y: 3 }],
    };
    const l = written(linear);
    const ls = SvgReader.segments(l.element.attributes.d);
    expect(ls.map((s) => s.command)).toEqual(['L', 'L', 'L']);
    expect(deviation(unflipped(ls, l.top), onSpans(linear, linear))).toBeLessThan(1e-6);
  });

  it("writes a rational spline as cubics within the drawing's tolerance of it", () => {
    // A quarter circle of radius 10: SVG has no rational Bézier.
    const conic: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], weights: [1, Math.SQRT1_2, 1],
    };
    const { element, top } = written(conic);
    const segments = SvgReader.segments(element.attributes.d);
    expect(segments.every((s) => s.command === 'C')).toBe(true);
    // The pieces are the spans of the cubic the fit gives; each lies on the conic at the same parameters.
    const cubic = BSplineCurve2D.toCubic(conic, TOLERANCE);
    expect(deviation(unflipped(segments, top), onSpans(conic, cubic))).toBeLessThan(2 * TOLERANCE);
    // And every point of it is on the circle.
    for (const p of unflipped(segments, top)) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(2 * TOLERANCE);
    }
  });

  it("writes a spline above degree three as cubics within the drawing's tolerance of it", () => {
    const sextic: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline',
      degree: 6,
      knots: [0, 0, 0, 0, 0, 0, 0, 0.4, 1, 1, 1, 1, 1, 1, 1],
      poles: [
        { x: 0, y: 0 }, { x: 3, y: 8 }, { x: 7, y: 9 }, { x: 12, y: 2 },
        { x: 15, y: -4 }, { x: 19, y: 1 }, { x: 22, y: 6 }, { x: 26, y: 3 },
      ],
    };
    const { element, top } = written(sextic);
    const segments = SvgReader.segments(element.attributes.d);
    expect(segments.every((s) => s.command === 'C')).toBe(true);
    const cubic = BSplineCurve2D.toCubic(sextic, TOLERANCE);
    expect(deviation(unflipped(segments, top), onSpans(sextic, cubic))).toBeLessThan(2 * TOLERANCE);
  });

  it("writes polylines corner to corner, a closed one with Z", () => {
    const open = written({ kind: 'polyline', points: [{ x: 0, y: 0 }, { x: 3, y: 1 }, { x: 5, y: 4 }, { x: 2, y: 6 }], closed: false });
    expect(open.element.attributes.d).toBe('M 0 6 L 3 5 L 5 2 L 2 0');
    const closed = written({ kind: 'polyline', points: [{ x: 30, y: 0 }, { x: 33, y: 0 }, { x: 33, y: 3 }], closed: true });
    expect(closed.element.attributes.d).toBe('M 30 3 L 33 3 L 33 0 Z');
  });
});

describe("SvgWriter chains", () => {
  const line = (a: [number, number], b: [number, number]): DrawingEntity =>
    ({ layer: 'visible', curve: { kind: 'line', a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } } });
  const arc = (center: [number, number], radius: number, start: number, end: number): DrawingEntity =>
    ({ layer: 'visible', curve: { kind: 'arc', center: { x: center[0], y: center[1] }, radius, start, end } });

  /** How far `p` is from the nearest entity: exact for lines and arcs. */
  function offDrawing(p: Vec2, entities: DrawingEntity[]): number {
    let nearest = Infinity;
    for (const { curve } of entities) {
      if (curve.kind === 'line') {
        const dx = curve.b.x - curve.a.x;
        const dy = curve.b.y - curve.a.y;
        const t = Math.min(1, Math.max(0, ((p.x - curve.a.x) * dx + (p.y - curve.a.y) * dy) / (dx * dx + dy * dy)));
        nearest = Math.min(nearest, Math.hypot(p.x - curve.a.x - t * dx, p.y - curve.a.y - t * dy));
      } else if (curve.kind === 'arc') {
        let angle = Math.atan2(p.y - curve.center.y, p.x - curve.center.x);
        while (angle < curve.start - 1e-9) {
          angle += 2 * Math.PI;
        }
        if (angle <= curve.end + 1e-9) {
          nearest = Math.min(nearest, Math.abs(Math.hypot(p.x - curve.center.x, p.y - curve.center.y) - curve.radius));
        }
      }
    }
    return nearest;
  }

  it("writes a closed outline of lines and arcs as one path ending in Z, every point on the outline", () => {
    // A 40 × 30 plate with corners rounded at radius 5, given in no particular order.
    const entities: DrawingEntity[] = [
      line([5, 0], [35, 0]),
      arc([35, 25], 5, 0, Math.PI / 2),
      line([40, 5], [40, 25]),
      arc([5, 5], 5, Math.PI, 1.5 * Math.PI),
      line([35, 30], [5, 30]),
      arc([35, 5], 5, 1.5 * Math.PI, 2 * Math.PI),
      line([0, 25], [0, 5]),
      arc([5, 25], 5, Math.PI / 2, Math.PI),
    ];
    const drawing = drawingOf(entities);
    const file = SvgReader.parse(SvgWriter.write(drawing));
    expect(file.groups[0].elements).toHaveLength(1);
    const segments = SvgReader.segments(file.groups[0].elements[0].attributes.d);
    expect(segments.map((s) => s.command).join('')).toBe('LALALALAZ');
    // A loop is walked counter-clockwise: every arc keeps the drawing's own sense.
    expect(segments.every((s) => s.command !== 'A' || s.sweep === false)).toBe(true);
    for (const p of unflipped(segments, drawing.bounds!.max.y)) {
      expect(offDrawing(p, entities)).toBeLessThan(1e-6);
    }
  });

  it("leaves a loop's last straight side to Z", () => {
    const square = [line([0, 0], [10, 0]), line([10, 0], [10, 10]), line([10, 10], [0, 10]), line([0, 10], [0, 0])];
    const file = SvgReader.parse(SvgWriter.write(drawingOf(square), { margin: 0 }));
    expect(file.groups[0].elements.map((e) => e.attributes.d)).toEqual(['M 0 10 L 10 10 L 10 0 L 0 0 Z']);
    // An open run of the same three sides is not closed.
    const open = SvgReader.parse(SvgWriter.write(drawingOf(square.slice(0, 3)), { margin: 0 }));
    expect(open.groups[0].elements.map((e) => e.attributes.d)).toEqual(['M 0 10 L 10 10 L 10 0 L 0 0']);
  });

  it("walks an arc backwards where the chain does, with the flag turned", () => {
    // The run starts at its lower end, (−5, 0): the arc is walked from π back to π/2.
    const entities = [arc([0, 0], 5, Math.PI / 2, Math.PI), line([0, 5], [10, 5])];
    const drawing = drawingOf(entities);
    const file = SvgReader.parse(SvgWriter.write(drawing));
    expect(file.groups[0].elements).toHaveLength(1);
    const segments = SvgReader.segments(file.groups[0].elements[0].attributes.d);
    expect(segments.map((s) => s.command)).toEqual(['A', 'L']);
    expect(segments[0].command === 'A' && segments[0].sweep).toBe(true);
    expect(segments[0].from).toEqual({ x: -5, y: 5 });
    for (const p of unflipped(segments, drawing.bounds!.max.y)) {
      expect(offDrawing(p, entities)).toBeLessThan(1e-6);
    }
  });

  it("walks a spline backwards where the chain does", () => {
    const spline: Extract<Curve2D, { kind: 'bspline' }> = {
      kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1],
      poles: [{ x: 0, y: 10 }, { x: 3, y: 14 }, { x: 6, y: 4 }, { x: 9, y: 9 }, { x: 12, y: 0 }],
    };
    // The run's lower end is the spline's own end, (12, 0).
    const entities: DrawingEntity[] = [{ layer: 'visible', curve: spline }, line([0, 10], [-5, 20])];
    const drawing = drawingOf(entities);
    const file = SvgReader.parse(SvgWriter.write(drawing));
    const segments = SvgReader.segments(file.groups[0].elements[0].attributes.d);
    expect(segments.map((s) => s.command)).toEqual(['C', 'C', 'L']);
    const top = drawing.bounds!.max.y;
    expect(segments[0].from).toEqual({ x: 12, y: top });
    const curve = unflipped(segments.slice(0, 2), top);
    expect(deviation(curve, onSpans(spline, spline))).toBeLessThan(1e-6);
  });
});

describe("SvgWriter numbers", () => {
  it("never writes an exponent or a negative zero, and trims what it can", () => {
    expect(SvgWriter.number(0)).toBe('0');
    expect(SvgWriter.number(-0)).toBe('0');
    expect(SvgWriter.number(-1e-12)).toBe('0');
    expect(SvgWriter.number(1e-7)).toBe('0.0000001');
    expect(SvgWriter.number(40)).toBe('40');
    expect(SvgWriter.number(-12.5)).toBe('-12.5');
    expect(SvgWriter.number(1 / 3)).toBe('0.333333333');
    expect(SvgWriter.number(1200)).toBe('1200');
    expect(SvgWriter.number(123456789012.25)).toBe('123456789012.25');
  });

  it("writes each unit to the same physical fineness, so the kernel's rounding does not show", () => {
    const noisy = (unit: LengthUnit, x: number) => {
      const entities: DrawingEntity[] = [{ layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x, y: 0 } } }];
      return SvgReader.parse(SvgWriter.write(drawingOf(entities, unit), { margin: 0 })).groups[0].elements[0].attributes.d;
    };
    // 2e-9 mm short of 15 mm, in each unit: written as the round number it is.
    expect(noisy('mm', 14.999999998)).toBe('M 0 0 L 15 0');
    expect(noisy('cm', 1.4999999998)).toBe('M 0 0 L 1.5 0');
    expect(noisy('m', 0.014999999998)).toBe('M 0 0 L 0.015 0');
    // And a real ten-thousandth of a millimetre is kept, in every unit.
    expect(noisy('mm', 15.0001)).toBe('M 0 0 L 15.0001 0');
    expect(noisy('m', 0.0150001)).toBe('M 0 0 L 0.0150001 0');
    expect(noisy('in', 0.5000039)).toBe('M 0 0 L 0.5000039 0');
  });

  it("refuses what it cannot write", () => {
    expect(() => SvgWriter.number(NaN)).toThrow();
    expect(() => SvgWriter.number(Infinity)).toThrow();
    expect(() => SvgWriter.number(1e21)).toThrow();
  });

  it("writes no exponent anywhere in a file", () => {
    const tiny: DrawingEntity[] = [
      { layer: 'visible', curve: { kind: 'line', a: { x: 1e-12, y: -1e-12 }, b: { x: 1e9, y: 2.5e-8 } } },
    ];
    const text = SvgWriter.write(drawingOf(tiny));
    expect(/[0-9]e[-+]?[0-9]/i.test(text)).toBe(false);
    expect(/(^|[ "])-0([ "]|$)/.test(text)).toBe(false);
    expect(text.includes('NaN')).toBe(false);
    SvgReader.parse(text);
  });

  it("refuses a drawing with a non-finite coordinate or a malformed spline", () => {
    const bad: DrawingEntity[] = [{ layer: 'visible', curve: { kind: 'circle', center: { x: NaN, y: 0 }, radius: 1 } }];
    expect(() => SvgWriter.write({ unit: 'mm', entities: bad, bounds: null, warnings: [] })).toThrow();
    const spline: DrawingEntity[] = [{
      layer: 'visible',
      curve: { kind: 'bspline', degree: 3, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 1 }] },
    }];
    expect(() => SvgWriter.write(drawingOf(spline))).toThrow(/knots/);
  });
});

describe("SvgWriter golden files", () => {
  it("every curve kind on every layer", async () => {
    await expect(SvgWriter.write(drawingOf(everyKind()), { title: 'Top view' })).toMatchFileSnapshot('./golden/every-kind.svg');
  });

  it("an empty drawing", async () => {
    await expect(SvgWriter.write(drawingOf([]))).toMatchFileSnapshot('./golden/empty.svg');
  });

  it("an inch drawing with hidden lines", async () => {
    const entities: DrawingEntity[] = [
      { layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } } },
      { layer: 'visible', curve: { kind: 'arc', center: { x: 2, y: 0.5 }, radius: 0.5, start: 1.5 * Math.PI, end: 2.5 * Math.PI } },
      { layer: 'hidden', curve: { kind: 'circle', center: { x: 1, y: 0.5 }, radius: 0.125 } },
    ];
    await expect(SvgWriter.write(drawingOf(entities, 'in'), { title: 'Front view' })).toMatchFileSnapshot('./golden/inch-hidden.svg');
  });
});
