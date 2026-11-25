import { describe, it, expect } from "vitest";
import { DxfReader } from "../../../io/drawing/dxf-reader.js";
import { DxfWriter } from "../../../io/drawing/dxf-writer.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Drawing2D, DrawingEntity, Vec2 } from "../../../io/drawing/drawing.js";
import type { ImportedDrawing } from "../../../io/drawing/import.js";
import { DxfOracle } from "./dxf-oracle.js";

type Groups = (string | number)[];

/** Group codes and values, flat, as the lines of a file. */
function lines(groups: Groups): string {
  return groups.map(String).join("\n");
}

/** A file with the given header variables, tables, blocks and entities — each a flat run of group codes. */
function dxf(parts: { header?: Groups; tables?: Groups; blocks?: Groups; entities?: Groups }, eol = "\n"): string {
  const section = (name: string, groups: Groups | undefined): Groups =>
    groups ? [0, "SECTION", 2, name, ...groups, 0, "ENDSEC"] : [];
  return lines([
    ...section("HEADER", parts.header),
    ...section("TABLES", parts.tables),
    ...section("BLOCKS", parts.blocks),
    ...section("ENTITIES", parts.entities ?? []),
    0, "EOF",
  ]).split("\n").join(eol) + eol;
}

function curvesOf(text: string): Curve2D[] {
  return DxfReader.read(text).entities.map((e) => e.curve);
}

function expectPoint(actual: Vec2, expected: [number, number], digits = 9): void {
  expect(actual.x).toBeCloseTo(expected[0], digits);
  expect(actual.y).toBeCloseTo(expected[1], digits);
}

/** The curve passes through `points`, in order from its start to its end. */
function expectThrough(curve: Curve2D, points: [number, number][]): void {
  const sampled = Curves.sample(curve, points.length - 1);
  points.forEach((p, i) => expectPoint(sampled[i], p, 7));
}

describe("DxfReader: what DxfWriter wrote", () => {
  const curves: Curve2D[] = [
    { kind: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 12.5 } },
    { kind: 'circle', center: { x: 20, y: 15 }, radius: 5 },
    { kind: 'arc', center: { x: -3, y: 4 }, radius: 7.25, start: 0.4, end: 2.9 },
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
      kind: 'bspline',
      degree: 2,
      knots: [0, 0, 0, 1, 1, 1],
      poles: [{ x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      weights: [1, Math.SQRT1_2, 1],
    },
  ];
  const entities: DrawingEntity[] = curves.map((curve, i) => ({ layer: (['visible', 'tangent', 'hidden'] as const)[i % 3], curve }));
  const drawing: Drawing2D = { unit: 'in', entities, bounds: Curves.boundsOf(entities), warnings: [] };
  const text = DxfWriter.write(drawing);
  const read = DxfReader.read(text);

  it("reads every curve back where the drawing put it", () => {
    expect(read.entities).toHaveLength(curves.length);
    curves.forEach((curve, i) => {
      const expected = Curves.sample(curve, 24);
      const actual = Curves.sample(read.entities[i].curve, 24);
      // A full ellipse may start anywhere: compare it as a set of points on the curve.
      if (curve.kind === 'ellipse' && curve.end - curve.start >= 2 * Math.PI - 1e-9) {
        expect(read.entities[i].curve.kind).toBe('ellipse');
        expect(Curves.bounds(read.entities[i].curve).min.x).toBeCloseTo(Curves.bounds(curve).min.x, 6);
        expect(Curves.bounds(read.entities[i].curve).max.y).toBeCloseTo(Curves.bounds(curve).max.y, 6);
        return;
      }
      expected.forEach((p, k) => expectPoint(actual[k], [p.x, p.y], 6));
    });
  });

  it("keeps the kinds", () => {
    expect(read.entities.map((e) => e.curve.kind)).toEqual(curves.map((c) => c.kind));
  });

  it("reads the unit and the layers", () => {
    expect(read.unit).toEqual({ name: 'in', mm: 25.4 });
    expect(read.layers).toEqual([
      { name: 'VISIBLE', count: 3, hidden: false },
      { name: 'TANGENT', count: 3, hidden: false },
      { name: 'HIDDEN', count: 2, hidden: false },
    ]);
    expect(read.skipped).toEqual({});
    expect(read.warnings).toEqual([]);
  });

  it("agrees with the format's definition of each entity", () => {
    const objects = DxfOracle.section(DxfOracle.parse(text), 'ENTITIES').objects;
    objects.forEach((object, i) => {
      if (object.type === 'ELLIPSE' && curves[i].kind === 'ellipse' && (curves[i] as { end: number }).end >= 2 * Math.PI) {
        return;
      }
      const expected = DxfOracle.sample(object, 16);
      const actual = Curves.sample(read.entities[i].curve, 16);
      expected.forEach((p, k) => expectPoint(actual[k], [p.x, p.y], 6));
    });
  });
});

describe("DxfReader: files as they come", () => {
  it("reads a bare R12 file: ENTITIES only, CRLF, no EOF, lower-case names", () => {
    const text = "  0\r\nSECTION\r\n  2\r\nENTITIES\r\n  0\r\nLINE\r\n  8\r\nouter\r\n 10\r\n1.5\r\n 20\r\n2.0\r\n 11\r\n10.0\r\n 21\r\n-3.0\r\n  0\r\nENDSEC\r\n";
    const read = DxfReader.read(text);
    expect(read.entities).toEqual([{ layer: 'outer', curve: { kind: 'line', a: { x: 1.5, y: 2 }, b: { x: 10, y: -3 } } }]);
    expect(read.unit).toBeNull();
    expect(read.layers).toEqual([{ name: 'outer', count: 1, hidden: false }]);
  });

  it("reads a file that starts with a byte-order mark and ends in blank lines", () => {
    const read = DxfReader.read("﻿" + dxf({ entities: [0, "CIRCLE", 8, "0", 10, 3, 20, 4, 40, 2.5] }) + "\n\n  \n");
    expect(read.entities[0].curve).toEqual({ kind: 'circle', center: { x: 3, y: 4 }, radius: 2.5 });
  });

  it("takes arcs in degrees, counter-clockwise, across the zero angle", () => {
    const [arc] = curvesOf(dxf({ entities: [0, "ARC", 8, "0", 10, 0, 20, 0, 40, 10, 50, 350, 51, 10] }));
    expect(arc.kind).toBe('arc');
    expectThrough(arc, [
      [10 * Math.cos(-10 * Math.PI / 180), 10 * Math.sin(-10 * Math.PI / 180)],
      [10, 0],
      [10 * Math.cos(10 * Math.PI / 180), 10 * Math.sin(10 * Math.PI / 180)],
    ]);
  });

  it("reads an arc whose two angles are equal as the whole circle", () => {
    const [arc] = curvesOf(dxf({ entities: [0, "ARC", 8, "0", 10, 0, 20, 0, 40, 10, 50, 0, 51, 360] }));
    expect(arc.kind).toBe('arc');
    expect((arc as { end: number }).end - (arc as { start: number }).start).toBeCloseTo(2 * Math.PI, 12);
  });

  it("mirrors what is drawn on a flipped plane (extrusion −Z), arcs keeping their extent", () => {
    // In its own plane: a quarter arc from (15, 0) up to (10, 5). Seen from +Z the plane's X runs the other way.
    const [arc, circle] = curvesOf(dxf({
      entities: [
        0, "ARC", 8, "0", 10, 10, 20, 0, 40, 5, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1,
        0, "CIRCLE", 8, "0", 10, 10, 20, 2, 40, 1, 210, 0, 220, 0, 230, -1,
      ],
    }));
    expect(arc.kind).toBe('arc');
    expectThrough(arc, [[-10, 5], [-10 - 5 * Math.SQRT1_2, 5 * Math.SQRT1_2], [-15, 0]]);
    expect(circle).toEqual({ kind: 'circle', center: { x: -10, y: 2 }, radius: 1 });
  });

  it("projects what is drawn on a tilted plane, and says so", () => {
    // A circle standing on the XZ plane (extrusion along Y) is a segment from above.
    const read = DxfReader.read(dxf({ entities: [0, "CIRCLE", 8, "0", 10, 0, 20, 0, 40, 5, 210, 0, 220, 1, 230, 0] }));
    expect(read.entities).toHaveLength(1);
    const line = read.entities[0].curve;
    expect(line.kind).toBe('line');
    const xs = [(line as { a: Vec2 }).a.x, (line as { b: Vec2 }).b.x].sort((p, q) => p - q);
    expect(xs[0]).toBeCloseTo(-5, 9);
    expect(xs[1]).toBeCloseTo(5, 9);
    expect(read.warnings.join(' ')).toMatch(/1 entity is not drawn on the XY plane/);
  });

  it("reads an ellipse's axes, ratio and parameters, and a flipped one the other way round", () => {
    const [full, part, flipped] = curvesOf(dxf({
      entities: [
        0, "ELLIPSE", 8, "0", 10, 1, 20, 2, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, 2 * Math.PI,
        0, "ELLIPSE", 8, "0", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, Math.PI / 2,
        0, "ELLIPSE", 8, "0", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, Math.PI / 2, 210, 0, 220, 0, 230, -1,
      ],
    }));
    expect(full).toMatchObject({ kind: 'ellipse', center: { x: 1, y: 2 }, ratio: 0.5 });
    expect(Curves.bounds(full)).toMatchObject({ min: { x: -9, y: -3 }, max: { x: 11, y: 7 } });
    expectThrough(part, [[10, 0], [0, 5]]);
    // The minor axis is extrusion × major: from (10, 0) the flipped one runs down to (0, −5); stored counter-clockwise, it starts there.
    expectThrough(flipped, [[0, -5], [10, 0]]);
  });

  it("turns a light polyline into lines and bulge arcs: a slot", () => {
    // Two semicircles of radius 5 joined by two lines, counter-clockwise from (0, 0).
    const curves = curvesOf(dxf({
      entities: [0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1,
        10, 0, 20, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 10, 0, 20, 10, 42, 1],
    }));
    expect(curves.map((c) => c.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    expect(curves[0]).toEqual({ kind: 'line', a: { x: 0, y: 0 }, b: { x: 20, y: 0 } });
    expect(curves[1]).toMatchObject({ kind: 'arc', center: { x: 20, y: 5 }, radius: 5 });
    expectThrough(curves[1], [[20, 0], [25, 5], [20, 10]]);
    expect(curves[2]).toEqual({ kind: 'line', a: { x: 20, y: 10 }, b: { x: 0, y: 10 } });
    expectThrough(curves[3], [[0, 10], [-5, 5], [0, 0]]);
  });

  it("reads a negative bulge as the arc that turns clockwise", () => {
    // From (0, 0) to (10, 0) bulging upward: clockwise, a quarter of the angle's tangent negated.
    const bulge = -Math.tan(Math.PI / 8);
    const [arc] = curvesOf(dxf({ entities: [0, "LWPOLYLINE", 8, "0", 90, 2, 70, 0, 10, 0, 20, 0, 42, bulge, 10, 10, 20, 0] }));
    expect(arc.kind).toBe('arc');
    // A quarter turn over the chord: radius 10/√2, centre below it.
    expect(arc).toMatchObject({ radius: expect.closeTo(10 / Math.SQRT2, 9) });
    expectPoint((arc as { center: Vec2 }).center, [5, -5]);
    // Stored counter-clockwise, so from the far end back to the first vertex, over the top.
    expectThrough(arc, [[10, 0], [5, 10 / Math.SQRT2 - 5], [0, 0]]);
  });

  it("reads an old-style polyline with its vertices, and skips a mesh", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "POLYLINE", 8, "P", 66, 1, 70, 1,
        0, "VERTEX", 8, "P", 10, 0, 20, 0,
        0, "VERTEX", 8, "P", 10, 4, 20, 0,
        0, "VERTEX", 8, "P", 10, 4, 20, 3,
        0, "SEQEND",
        0, "POLYLINE", 8, "P", 66, 1, 70, 64,
        0, "VERTEX", 8, "P", 10, 0, 20, 0,
        0, "SEQEND",
        0, "LINE", 8, "P", 10, 9, 20, 9, 11, 8, 21, 8,
      ],
    }));
    expect(read.entities.map((e) => e.curve)).toEqual([
      { kind: 'line', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
      { kind: 'line', a: { x: 4, y: 0 }, b: { x: 4, y: 3 } },
      { kind: 'line', a: { x: 4, y: 3 }, b: { x: 0, y: 0 } },
      { kind: 'line', a: { x: 9, y: 9 }, b: { x: 8, y: 8 } },
    ]);
    expect(read.skipped).toEqual({ 'POLYLINE (mesh)': 1 });
  });

  it("reads a spline's control points, knots and weights", () => {
    const [curve] = curvesOf(dxf({
      entities: [0, "SPLINE", 8, "0", 70, 12, 71, 2, 72, 6, 73, 3, 74, 0,
        40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1,
        41, 1, 41, Math.SQRT1_2, 41, 1,
        10, 10, 20, 0, 30, 0, 10, 10, 20, 10, 30, 0, 10, 0, 20, 10, 30, 0],
    }));
    expect(curve.kind).toBe('bspline');
    // A quarter circle of radius 10: every point is 10 from the origin.
    for (const p of Curves.sample(curve, 12)) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(10, 9);
    }
  });

  it("drops weights that are all one", () => {
    const [curve] = curvesOf(dxf({
      entities: [0, "SPLINE", 8, "0", 71, 1, 40, 0, 40, 0, 40, 1, 40, 1, 41, 1, 41, 1, 10, 0, 20, 0, 10, 5, 20, 5],
    }));
    expect(curve).toEqual({ kind: 'bspline', degree: 1, knots: [0, 0, 1, 1], poles: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
  });

  it("clamps a periodic spline: the same closed curve, starting and ending on its poles", () => {
    // A closed uniform cubic through a square's corners, wrapped the way a periodic spline is written.
    const poles: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [10, 0], [10, 10]];
    const knots = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];
    const groups: Groups = [0, "SPLINE", 8, "0", 70, 11, 71, 3];
    knots.forEach((k) => groups.push(40, k));
    poles.forEach(([x, y]) => groups.push(10, x, 20, y));
    const text = dxf({ entities: groups });
    const [curve] = curvesOf(text);
    expect(curve.kind).toBe('bspline');
    const [start, end] = Curves.endpoints(curve)!;
    expectPoint(start, [end.x, end.y]);
    expectPoint((curve as { poles: Vec2[] }).poles[0], [start.x, start.y]);
    const object = DxfOracle.section(DxfOracle.parse(text.split("\n").join("\r\n")), 'ENTITIES').objects[0];
    const expected = DxfOracle.sample(object, 40);
    const actual = Curves.sample(curve, 40);
    // The clamped curve keeps the knot spans, so equal steps in the parameter are the same points.
    expected.forEach((p, k) => expectPoint(actual[k], [p.x, p.y], 7));
  });

  it("draws a spline that has only fit points through them", () => {
    const fit: [number, number][] = [[0, 0], [5, 4], [10, 0], [15, -4], [20, 0]];
    const groups: Groups = [0, "SPLINE", 8, "0", 70, 8, 71, 3, 74, fit.length];
    fit.forEach(([x, y]) => groups.push(11, x, 21, y));
    const read = DxfReader.read(dxf({ entities: groups }));
    const [curve] = read.entities.map((e) => e.curve);
    expect(curve.kind).toBe('bspline');
    const dense = Curves.sample(curve, 2000);
    for (const [x, y] of fit) {
      const nearest = Math.min(...dense.map((p) => Math.hypot(p.x - x, p.y - y)));
      expect(nearest).toBeLessThan(0.02);
    }
    expect(read.warnings).toEqual([]);
  });

  it("assumes even knots for a spline that comes without them, and leaves out one with nothing", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "SPLINE", 8, "0", 71, 2, 10, 0, 20, 0, 10, 5, 20, 5, 10, 10, 20, 0,
        0, "SPLINE", 8, "0", 71, 3,
      ],
    }));
    expect(read.entities).toHaveLength(1);
    expectThrough(read.entities[0].curve, [[0, 0], [5, 2.5], [10, 0]]);
    expect(read.warnings.join(' ')).toMatch(/1 spline comes without usable knots/);
    expect(read.warnings.join(' ')).toMatch(/1 spline has neither control points nor fit points/);
  });
});

describe("DxfReader: blocks", () => {
  const block = (name: string, groups: Groups, base: [number, number] = [0, 0]): Groups =>
    [0, "BLOCK", 8, "0", 2, name, 70, 0, 10, base[0], 20, base[1], ...groups, 0, "ENDBLK"];

  it("places a block where it is inserted: moved, turned, scaled", () => {
    const [line] = curvesOf(dxf({
      blocks: block("TICK", [0, "LINE", 8, "0", 10, 1, 20, 0, 11, 3, 21, 0], [1, 0]),
      entities: [0, "INSERT", 8, "MARKS", 2, "TICK", 10, 10, 20, 20, 41, 2, 42, 2, 50, 90],
    }));
    // From the block's base point: 2 units along X, doubled, turned a quarter turn.
    expect(line.kind).toBe('line');
    expectPoint((line as { a: Vec2 }).a, [10, 20]);
    expectPoint((line as { b: Vec2 }).b, [10, 24]);
  });

  it("puts a block's layer-0 entities on the layer of the reference, and keeps the others", () => {
    const read = DxfReader.read(dxf({
      blocks: block("B", [
        0, "LINE", 8, "0", 10, 0, 20, 0, 11, 1, 21, 0,
        0, "LINE", 8, "OWN", 10, 0, 20, 1, 11, 1, 21, 1,
      ]),
      entities: [0, "INSERT", 8, "PLACED", 2, "b", 10, 0, 20, 0],
    }));
    expect(read.entities.map((e) => e.layer)).toEqual(['PLACED', 'OWN']);
  });

  it("mirrors with a negative scale, an arc keeping its extent", () => {
    const [arc] = curvesOf(dxf({
      blocks: block("A", [0, "ARC", 8, "0", 10, 0, 20, 0, 40, 5, 50, 0, 51, 90]),
      entities: [0, "INSERT", 8, "0", 2, "A", 10, 0, 20, 0, 41, -1, 42, 1],
    }));
    expect(arc.kind).toBe('arc');
    expectThrough(arc, [[0, 5], [-5 * Math.SQRT1_2, 5 * Math.SQRT1_2], [-5, 0]]);
  });

  it("turns a circle into an ellipse under unequal scales", () => {
    const [ellipse] = curvesOf(dxf({
      blocks: block("C", [0, "CIRCLE", 8, "0", 10, 0, 20, 0, 40, 1]),
      entities: [0, "INSERT", 8, "0", 2, "C", 10, 5, 20, 5, 41, 4, 42, 2],
    }));
    expect(ellipse).toMatchObject({ kind: 'ellipse', center: { x: 5, y: 5 }, ratio: expect.closeTo(0.5, 12) });
    expect(Curves.bounds(ellipse)).toMatchObject({
      min: { x: expect.closeTo(1, 9), y: expect.closeTo(3, 9) },
      max: { x: expect.closeTo(9, 9), y: expect.closeTo(7, 9) },
    });
  });

  it("repeats an arrayed reference in rows and columns", () => {
    const curves = curvesOf(dxf({
      blocks: block("DOT", [0, "CIRCLE", 8, "0", 10, 0, 20, 0, 40, 1]),
      entities: [0, "INSERT", 8, "0", 2, "DOT", 10, 0, 20, 0, 70, 3, 71, 2, 44, 10, 45, 20],
    }));
    expect(curves.map((c) => (c as { center: Vec2 }).center)).toEqual([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 },
      { x: 0, y: 20 }, { x: 10, y: 20 }, { x: 20, y: 20 },
    ]);
  });

  it("follows a block inside a block, skips a reference's attributes, and stops at a block that refers to itself", () => {
    const read = DxfReader.read(dxf({
      blocks: [
        ...block("INNER", [0, "LINE", 8, "0", 10, 0, 20, 0, 11, 1, 21, 0]),
        ...block("OUTER", [0, "INSERT", 8, "0", 2, "INNER", 10, 5, 20, 0]),
        ...block("LOOP", [0, "INSERT", 8, "0", 2, "LOOP", 10, 1, 20, 0]),
      ],
      entities: [
        0, "INSERT", 8, "0", 66, 1, 2, "OUTER", 10, 0, 20, 10,
        0, "ATTRIB", 8, "0", 10, 0, 20, 0, 1, "label",
        0, "SEQEND",
        0, "INSERT", 8, "0", 2, "LOOP", 10, 0, 20, 0,
        0, "INSERT", 8, "0", 2, "GONE", 10, 0, 20, 0,
      ],
    }));
    expect(read.entities.map((e) => e.curve)).toEqual([{ kind: 'line', a: { x: 5, y: 10 }, b: { x: 6, y: 10 } }]);
    expect(read.skipped).toEqual({});
    expect(read.warnings.join(' ')).toMatch(/refers to a block it does not define \("GONE"\)/);
    expect(read.warnings.join(' ')).toMatch(/A block refers to itself/);
  });
});

describe("DxfReader: points", () => {
  const block = (name: string, groups: Groups, base: [number, number] = [0, 0]): Groups =>
    [0, "BLOCK", 8, "0", 2, name, 70, 0, 10, base[0], 20, base[1], ...groups, 0, "ENDBLK"];

  it("reads a POINT as a point on its layer, apart from the curves and not left out", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "LINE", 8, "OUTLINE", 10, 0, 20, 0, 11, 40, 21, 0,
        0, "POINT", 8, "DRILL", 10, 12.5, 20, 7.25,
        0, "POINT", 8, "DRILL", 10, 27.5, 20, 7.25, 30, 3,
      ],
    }));
    expect(read.entities).toHaveLength(1);
    expect(read.points).toEqual([
      { layer: 'DRILL', at: { x: 12.5, y: 7.25 } },
      // A point above the plane is seen from above, like everything else.
      { layer: 'DRILL', at: { x: 27.5, y: 7.25 } },
    ]);
    expect(read.skipped).toEqual({});
    expect(read.warnings).toEqual([]);
  });

  it("lists a layer that holds only points, and counts points with the curves", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "POINT", 8, "MARKS", 10, 1, 20, 1,
        0, "LINE", 8, "BOTH", 10, 0, 20, 0, 11, 1, 21, 1,
        0, "POINT", 8, "BOTH", 10, 1, 20, 1,
      ],
    }));
    expect(read.layers).toEqual([
      { name: 'MARKS', count: 1, hidden: false },
      { name: 'BOTH', count: 2, hidden: false },
    ]);
  });

  it("places a block's points where the block is inserted: moved, turned, scaled, arrayed, on the reference's layer", () => {
    const read = DxfReader.read(dxf({
      blocks: block("MARK", [0, "POINT", 8, "0", 10, 2, 20, 0], [1, 0]),
      entities: [
        0, "INSERT", 8, "HOLES", 2, "MARK", 10, 10, 20, 20, 41, 2, 42, 2, 50, 90,
        0, "INSERT", 8, "ROW", 2, "MARK", 10, 0, 20, 0, 70, 3, 44, 10,
      ],
    }));
    expect(read.points.map((p) => p.layer)).toEqual(['HOLES', 'ROW', 'ROW', 'ROW']);
    // One unit along X from the block's base point: doubled, turned a quarter turn.
    expectPoint(read.points[0].at, [10, 22]);
    expectPoint(read.points[1].at, [1, 0]);
    expectPoint(read.points[2].at, [11, 0]);
    expectPoint(read.points[3].at, [21, 0]);
  });

  it("leaves out a point in paper space and one made invisible", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "POINT", 8, "0", 67, 1, 10, 1, 20, 1,
        0, "POINT", 8, "0", 60, 1, 10, 2, 20, 2,
        0, "POINT", 8, "0", 10, 3, 20, 3,
      ],
    }));
    expect(read.points).toEqual([{ layer: '0', at: { x: 3, y: 3 } }]);
  });

  it("reads a file of nothing but points", () => {
    const read = DxfReader.read(dxf({ entities: [0, "POINT", 8, "0", 10, -4, 20, 9] }));
    expect(read.entities).toEqual([]);
    expect(read.points).toEqual([{ layer: '0', at: { x: -4, y: 9 } }]);
    expect(read.layers).toEqual([{ name: '0', count: 1, hidden: false }]);
  });
});

describe("DxfReader: construction lines", () => {
  const block = (name: string, groups: Groups, base: [number, number] = [0, 0]): Groups =>
    [0, "BLOCK", 8, "0", 2, name, 70, 0, 10, base[0], 20, base[1], ...groups, 0, "ENDBLK"];

  it("reads an XLINE and a RAY as construction lines on their layer, apart from the curves and not left out", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "LINE", 8, "OUTLINE", 10, 0, 20, 0, 11, 40, 21, 0,
        0, "XLINE", 8, "LAYOUT", 10, 20, 20, 5, 30, 0, 11, 0, 21, 1, 31, 0,
        0, "RAY", 8, "LAYOUT", 10, 0, 20, 0, 30, 0, 11, 0.6, 21, 0.8, 31, 0,
      ],
    }));
    expect(read.entities).toHaveLength(1);
    expect(read.constructionLines).toEqual([
      { layer: 'LAYOUT', at: { x: 20, y: 5 }, direction: { x: 0, y: 1 }, ray: false },
      { layer: 'LAYOUT', at: { x: 0, y: 0 }, direction: { x: 0.6, y: 0.8 }, ray: true },
    ]);
    expect(read.skipped).toEqual({});
    expect(read.warnings).toEqual([]);
    expect(read.layers).toEqual([
      { name: 'OUTLINE', count: 1, hidden: false },
      { name: 'LAYOUT', count: 2, hidden: false },
    ]);
  });

  it("gives a direction of any length as one unit long", () => {
    const [line] = DxfReader.read(dxf({ entities: [0, "XLINE", 8, "0", 10, 1, 20, 2, 11, 30, 21, -40] })).constructionLines;
    expectPoint(line.direction, [0.6, -0.8]);
  });

  it("sees a line that climbs off the plane from above, and leaves out one that runs straight up", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "XLINE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 0.6, 21, 0, 31, 0.8,
        0, "XLINE", 8, "0", 10, 5, 20, 5, 30, 0, 11, 0, 21, 0, 31, 1,
        0, "RAY", 8, "0", 10, 5, 20, 5, 11, 0, 21, 0,
      ],
    }));
    expect(read.constructionLines).toEqual([{ layer: '0', at: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, ray: false }]);
  });

  it("takes a block's construction lines through its reference: turned, stretched, mirrored, on the reference's layer", () => {
    const read = DxfReader.read(dxf({
      blocks: block("AXES", [
        0, "XLINE", 8, "0", 10, 1, 20, 0, 11, 1, 21, 0,
        0, "RAY", 8, "CENTRES", 10, 1, 20, 0, 11, 0.6, 21, 0.8,
      ], [1, 0]),
      entities: [
        0, "INSERT", 8, "LAYOUT", 2, "AXES", 10, 10, 20, 20, 50, 90,
        0, "INSERT", 8, "LAYOUT", 2, "AXES", 10, 0, 20, 0, 41, -2, 42, 0.5,
      ],
    }));
    expect(read.constructionLines.map((line) => line.layer)).toEqual(['LAYOUT', 'CENTRES', 'LAYOUT', 'CENTRES']);
    const [turned, turnedRay, stretched, stretchedRay] = read.constructionLines;
    // A quarter turn: along X becomes along Y, through the insertion point.
    expectPoint(turned.at, [10, 20]);
    expectPoint(turned.direction, [0, 1]);
    expectPoint(turnedRay.direction, [-0.8, 0.6]);
    expect(turnedRay.ray).toBe(true);
    // Mirrored in X and doubled, halved in Y: the direction is the stretched one, one unit long again.
    expectPoint(stretched.direction, [-1, 0]);
    const length = Math.hypot(-1.2, 0.4);
    expectPoint(stretchedRay.direction, [-1.2 / length, 0.4 / length]);
    expectPoint(stretchedRay.at, [0, 0]);
  });

  it("leaves out a construction line in paper space and one made invisible", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "XLINE", 8, "0", 67, 1, 10, 1, 20, 1, 11, 1, 21, 0,
        0, "RAY", 8, "0", 60, 1, 10, 2, 20, 2, 11, 1, 21, 0,
        0, "XLINE", 8, "0", 10, 3, 20, 3, 11, 1, 21, 0,
      ],
    }));
    expect(read.constructionLines.map((line) => line.at)).toEqual([{ x: 3, y: 3 }]);
  });

  it("reads a file of nothing but construction lines, with their layer", () => {
    const read = DxfReader.read(dxf({ entities: [0, "XLINE", 8, "AXES", 10, 0, 20, 0, 11, 1, 21, 0] }));
    expect(read.entities).toEqual([]);
    expect(read.layers).toEqual([{ name: 'AXES', count: 1, hidden: false }]);
  });
});

describe("DxfReader: what the file says about itself", () => {
  const line: Groups = [0, "LINE", 8, "A", 10, 0, 20, 0, 11, 1, 21, 1];

  it("reads the declared unit, and none when the file is unitless or the unit has no length", () => {
    const unitOf = (code: number): ImportedDrawing => DxfReader.read(dxf({ header: [9, "$INSUNITS", 70, code], entities: line }));
    expect(unitOf(4).unit).toEqual({ name: 'mm', mm: 1 });
    expect(unitOf(6).unit).toEqual({ name: 'm', mm: 1000 });
    expect(unitOf(13).unit).toEqual({ name: 'µm', mm: 1e-3 });
    expect(unitOf(0).unit).toBeNull();
    expect(unitOf(0).warnings).toEqual([]);
    expect(unitOf(18).unit).toBeNull();
    expect(unitOf(18).warnings.join(' ')).toMatch(/\$INSUNITS 18/);
  });

  it("lists the layers with curves in the file's order, and marks the frozen and the switched-off", () => {
    const layer = (name: string, flags: number, color: number): Groups => [0, "LAYER", 2, name, 70, flags, 62, color, 6, "CONTINUOUS"];
    const read = DxfReader.read(dxf({
      tables: [0, "TABLE", 2, "LAYER", 70, 4,
        ...layer("EMPTY", 0, 7), ...layer("OFF", 0, -3), ...layer("FROZEN", 1, 2), ...layer("ON", 0, 1),
        0, "ENDTAB"],
      entities: [
        0, "LINE", 8, "ON", 10, 0, 20, 0, 11, 1, 21, 1,
        0, "LINE", 8, "FROZEN", 10, 0, 20, 0, 11, 1, 21, 1,
        0, "LINE", 8, "OFF", 10, 0, 20, 0, 11, 1, 21, 1,
        0, "LINE", 8, "OFF", 10, 0, 20, 0, 11, 2, 21, 1,
        0, "LINE", 8, "UNLISTED", 10, 0, 20, 0, 11, 1, 21, 1,
      ],
    }));
    expect(read.layers).toEqual([
      { name: 'OFF', count: 2, hidden: true },
      { name: 'FROZEN', count: 1, hidden: true },
      { name: 'ON', count: 1, hidden: false },
      { name: 'UNLISTED', count: 1, hidden: false },
    ]);
  });

  it("counts what is not a curve, and leaves out paper space and invisible entities without a word", () => {
    const read = DxfReader.read(dxf({
      entities: [
        0, "TEXT", 8, "0", 10, 0, 20, 0, 40, 2, 1, "hello",
        0, "TEXT", 8, "0", 10, 0, 20, 5, 40, 2, 1, "again",
        0, "DIMENSION", 8, "0", 2, "*D1",
        0, "HATCH", 8, "0", 2, "SOLID",
        0, "LINE", 8, "0", 67, 1, 10, 0, 20, 0, 11, 1, 21, 1,
        0, "LINE", 8, "0", 60, 1, 10, 0, 20, 0, 11, 1, 21, 1,
        0, "VIEWPORT", 8, "0", 67, 1,
        ...line,
      ],
    }));
    expect(read.entities).toHaveLength(1);
    // Text is read as text, not counted among what is left out.
    expect(read.texts).toHaveLength(2);
    expect(read.skipped).toEqual({ DIMENSION: 1, HATCH: 1 });
  });

  it("reads a file's bytes in the code page its header names, and UTF-8 as UTF-8", () => {
    const head = "0\nSECTION\n2\nHEADER\n9\n$DWGCODEPAGE\n3\nANSI_936\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n";
    const tail = "\n10\n0\n20\n0\n11\n1\n21\n1\n0\nENDSEC\n0\nEOF\n";
    const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
    // 实体 ("solid") in GBK.
    const gbk = new Uint8Array([...ascii(head), 0xca, 0xb5, 0xcc, 0xe5, ...ascii(tail)]);
    expect(DxfReader.readBytes(gbk).layers).toEqual([{ name: "实体", count: 1, hidden: false }]);
    const utf8 = new TextEncoder().encode(`${head}实体${tail}`);
    expect(DxfReader.readBytes(utf8).layers).toEqual([{ name: "实体", count: 1, hidden: false }]);
    // No code page named, and not UTF-8: Western European.
    const latin = new Uint8Array([...ascii(head.replace("9\n$DWGCODEPAGE\n3\nANSI_936\n", "")), 0xe9, ...ascii(tail)]);
    expect(DxfReader.readBytes(latin).layers[0].name).toBe("é");
  });

  it("refuses what is not an ASCII DXF, saying what it is", () => {
    expect(() => DxfReader.read("AutoCAD Binary DXF\r\n\u001a\u0000")).toThrow(/binary DXF/);
    expect(() => DxfReader.read("AC1027\u0000\u0000")).toThrow(/DWG file/);
    expect(() => DxfReader.read("<svg xmlns='http://www.w3.org/2000/svg'/>")).toThrow(/not a DXF file: line 1/);
    expect(() => DxfReader.read("0\nEOF\n")).toThrow(/no sections/);
    expect(() => DxfReader.read("")).toThrow(/no sections/);
  });
});
