import { describe, it, expect } from "vitest";
import { SvgReader } from "../../../io/drawing/svg-reader.js";
import { SvgWriter } from "../../../io/drawing/svg-writer.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Drawing2D, DrawingEntity, Vec2 } from "../../../io/drawing/drawing.js";
import type { ImportedDrawing } from "../../../io/drawing/import.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const INKSCAPE = 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';

/** A 100 × 100 page, one unit a pixel: a point at SVG (x, y) is read at (x, 100 − y). */
function page(body: string, attributes = 'width="100" height="100" viewBox="0 0 100 100"'): string {
  return `<svg ${NS} ${XLINK} ${INKSCAPE} ${attributes}>${body}</svg>`;
}

function curvesOf(text: string): Curve2D[] {
  return SvgReader.read(text).entities.map((e) => e.curve);
}

function expectPoint(actual: Vec2, expected: [number, number], digits = 9): void {
  expect(actual.x).toBeCloseTo(expected[0], digits);
  expect(actual.y).toBeCloseTo(expected[1], digits);
}

/** How far `p` is from the nearest of the curves, each taken as the chords between fine samples. */
function distanceTo(curves: readonly Curve2D[], p: Vec2): number {
  let nearest = Infinity;
  for (const curve of curves) {
    const points = Curves.sample(curve, curve.kind === 'line' ? 1 : 720);
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]];
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const length = dx * dx + dy * dy;
      const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
      nearest = Math.min(nearest, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
    }
  }
  return nearest;
}

/** Every point lies on the curves, within `tolerance`. */
function expectOn(curves: readonly Curve2D[], points: [number, number][], tolerance = 0.02): void {
  for (const [x, y] of points) {
    expect(distanceTo(curves, { x, y }), `(${x}, ${y})`).toBeLessThan(tolerance);
  }
}

// ─── Matrices by hand: what the reader's flattening is checked against ─────

type M = [number, number, number, number, number, number];
const mul = (p: M, q: M): M => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
];
const apply = (m: M, p: [number, number]): [number, number] => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): M => [x, 0, 0, y, 0, 0];
const rotate = (degrees: number): M => {
  const r = (degrees * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};
const skewX = (degrees: number): M => [1, 0, Math.tan((degrees * Math.PI) / 180), 1, 0, 0];
const skewY = (degrees: number): M => [1, Math.tan((degrees * Math.PI) / 180), 0, 1, 0, 0];
/** SVG page coordinates → the drawing's, for the 100-high page. */
const up = (p: [number, number]): [number, number] => [p[0], 100 - p[1]];

describe("SvgReader: what SvgWriter wrote", () => {
  const curves: Curve2D[] = [
    { kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 12.5 } },
    { kind: 'circle', center: { x: 20, y: 15 }, radius: 5 },
    { kind: 'arc', center: { x: -3, y: 4 }, radius: 7.25, start: 0.4, end: 2.9 },
    // More than a third of a turn: written as several arc commands.
    { kind: 'arc', center: { x: 50, y: 30 }, radius: 6, start: 5.5, end: 5.5 + 4.6 },
    { kind: 'ellipse', center: { x: 5, y: -5 }, major: { x: 3, y: 4 }, ratio: 0.4, start: 0, end: 2 * Math.PI },
    { kind: 'ellipse', center: { x: 35, y: -5 }, major: { x: -6, y: 2 }, ratio: 0.75, start: 4, end: 7.5 },
    {
      kind: 'bspline',
      degree: 3,
      knots: [0, 0, 0, 0, 0.3, 0.7, 1, 1, 1, 1],
      poles: [{ x: 0, y: 20 }, { x: 4, y: 29 }, { x: 11, y: 17 }, { x: 16, y: 28 }, { x: 22, y: 21 }, { x: 25, y: 26 }],
    },
    { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 60, y: 0 }, { x: 65, y: 10 }, { x: 70, y: 0 }] },
  ];
  const entities: DrawingEntity[] = curves.map((curve, i) => ({ layer: (['visible', 'tangent', 'hidden'] as const)[i % 3], curve }));
  const bounds = Curves.boundsOf(entities)!;
  const drawing: Drawing2D = { unit: 'mm', entities, bounds, warnings: [] };
  const read = SvgReader.read(SvgWriter.write(drawing, { margin: 5 }));
  // The export puts the drawing on a page with a margin around it; the page's lower-left corner is the origin.
  const shift = (p: Vec2): [number, number] => [p.x - (bounds.min.x - 5), p.y - (bounds.min.y - 5)];

  it("reads every curve back where the page has it", () => {
    const got = read.entities.map((e) => e.curve);
    for (const curve of curves) {
      expectOn(got, Curves.sample(curve, 24).map(shift), 0.005);
    }
    // And nothing that was not drawn: every curve read lies on a curve written.
    const written = curves.map((curve): Curve2D => {
      const moved = JSON.parse(JSON.stringify(curve));
      for (const key of ['a', 'b', 'center']) {
        if (moved[key]) {
          [moved[key].x, moved[key].y] = shift(moved[key]);
        }
      }
      moved.poles?.forEach((pole: Vec2) => { [pole.x, pole.y] = shift(pole); });
      return moved;
    });
    for (const curve of got) {
      expectOn(written, Curves.sample(curve, 12).map((p): [number, number] => [p.x, p.y]), 0.005);
    }
  });

  it("puts an arc written in pieces back together, and keeps a circle a circle", () => {
    const kinds = read.entities.map((e) => e.curve.kind).sort();
    // Six curves in: the two arcs one arc each, the ellipse whole, its arc in the pieces it was written in, the splines as their béziers.
    expect(kinds.filter((kind) => kind === 'arc')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'circle')).toHaveLength(1);
    const full = read.entities.map((e) => e.curve).filter((c) => c.kind === 'ellipse' && c.end - c.start > 6.28);
    expect(full).toHaveLength(1);
    const long = read.entities.map((e) => e.curve).find((c) => c.kind === 'arc' && Math.abs(c.radius - 6) < 1e-6) as Extract<Curve2D, { kind: 'arc' }>;
    expect(long.end - long.start).toBeCloseTo(4.6, 6);
  });

  it("reads the unit from the page's size, and the layers by their names", () => {
    expect(read.unit).toEqual({ name: 'mm', mm: 1 });
    expect(read.layers.map((l) => l.name)).toEqual(['Hidden', 'Tangent', 'Visible']);
    expect(read.layers.every((l) => !l.hidden)).toBe(true);
    expect(read.skipped).toEqual({});
    expect(read.warnings).toEqual([]);
  });

  it("reads an inch drawing in inches", () => {
    const inch = SvgReader.read(SvgWriter.write({ ...drawing, unit: 'in' }));
    expect(inch.unit?.name).toBe('in');
    expect(inch.unit?.mm).toBeCloseTo(25.4, 9);
  });
});

describe("SvgReader: the page", () => {
  const dot = '<path d="M10 20 L30 20" stroke="black"/>';
  const lineOf = (text: string) => SvgReader.read(text).entities[0].curve as Extract<Curve2D, { kind: 'line' }>;

  it("turns the page over: its lower-left corner is the origin, and up is up", () => {
    const line = lineOf(page(dot));
    expect(line).toEqual({ kind: 'line', a: { x: 10, y: 80 }, b: { x: 30, y: 80 } });
  });

  it("keeps the view box's own numbers, and says how long one is from the page's size", () => {
    const mm = SvgReader.read(page(dot, 'width="100mm" height="50mm" viewBox="0 0 100 50"'));
    expect(mm.unit).toEqual({ name: 'mm', mm: 1 });
    expect(mm.entities[0].curve).toEqual({ kind: 'line', a: { x: 10, y: 30 }, b: { x: 30, y: 30 } });

    const tenth = SvgReader.read(page(dot, 'width="100mm" height="50mm" viewBox="0 0 1000 500"'));
    expect(tenth.unit).toEqual({ name: '0.1 mm', mm: 0.1 });
    expect(tenth.entities[0].curve).toEqual({ kind: 'line', a: { x: 10, y: 480 }, b: { x: 30, y: 480 } });

    const inch = SvgReader.read(page(dot, 'width="8in" height="4in" viewBox="0 0 8 4"'));
    expect(inch.unit?.name).toBe('in');

    const cm = SvgReader.read(page(dot, 'width="20cm" height="10cm" viewBox="0 0 20 10"'));
    expect(cm.unit?.name).toBe('cm');
  });

  it("reads a size in pixels, or without a unit, as 96 to the inch", () => {
    for (const attributes of ['width="100" height="100"', 'width="100px" height="100px" viewBox="0 0 100 100"']) {
      const read = SvgReader.read(page(dot, attributes));
      expect(read.unit?.name).toBe('px');
      expect(read.unit?.mm).toBeCloseTo(25.4 / 96, 12);
    }
    const points = SvgReader.read(page(dot, 'width="72pt" height="72pt"'));
    expect(points.unit?.name).toBe('px');
    // No view box: the user unit is the pixel, and the page 96 of them high.
    expectPoint((points.entities[0].curve as { a: Vec2 }).a, [10, 76]);
  });

  it("says nothing of the unit when the file gives its page no size", () => {
    const read = SvgReader.read(page(dot, 'viewBox="0 0 24 24"'));
    expect(read.unit).toBeNull();
    // The view box is the page.
    expect(read.entities[0].curve).toEqual({ kind: 'line', a: { x: 10, y: 4 }, b: { x: 30, y: 4 } });
    expect(SvgReader.read(page(dot, 'width="100%" height="100%" viewBox="0 0 24 24"')).unit).toBeNull();
  });

  it("measures up from the page's top edge when there is no page", () => {
    const read = SvgReader.read(page(dot, ''));
    expect(read.unit).toBeNull();
    expect(read.entities[0].curve).toEqual({ kind: 'line', a: { x: 10, y: -20 }, b: { x: 30, y: -20 } });
  });

  it("works a missing side out from the other and the view box", () => {
    const read = SvgReader.read(page(dot, 'width="200" viewBox="0 0 100 40"'));
    expect(read.unit?.mm).toBeCloseTo((25.4 / 96) * 2, 12);
    expect(read.entities[0].curve).toEqual({ kind: 'line', a: { x: 10, y: 20 }, b: { x: 30, y: 20 } });
  });

  it("starts the page at the view box's corner, wherever that is", () => {
    const line = lineOf(page(dot, 'width="100" height="100" viewBox="-50 -50 100 100"'));
    expect(line).toEqual({ kind: 'line', a: { x: 60, y: 30 }, b: { x: 80, y: 30 } });
  });

  it("puts a view box that does not fill its page where preserveAspectRatio says", () => {
    // A 100 × 50 box on a 200 × 200 page: twice the size, centred, with 50 pixels (25 units) of page under it.
    const centred = lineOf(page(dot, 'width="200" height="200" viewBox="0 0 100 50"'));
    expect(centred).toEqual({ kind: 'line', a: { x: 10, y: 55 }, b: { x: 30, y: 55 } });
    const top = lineOf(page(dot, 'width="200" height="200" viewBox="0 0 100 50" preserveAspectRatio="xMidYMin"'));
    expect(top).toEqual({ kind: 'line', a: { x: 10, y: 80 }, b: { x: 30, y: 80 } });
    const bottom = lineOf(page(dot, 'width="200" height="200" viewBox="0 0 100 50" preserveAspectRatio="xMidYMax meet"'));
    expect(bottom).toEqual({ kind: 'line', a: { x: 10, y: 30 }, b: { x: 30, y: 30 } });
    // Sliced: four times the size, the box's sides cut off left and right.
    const sliced = lineOf(page(dot, 'width="200" height="200" viewBox="0 0 100 50" preserveAspectRatio="xMidYMid slice"'));
    expect(sliced).toEqual({ kind: 'line', a: { x: -15, y: 30 }, b: { x: 5, y: 30 } });
  });

  it("reads a page stretched with preserveAspectRatio none in page pixels, and says so", () => {
    const read = SvgReader.read(page('<circle cx="50" cy="25" r="10"/>', 'width="200" height="200" viewBox="0 0 100 50" preserveAspectRatio="none"'));
    expect(read.unit?.name).toBe('px');
    expect(read.entities[0].curve).toMatchObject({ kind: 'ellipse', center: { x: 100, y: 100 }, ratio: expect.closeTo(0.5, 12) });
    expect(Curves.bounds(read.entities[0].curve)).toMatchObject({ min: { x: expect.closeTo(80, 9), y: expect.closeTo(60, 9) } });
    expect(read.warnings.join(' ')).toMatch(/stretches its drawing/);
  });

  it("reads a file from Inkscape before 0.92 at 90 to the inch", () => {
    const old = `<svg ${NS} ${INKSCAPE} inkscape:version="0.48.4 r9939" width="210mm" height="297mm">${dot}</svg>`;
    const read = SvgReader.read(old);
    expect(read.unit?.name).toBe('px at 90 per inch');
    expect(read.unit?.mm).toBeCloseTo(25.4 / 90, 12);
    // The page is 297 mm of 90-per-inch units high.
    expectPoint((read.entities[0].curve as { a: Vec2 }).a, [10, (297 * 90) / 25.4 - 20], 6);
    expect(read.warnings.join(' ')).toMatch(/Inkscape before 0\.92/);
    // With a view box the file says its own scale; from 0.92 on, the unit is CSS's.
    expect(SvgReader.read(old.replace('height="297mm"', 'height="297mm" viewBox="0 0 210 297"')).unit).toEqual({ name: 'mm', mm: 1 });
    expect(SvgReader.read(old.replace('0.48.4 r9939', '0.92.3 (2405546, 2018-03-11)')).unit?.name).toBe('px');
    expect(SvgReader.read(old.replace('0.48.4 r9939', '1.2 (dc2aedaf03, 2022-05-15)')).warnings).toEqual([]);
  });

  it("reads a file Adobe Illustrator wrote at 72 to the inch, unless it gives a physical size", () => {
    const head = '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 24.1.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n';
    const read = SvgReader.read(`${head}<svg ${NS} x="0px" y="0px" viewBox="0 0 612 792">${dot}</svg>`);
    expect(read.unit?.name).toBe('pt');
    expect(read.unit?.mm).toBeCloseTo(25.4 / 72, 12);
    expect(read.warnings.join(' ')).toMatch(/Adobe Illustrator.*72/);
    expect(SvgReader.read(`${head}<svg ${NS} width="612px" height="792px" viewBox="0 0 612 792">${dot}</svg>`).unit?.name).toBe('pt');
    const sized = SvgReader.read(`${head}<svg ${NS} width="8.5in" height="11in" viewBox="0 0 612 792">${dot}</svg>`);
    expect(sized.unit?.name).toBe('pt');
    expect(sized.warnings).toEqual([]);
  });
});

describe("SvgReader: transforms flattened", () => {
  it("works every transform between a shape and the page into its numbers", () => {
    const body = `<g transform="translate(40 30) rotate(20)"><g transform="scale(1.5 0.75) skewX(15)">
      <g transform="matrix(0.8 0.3 -0.2 1.1 3 2)"><path transform="skewY(-10) translate(1,1)" d="M0 0 L10 0 L10 5" stroke="black"/></g></g></g>`;
    const m = [translate(40, 30), rotate(20), scale(1.5, 0.75), skewX(15), [0.8, 0.3, -0.2, 1.1, 3, 2] as M, skewY(-10), translate(1, 1)].reduce(mul);
    const [first, second] = curvesOf(page(body)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(first.a, up(apply(m, [0, 0])));
    expectPoint(first.b, up(apply(m, [10, 0])));
    expectPoint(second.b, up(apply(m, [10, 5])));
  });

  it("turns about a point, with the attribute's three numbers", () => {
    const [line] = curvesOf(page('<path transform="rotate(90 50 50)" d="M60 50 L70 50" stroke="black"/>')) as Extract<Curve2D, { kind: 'line' }>[];
    // A quarter turn on the page, clockwise as seen: from the right of the centre to under it.
    expectPoint(line.a, up([50, 60]));
    expectPoint(line.b, up([50, 70]));
  });

  it("keeps a circle a circle under a turn and an even scale, and makes it an ellipse under an uneven one", () => {
    const [same, grown, squashed, sheared] = curvesOf(page(`
      <circle transform="translate(10 10) rotate(33)" cx="5" cy="0" r="4"/>
      <circle transform="scale(2)" cx="20" cy="20" r="4"/>
      <circle transform="translate(60 20) scale(2 1)" r="5"/>
      <circle transform="translate(20 70) skewX(45)" r="5"/>`));
    expect(same).toMatchObject({ kind: 'circle', radius: expect.closeTo(4, 9) });
    expectPoint((same as { center: Vec2 }).center, up(apply(mul(translate(10, 10), rotate(33)), [5, 0])));
    expect(grown).toMatchObject({ kind: 'circle', center: { x: 40, y: 60 }, radius: expect.closeTo(8, 9) });
    expect(squashed).toMatchObject({ kind: 'ellipse', center: { x: 60, y: 80 }, ratio: expect.closeTo(0.5, 12) });
    expectPoint((squashed as { major: Vec2 }).major, [10, 0]);
    expect(sheared.kind).toBe('ellipse');
    expectOn([sheared], [0, 1, 2, 3, 4, 5].map((t) => up(apply(mul(translate(20, 70), skewX(45)), [5 * Math.cos(t), 5 * Math.sin(t)]))));
  });

  it("keeps an arc the arc it is under a mirror: the same points, turning the other way", () => {
    // A quarter arc from (10, 0) to (0, 10) about the origin, mirrored left to right and moved.
    const d = "M10 0 A10 10 0 0 1 0 10";
    const [plain, mirrored] = curvesOf(page(`<g transform="translate(50 50)"><path d="${d}" stroke="black"/><path transform="scale(-1 1)" d="${d}" stroke="black"/></g>`));
    expect(plain.kind).toBe('arc');
    expect(mirrored.kind).toBe('arc');
    const on = (m: M) => [0, 0.25, 0.5, 0.75, 1].map((f) => up(apply(m, [10 * Math.cos((f * Math.PI) / 2), 10 * Math.sin((f * Math.PI) / 2)])));
    expectOn([plain], on(translate(50, 50)), 1e-6);
    expectOn([mirrored], on(mul(translate(50, 50), scale(-1, 1))), 1e-6);
    // Each is a quarter turn, not the three quarters on the other side.
    for (const arc of [plain, mirrored] as Extract<Curve2D, { kind: 'arc' }>[]) {
      expect(arc.end - arc.start).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it("takes an elliptical arc through a shear to the points the shear takes it to", () => {
    const m = mul(mul(translate(30, 40), rotate(-25)), skewX(30));
    const curves = curvesOf(page('<path transform="translate(30 40) rotate(-25) skewX(30)" d="M0 0 A 20 8 15 1 1 12 9" stroke="black"/>'));
    expect(curves).toHaveLength(1);
    // The arc's own points by the format's definition, worked out in the path's coordinates first.
    const [flat] = curvesOf(page('<path d="M0 0 A 20 8 15 1 1 12 9" stroke="black"/>'));
    expectOn(curves, Curves.sample(flat, 16).map((p) => up(apply(m, [p.x, 100 - p.y]))), 1e-6);
  });

  it("reads a transform given as a style, with its units", () => {
    const [a, b] = curvesOf(page(`
      <path style="transform: translate(10px, 20px) rotate(90deg)" d="M0 0 L10 0" stroke="black"/>
      <path style="transform: rotate(0.25turn)" transform="translate(99 99)" d="M0 0 L10 0" stroke="black"/>`)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(a.b, up([10, 30]));
    // The style wins over the attribute.
    expectPoint(b.b, up([0, 10]));
  });

  it("transforms about transform-origin: a point, or a share of the view box or of the shape's own box", () => {
    const rect = (extra: string) => curvesOf(page(`<rect x="20" y="20" width="40" height="20" ${extra}/>`)) as Extract<Curve2D, { kind: 'line' }>[];
    const about = (ox: number, oy: number, m: M) => mul(mul(translate(ox, oy), m), translate(-ox, -oy));
    const corner = (lines: Extract<Curve2D, { kind: 'line' }>[]) => lines[0].a;

    expectPoint(corner(rect('transform="rotate(90)" transform-origin="40 30"')), up(apply(about(40, 30, rotate(90)), [20, 20])));
    // Percentages of the view box, which is 100 × 100 here.
    expectPoint(corner(rect('style="transform: scale(0.5); transform-origin: 50% 50%"')), up(apply(about(50, 50, scale(0.5, 0.5)), [20, 20])));
    expectPoint(corner(rect('style="transform: scale(2); transform-origin: right bottom"')), up(apply(about(100, 100, scale(2, 2)), [20, 20])));
    // The shape's own box: its centre is (40, 30).
    expectPoint(corner(rect('style="transform: rotate(90deg); transform-origin: center; transform-box: fill-box"')), up(apply(about(40, 30, rotate(90)), [20, 20])));
    expectPoint(corner(rect('style="transform: scale(2); transform-origin: top left; transform-box: fill-box"')), up([20, 20]));

    // A group's box is its children's together.
    const [grouped] = curvesOf(page(`<g style="transform: rotate(180deg); transform-origin: center; transform-box: fill-box">
      <path d="M10 10 L30 10" stroke="black"/><path d="M10 50 L30 50" stroke="black"/></g>`)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(grouped.a, up([30, 50]));
  });

  it("ignores a transform it cannot read, and says so", () => {
    const read = SvgReader.read(page('<path transform="rotate(45" d="M0 0 L10 0" stroke="black"/><path transform="rotateX(40deg)" d="M0 10 L10 10" stroke="black"/>'));
    expect(read.entities[0].curve).toEqual({ kind: 'line', a: { x: 0, y: 100 }, b: { x: 10, y: 100 } });
    expect(read.warnings.join(' ')).toMatch(/2 transforms could not be read/);
  });

  it("drops what a transform flattens to nothing", () => {
    const read = SvgReader.read(page('<g transform="scale(0)"><circle r="5"/><path d="M0 0 L10 10" stroke="black"/></g><path d="M0 0 L1 1" stroke="black"/>'));
    expect(read.entities).toHaveLength(1);
  });
});

describe("SvgReader: shapes", () => {
  it("reads a rectangle as its four sides, from the top edge round", () => {
    const lines = curvesOf(page('<rect x="10" y="20" width="30" height="15"/>'));
    expect(lines).toEqual([
      { kind: 'line', a: { x: 10, y: 80 }, b: { x: 40, y: 80 } },
      { kind: 'line', a: { x: 40, y: 80 }, b: { x: 40, y: 65 } },
      { kind: 'line', a: { x: 40, y: 65 }, b: { x: 10, y: 65 } },
      { kind: 'line', a: { x: 10, y: 65 }, b: { x: 10, y: 80 } },
    ]);
  });

  it("rounds a rectangle's corners with arcs: one radius for both when one is given, never past half a side", () => {
    const one = curvesOf(page('<rect x="10" y="20" width="40" height="20" rx="5"/>'));
    expect(one.map((c) => c.kind)).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc']);
    expect(one[1]).toMatchObject({ center: { x: 45, y: 75 }, radius: expect.closeTo(5, 12) });
    expectOn([one[1]], [[45, 80], [45 + 5 * Math.SQRT1_2, 75 + 5 * Math.SQRT1_2], [50, 75]], 1e-9);
    expect(curvesOf(page('<rect x="10" y="20" width="40" height="20" ry="5"/>'))).toEqual(one);

    // Different radii: quarter ellipses.
    const two = curvesOf(page('<rect x="10" y="20" width="40" height="20" rx="8" ry="4"/>'));
    expect(two.map((c) => c.kind)).toEqual(['line', 'ellipse', 'line', 'ellipse', 'line', 'ellipse', 'line', 'ellipse']);

    // A radius of half the height: the ends are half circles, the short sides gone.
    const stadium = curvesOf(page('<rect x="10" y="20" width="40" height="20" rx="10"/>'));
    expect(stadium.map((c) => c.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    expect((stadium[1] as { end: number }).end - (stadium[1] as { start: number }).start).toBeCloseTo(Math.PI, 9);

    // Past half of both sides each radius stops at its own half: the ellipse the rectangle holds.
    expect(curvesOf(page('<rect x="10" y="20" width="40" height="20" rx="50"/>'))).toMatchObject(
      [{ kind: 'ellipse', center: { x: 30, y: 70 }, ratio: expect.closeTo(0.5, 12), start: 0, end: 2 * Math.PI }]);
    // A square rounded all the way is a circle.
    expect(curvesOf(page('<rect x="10" y="20" width="20" height="20" rx="10"/>'))).toEqual([{ kind: 'circle', center: { x: 20, y: 70 }, radius: 10 }]);
    // A negative radius is no radius.
    expect(curvesOf(page('<rect x="10" y="20" width="40" height="20" rx="-5"/>')).map((c) => c.kind)).toEqual(['line', 'line', 'line', 'line']);
  });

  it("draws nothing for a shape without a size", () => {
    expect(curvesOf(page(`<rect x="1" y="1" width="0" height="5"/><rect width="5" height="-5"/><rect width="5"/>
      <circle cx="5" cy="5" r="0"/><circle cx="5" cy="5"/><circle r="-3"/><ellipse rx="5" ry="0"/><ellipse/>
      <polyline points="5 5"/><polygon points=""/><path/><path d=""/><line x1="5" y1="5" x2="5" y2="5" stroke="black"/>`))).toEqual([]);
  });

  it("reads circles and ellipses, an ellipse with one radius as the circle it is", () => {
    const [circle, ellipse, auto] = curvesOf(page('<circle cx="20" cy="30" r="5"/><ellipse cx="60" cy="30" rx="10" ry="4"/><ellipse cx="60" cy="70" rx="6"/>'));
    expect(circle).toEqual({ kind: 'circle', center: { x: 20, y: 70 }, radius: 5 });
    expect(ellipse).toMatchObject({ kind: 'ellipse', center: { x: 60, y: 70 }, ratio: expect.closeTo(0.4, 12), start: 0, end: 2 * Math.PI });
    expect(auto).toEqual({ kind: 'circle', center: { x: 60, y: 30 }, radius: 6 });
  });

  it("reads lines, polylines and polygons, a polygon closed and a lone last number dropped", () => {
    const curves = curvesOf(page(`<line x1="0" y1="0" x2="10" y2="10" stroke="black"/>
      <polyline points="20,0 30,0 30,10 99" stroke="black"/><polygon points="50 0, 60 0, 60 10"/>`)) as Extract<Curve2D, { kind: 'line' }>[];
    expect(curves).toHaveLength(1 + 2 + 3);
    expect(curves[0]).toEqual({ kind: 'line', a: { x: 0, y: 100 }, b: { x: 10, y: 90 } });
    expect(curves[2].b).toEqual({ x: 30, y: 90 });
    expect(curves[5]).toEqual({ kind: 'line', a: { x: 60, y: 90 }, b: { x: 50, y: 100 } });
  });

  it("takes lengths with their units, and percentages of the view box", () => {
    const [circle, line] = curvesOf(page(
      '<circle cx="50%" cy="25%" r="10%"/><line x1="1in" y1="0" x2="2.54cm" y2="72pt" stroke="black"/>',
      'width="200" height="400" viewBox="0 0 200 400"',
    ));
    // A radius in percent is of the box's diagonal over √2.
    expect(circle).toMatchObject({ kind: 'circle', center: { x: 100, y: 300 }, radius: expect.closeTo(Math.hypot(200, 400) / Math.SQRT2 / 10, 9) });
    expectPoint((line as { a: Vec2 }).a, [96, 400]);
    expectPoint((line as { b: Vec2 }).b, [96, 304]);
  });

  it("reads a path's curves as béziers of their own degree", () => {
    const [cubic, quadratic] = curvesOf(page('<path d="M0 0 C10 30 30 30 40 0 Q50 -20 60 10" stroke="black" fill="none"/>')) as Extract<Curve2D, { kind: 'bspline' }>[];
    expect(cubic).toEqual({
      kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1],
      poles: [{ x: 0, y: 100 }, { x: 10, y: 70 }, { x: 30, y: 70 }, { x: 40, y: 100 }],
    });
    expect(quadratic).toMatchObject({ degree: 2, knots: [0, 0, 0, 1, 1, 1] });
  });

  it("reads a path with an error up to it, and says so", () => {
    const read = SvgReader.read(page('<path d="M0 0 L10 0 L20" stroke="black"/><path d="M0 5 L10 5 ! L20 5" stroke="black"/>'));
    expect(read.entities).toHaveLength(2);
    expect(read.warnings.join(' ')).toMatch(/2 paths have an error in their data and were read up to it/);
  });

  it("reads a circle a path draws as four béziers as the circle, and says how many béziers it took for arcs", () => {
    const k = 0.5523;
    const d = `M70 50 C70 ${50 + 20 * k} ${50 + 20 * k} 70 50 70 C${50 - 20 * k} 70 30 ${50 + 20 * k} 30 50 C30 ${50 - 20 * k} ${50 - 20 * k} 30 50 30 C${50 + 20 * k} 30 70 ${50 - 20 * k} 70 50 Z`;
    const read = SvgReader.read(page(`<path d="${d}"/>`));
    expect(read.entities).toHaveLength(1);
    expect(read.entities[0].curve).toMatchObject({ kind: 'circle', radius: expect.closeTo(20, 2) });
    expectPoint((read.entities[0].curve as { center: Vec2 }).center, [50, 50], 2);
    expect(read.warnings).toEqual(['4 bezier curves follow a circle and were read as arcs.']);
    const literal = SvgReader.read(page(`<path d="${d}"/>`), { arcs: false });
    expect(literal.entities.map((e) => e.curve.kind)).toEqual(['bspline', 'bspline', 'bspline', 'bspline']);
    expect(literal.warnings).toEqual([]);
  });
});

describe("SvgReader: references and viewports", () => {
  it("draws what a use refers to, moved by its x and y after its own transform", () => {
    const body = `<defs><path id="tick" d="M0 0 L10 0" stroke="black"/></defs>
      <use xlink:href="#tick" x="20" y="30"/><use href="#tick" transform="translate(50 50) rotate(90)" x="5" y="0"/>`;
    const [a, b] = curvesOf(page(body)) as Extract<Curve2D, { kind: 'line' }>[];
    expect(a).toEqual({ kind: 'line', a: { x: 20, y: 70 }, b: { x: 30, y: 70 } });
    const m = mul(mul(translate(50, 50), rotate(90)), translate(5, 0));
    expectPoint(b.a, up(apply(m, [0, 0])));
    expectPoint(b.b, up(apply(m, [10, 0])));
  });

  it("keeps the transform of what is referred to, and follows a use inside a use", () => {
    const body = `<defs><g id="inner" transform="scale(2)"><path d="M0 0 L5 0" stroke="black"/></g>
      <g id="outer"><use href="#inner" x="10"/></g></defs><use href="#outer" y="40"/>`;
    const [line] = curvesOf(page(body)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(line.a, up([10, 40]));
    expectPoint(line.b, up([20, 40]));
  });

  it("fits a symbol's view box into the size the use gives it", () => {
    const body = `<symbol id="s" viewBox="0 0 10 10"><path d="M0 0 L10 10" stroke="black"/></symbol>
      <use href="#s" x="20" y="10" width="40" height="40"/><use href="#s" x="0" y="60" width="40" height="20"/>`;
    const [square, wide] = curvesOf(page(body)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(square.a, up([20, 10]));
    expectPoint(square.b, up([60, 50]));
    // Twice as wide as high: fitted to the height, centred across.
    expectPoint(wide.a, up([10, 60]));
    expectPoint(wide.b, up([30, 80]));
  });

  it("never draws a symbol where it is defined, and gives one without a size the whole viewport", () => {
    const body = `<symbol id="s"><circle cx="50%" cy="50%" r="5"/></symbol><use href="#s" x="10"/>`;
    expect(curvesOf(page(body))).toEqual([{ kind: 'circle', center: { x: 60, y: 50 }, radius: 5 }]);
  });

  it("gives what a use draws the use's own style, not that of where it is defined", () => {
    const body = `<defs><g fill="none"><path id="p" d="M0 0 L10 0 L10 10"/></g></defs><use href="#p"/><g fill="none"><use href="#p" x="20"/></g>`;
    const read = SvgReader.read(page(body));
    // Under the first use the path inherits a fill; under the second it has neither fill nor stroke.
    expect(read.entities).toHaveLength(2);
    expect(read.warnings.join(' ')).toMatch(/1 shape has neither a fill nor a stroke/);
  });

  it("leaves out a reference to nothing, to another file, and to itself, and says so", () => {
    const body = `<use href="#gone"/><use href="other.svg#part"/><g id="loop"><use href="#loop"/><circle r="5"/></g>`;
    const read = SvgReader.read(page(body));
    expect(read.entities).toHaveLength(1);
    const warnings = read.warnings.join(' ');
    expect(warnings).toMatch(/refers to an element it does not define \("#gone"\)/);
    expect(warnings).toMatch(/1 reference points to another file/);
    expect(warnings).toMatch(/A reference leads back to itself/);
  });

  it("refuses a file whose references multiply without end", () => {
    const levels = Array.from({ length: 12 }, (_, i) =>
      `<g id="l${i + 1}">${`<use href="#l${i}"/>`.repeat(10)}</g>`).join('');
    expect(() => SvgReader.read(page(`<defs><path id="l0" d="M0 0 L1 1" stroke="black"/>${levels}</defs><use href="#l12"/>`)))
      .toThrow(/more than 200,000 curves|too many times over/);
  });

  it("places an svg inside the drawing: at x, y, its view box fitted into its size", () => {
    const body = `<svg x="20" y="10" width="60" height="30" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin"><path d="M0 0 L10 10" stroke="black"/></svg>
      <g transform="translate(0 50)"><svg width="50" height="40"><rect width="100%" height="50%"/></svg></g>`;
    const curves = curvesOf(page(body)) as Extract<Curve2D, { kind: 'line' }>[];
    expectPoint(curves[0].a, up([20, 10]));
    expectPoint(curves[0].b, up([50, 40]));
    // Percentages inside are of the inner viewport.
    expectPoint(curves[1].b, up([50, 50]));
    expectPoint(curves[2].b, up([50, 70]));
  });

  it("draws the first child of a switch that asks for no extension", () => {
    const body = `<switch><foreignObject requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/" width="1" height="1"/>
      <g><path d="M0 0 L10 0" stroke="black"/></g><g><path d="M0 0 L20 0" stroke="black"/></g></switch>
      <path requiredExtensions="urn:x" d="M0 0 L30 0" stroke="black"/>`;
    const read = SvgReader.read(page(body));
    expect(read.entities.map((e) => e.curve)).toEqual([{ kind: 'line', a: { x: 0, y: 100 }, b: { x: 10, y: 100 } }]);
    expect(read.skipped).toEqual({});
  });
});

describe("SvgReader: what a style says is drawn", () => {
  it("leaves out what is not displayed, without a word", () => {
    const body = `<path display="none" d="M0 0 L10 0" stroke="black"/><g style="display:none"><circle r="5"/></g>
      <path style="display: inline" d="M0 0 L20 0" stroke="black"/><defs><circle r="9"/></defs><clipPath id="c"><rect width="5" height="5"/></clipPath>
      <mask id="m"><rect width="5" height="5"/></mask><pattern id="p"><rect width="5" height="5"/></pattern><marker id="k"><path d="M0 0 L1 1"/></marker>`;
    const read = SvgReader.read(page(body));
    expect(read.entities).toHaveLength(1);
    expect(read.warnings).toEqual([]);
  });

  it("leaves out a shape with neither fill nor stroke, and counts it", () => {
    // The bounding square icons carry, and a line (never filled) without a stroke.
    const body = `<path d="M0 0h24v24H0z" fill="none"/><path d="M5 5 L10 10 L5 10 Z"/><line x2="10" y2="10"/>
      <rect width="5" height="5" fill="none" stroke="black" stroke-width="0"/><circle r="3" fill="none" stroke="#000"/>
      <circle r="4" opacity="0"/><circle r="6" fill="#ff000000"/><circle r="7" fill="rgba(0, 0, 0, 0)"/><circle r="8" fill-opacity="0"/>
      <g visibility="hidden"><circle r="9"/><circle r="10" visibility="visible"/></g>`;
    const read = SvgReader.read(page(body));
    expect(read.entities.map((e) => e.curve.kind)).toEqual(['line', 'line', 'line', 'circle', 'circle']);
    expect((read.entities[4].curve as { radius: number }).radius).toBe(10);
    expect(read.warnings).toEqual(['8 shapes have neither a fill nor a stroke, or are made invisible: they were left out.']);
    // Asked for, they come in too.
    expect(SvgReader.read(page(body), { unpainted: true }).entities).toHaveLength(19);
  });

  it("imports a file in which nothing is painted all the same", () => {
    const read = SvgReader.read(page('<g fill="none"><circle r="5"/><path d="M0 0 L10 0"/></g>'));
    expect(read.entities).toHaveLength(2);
    expect(read.warnings).toEqual(['Nothing in the file is drawn with a fill or a stroke: its shapes were imported all the same.']);
  });

  it("applies style sheets: classes, ids, element names, the cascade", () => {
    const body = `<style>
        .st0 { fill: none; stroke: #000; }
        .st1{fill:none}
        .gone, #also-gone { display: none }
        circle.st1 { stroke: red }
        g.turned > path { transform: translate(10px, 0) }
        .st1.loud { stroke: blue !important }
        @media print { .st0 { display: none } }
        @media screen { .screen { display: none } }
        @font-face { font-family: x; src: url(x.woff) }
      </style>
      <path class="st0" d="M0 0 L10 0"/><path class="st1" d="M0 10 L10 10"/><circle class="st1" r="3"/>
      <path class="st0 gone" d="M0 20 L10 20"/><path id="also-gone" stroke="black" d="M0 30 L10 30"/>
      <g class="turned"><path class="st0" d="M0 40 L10 40"/><g><path class="st0" d="M0 50 L10 50"/></g></g>
      <path class="st1 loud" style="stroke: none" d="M0 60 L10 60"/><path class="st0 screen" d="M0 70 L10 70"/>
      <path class="st0" style="display:none" d="M0 80 L10 80"/>`;
    const read = SvgReader.read(page(body));
    const starts = read.entities.map((e) => e.curve.kind === 'line' ? [e.curve.a.x, 100 - e.curve.a.y] : 'circle');
    expect(starts).toEqual([[0, 0], 'circle', [10, 40], [0, 50], [0, 60]]);
    expect(read.warnings).toEqual(['1 shape has neither a fill nor a stroke, or is made invisible: it was left out.']);
  });

  it("lets a style sheet set a shape's geometry", () => {
    const body = `<style>.wide { width: 40px; height: 10px } #c { r: 7px; cx: 50px } .p { d: path("M0 0 L5 0") }</style>
      <rect class="wide" x="10" y="10" width="1" height="1"/><circle id="c" cy="50" r="1"/><path class="p" d="M0 0 L99 0" stroke="black"/>`;
    const curves = curvesOf(page(body));
    expect(curves[1]).toEqual({ kind: 'line', a: { x: 50, y: 90 }, b: { x: 50, y: 80 } });
    expect(curves[4]).toEqual({ kind: 'circle', center: { x: 50, y: 50 }, radius: 7 });
    expect(curves[5]).toEqual({ kind: 'line', a: { x: 0, y: 100 }, b: { x: 5, y: 100 } });
  });

  it("imports what is clipped or masked whole, and says so", () => {
    const body = `<clipPath id="c"><rect width="10" height="10"/></clipPath><g clip-path="url(#c)"><circle r="20"/><circle r="30"/></g>
      <circle r="5" mask="url(#m)"/><circle r="6" clip-path="none"/>`;
    const read = SvgReader.read(page(body));
    expect(read.entities).toHaveLength(4);
    expect(read.warnings).toEqual(['3 shapes are clipped or masked in the file: they were imported whole.']);
  });

  it("counts what is not a curve", () => {
    const body = `<text x="5" y="5">hello</text><text>again<tspan>!</tspan></text><image href="a.png" width="5" height="5"/>
      <foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
      <text display="none">unseen</text><circle r="5"/>`;
    const read = SvgReader.read(page(body));
    expect(read.entities).toHaveLength(1);
    expect(read.skipped).toEqual({ text: 2, image: 1, 'embedded object': 1 });
  });
});

describe("SvgReader: layers", () => {
  const line = (y: number) => `<path d="M0 ${y} L10 ${y}" stroke="black"/>`;

  it("reads Inkscape's layers by their labels, the innermost counting, a switched-off one marked", () => {
    const body = `<g inkscape:groupmode="layer" inkscape:label="Outline" id="layer1">${line(1)}
        <g id="group">${line(2)}</g>
        <g inkscape:groupmode="layer" inkscape:label="Holes" id="layer3">${line(3)}</g></g>
      <g inkscape:groupmode="layer" inkscape:label="Notes" id="layer2" style="display:none">${line(4)}${line(5)}</g>
      <g id="plain">${line(6)}</g>${line(7)}`;
    const read = SvgReader.read(page(body));
    expect(read.layers).toEqual([
      { name: 'Outline', count: 2, hidden: false },
      { name: 'Holes', count: 1, hidden: false },
      { name: 'Notes', count: 2, hidden: true },
      { name: '(no layer)', count: 2, hidden: false },
    ]);
    expect(read.entities.map((e) => e.layer)).toEqual(['Outline', 'Outline', 'Holes', 'Notes', 'Notes', '(no layer)', '(no layer)']);
  });

  it("reads another program's named top groups as its layers", () => {
    const body = `<g id="Layer_1" data-name="Cut lines">${line(1)}<g id="inner">${line(2)}</g></g>
      <g id="Engrave_x5F_marks">${line(3)}</g><g>${line(4)}<g id="deep">${line(5)}</g></g>
      <g id="Off" display="none">${line(6)}</g>${line(7)}`;
    const read = SvgReader.read(page(body));
    expect(read.layers).toEqual([
      { name: 'Cut lines', count: 2, hidden: false },
      { name: 'Engrave_marks', count: 1, hidden: false },
      { name: '(no layer)', count: 2, hidden: false },
      { name: 'deep', count: 1, hidden: false },
      { name: 'Off', count: 1, hidden: true },
    ]);
  });

  it("has one layer for a file without any", () => {
    expect(SvgReader.read(page(line(1) + line(2))).layers).toEqual([{ name: '(no layer)', count: 2, hidden: false }]);
  });
});

describe("SvgReader: files as they come", () => {
  it("reads an Illustrator file: entities for its namespaces and styles, a switch, layers by id", () => {
    const text = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 16.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
	<!ENTITY ns_svg "http://www.w3.org/2000/svg">
	<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
	<!ENTITY st0 "fill:none;stroke:#000000;stroke-miterlimit:10;">
]>
<svg version="1.1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" x="0px" y="0px" width="200px" height="100px" viewBox="0 0 200 100" xml:space="preserve">
<switch><foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1"><i:pgfRef xlink:href="#adobe_illustrator_pgf"/></foreignObject>
<g i:extraneous="self"><g id="Layer_1"><rect x="10" y="10" style="&st0;" width="80" height="50"/></g><g id="Holes"><circle style="&st0;" cx="150" cy="50" r="30"/></g></g></switch></svg>`;
    const read = SvgReader.read(text);
    expect(read.layers).toEqual([{ name: 'Layer_1', count: 4, hidden: false }, { name: 'Holes', count: 1, hidden: false }]);
    expect(read.entities[4].curve).toEqual({ kind: 'circle', center: { x: 150, y: 50 }, radius: 30 });
    expect(read.unit?.name).toBe('pt');
    expect(read.skipped).toEqual({});
  });

  it("reads a file that never declares SVG's namespace, or uses a prefix for it", () => {
    expect(curvesOf('<svg width="10" height="10"><circle cx="5" cy="5" r="2"/></svg>')).toEqual([{ kind: 'circle', center: { x: 5, y: 5 }, radius: 2 }]);
    expect(curvesOf('<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:circle cx="5" cy="5" r="2"/><other xmlns="urn:x"><s:circle r="1"/></other></s:svg>'))
      .toEqual([{ kind: 'circle', center: { x: 5, y: 5 }, radius: 2 }]);
  });

  it("reads a file's bytes: UTF-8, UTF-16 by its mark, another encoding by its declaration", () => {
    const text = `<?xml version="1.0"?><svg ${NS} width="10" height="10"><g id="Tracé"><circle cx="5" cy="5" r="2"/></g><g id="b"><circle r="1"/></g></svg>`;
    const layerOf = (bytes: Uint8Array) => SvgReader.readBytes(bytes).layers[0].name;
    expect(layerOf(new TextEncoder().encode(text))).toBe('Tracé');
    expect(layerOf(new TextEncoder().encode(`﻿${text}`))).toBe('Tracé');
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    [...text].forEach((c, i) => { utf16[2 + i * 2] = c.charCodeAt(0) & 0xff; utf16[3 + i * 2] = c.charCodeAt(0) >> 8; });
    expect(layerOf(utf16)).toBe('Tracé');
    const latin = Uint8Array.from([...text.replace('<?xml version="1.0"?>', '<?xml version="1.0" encoding="ISO-8859-1"?>')].map((c) => c.charCodeAt(0)));
    expect(layerOf(latin)).toBe('Tracé');
  });

  it("refuses what is not an SVG, saying what it is", () => {
    expect(() => SvgReader.read("0\nSECTION\n2\nENTITIES\n0\nEOF\n")).toThrow(/not an SVG file: it does not start with an XML element/);
    expect(() => SvgReader.read("")).toThrow(/not an SVG file/);
    expect(() => SvgReader.read("<html><body><svg/></body></html>")).toThrow(/not an SVG file: its outermost element is <html>/);
    expect(() => SvgReader.read('<svg xmlns="urn:not-svg"/>')).toThrow(/not an SVG file/);
    expect(() => SvgReader.read(`<svg ${NS}><g></svg>`)).toThrow(/not well-formed XML: <\/svg> closes <g>/);
    expect(() => SvgReader.readBytes(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).toThrow(/compressed SVG \(\.svgz\)/);
  });

  it("reads an empty drawing as no curves", () => {
    const read: ImportedDrawing = SvgReader.read(`<svg ${NS} width="10" height="10"/>`);
    expect(read.entities).toEqual([]);
    expect(read.layers).toEqual([]);
    expect(read.warnings).toEqual([]);
  });
});
