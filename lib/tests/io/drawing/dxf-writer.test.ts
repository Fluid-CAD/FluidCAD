import { describe, it, expect } from "vitest";
import { DxfWriter } from "../../../io/drawing/dxf-writer.js";
import { Curves } from "../../../io/drawing/drawing.js";
import type { Curve2D, Drawing2D, DrawingEntity } from "../../../io/drawing/drawing.js";
import type { LengthUnit } from "../../../units/units.js";
import { DxfOracle } from "./dxf-oracle.js";
import type { DxfFile, DxfObject } from "./dxf-oracle.js";

function drawingOf(entities: DrawingEntity[], unit: LengthUnit = 'mm'): Drawing2D {
  return { unit, entities, bounds: Curves.boundsOf(entities), warnings: [] };
}

/** One of every curve kind, on every layer. */
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

function entitiesOf(file: DxfFile): DxfObject[] {
  return DxfOracle.section(file, 'ENTITIES').objects;
}

/** Every handle the file defines: group 5, and 105 for DIMSTYLE entries. */
function handlesOf(file: DxfFile): string[] {
  const handles: string[] = [];
  for (const section of file.sections) {
    if (section.name === 'HEADER') {
      continue;
    }
    for (const object of section.objects) {
      const handle = DxfOracle.first(object, object.type === 'DIMSTYLE' ? 105 : 5);
      if (handle !== undefined) {
        handles.push(handle);
      }
    }
  }
  return handles;
}

describe("DxfWriter structure", () => {
  const text = DxfWriter.write(drawingOf(everyKind()));
  const file = DxfOracle.parse(text);

  it("is well-formed ASCII group-code pairs ending in EOF", () => {
    // DxfOracle.parse above already threw on an odd line count, a bad group
    // code, an unclosed section or a missing EOF.
    expect(/^[\x20-\x7e\r\n]*$/.test(text)).toBe(true);
    expect(text.endsWith("0\r\nEOF\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it("writes the AC1015 sections in order", () => {
    expect(file.sections.map((s) => s.name)).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);
    expect(DxfOracle.headerVariable(file, '$ACADVER')).toEqual([{ code: 1, value: 'AC1015' }]);
  });

  it("writes every table a reader requires, with the entry count it declares", () => {
    const tables = DxfOracle.tables(file);
    expect([...tables.keys()]).toEqual(['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']);
    for (const [, table] of tables) {
      expect(DxfOracle.number(table.header, 70)).toBe(table.entries.length);
      expect(DxfOracle.all(table.header, 100)).toContain('AcDbSymbolTable');
    }
    const names = (table: string) => tables.get(table)!.entries.map((e) => DxfOracle.first(e, 2));
    expect(names('LTYPE')).toEqual(['ByBlock', 'ByLayer', 'Continuous', 'HIDDEN']);
    expect(names('LAYER')).toEqual(['0', 'VISIBLE', 'TANGENT', 'HIDDEN']);
    expect(names('STYLE')).toEqual(['Standard']);
    expect(names('APPID')).toEqual(['ACAD']);
    expect(names('DIMSTYLE')).toEqual(['Standard']);
    expect(names('BLOCK_RECORD')).toEqual(['*Model_Space', '*Paper_Space']);
  });

  it("writes both block definitions and the object dictionaries", () => {
    const blocks = DxfOracle.section(file, 'BLOCKS').objects;
    expect(blocks.map((b) => b.type)).toEqual(['BLOCK', 'ENDBLK', 'BLOCK', 'ENDBLK']);
    expect(blocks.filter((b) => b.type === 'BLOCK').map((b) => DxfOracle.first(b, 2))).toEqual(['*Model_Space', '*Paper_Space']);
    const objects = DxfOracle.section(file, 'OBJECTS').objects;
    expect(objects.map((o) => o.type)).toEqual(['DICTIONARY', 'DICTIONARY']);
    // The root dictionary names ACAD_GROUP and points at the second dictionary.
    expect(DxfOracle.first(objects[0], 3)).toBe('ACAD_GROUP');
    expect(DxfOracle.first(objects[0], 350)).toBe(DxfOracle.first(objects[1], 5));
  });

  it("gives every object a unique handle below $HANDSEED", () => {
    const handles = handlesOf(file);
    expect(new Set(handles).size).toBe(handles.length);
    for (const handle of handles) {
      expect(/^[1-9A-F][0-9A-F]*$/.test(handle)).toBe(true);
    }
    const seed = parseInt(DxfOracle.headerVariable(file, '$HANDSEED')[0].value, 16);
    expect(Math.max(...handles.map((h) => parseInt(h, 16)))).toBeLessThan(seed);
  });

  it("names an owner that exists for every object", () => {
    const handles = new Set(handlesOf(file));
    let owned = 0;
    for (const section of file.sections) {
      for (const object of section.objects) {
        const owner = DxfOracle.first(object, 330);
        if (owner !== undefined) {
          owned++;
          expect(owner === '0' || handles.has(owner)).toBe(true);
        }
      }
    }
    expect(owned).toBeGreaterThan(20);
    // Entities belong to model space.
    const modelSpace = DxfOracle.first(DxfOracle.tables(file).get('BLOCK_RECORD')!.entries[0], 5);
    for (const entity of entitiesOf(file)) {
      expect(DxfOracle.first(entity, 330)).toBe(modelSpace);
    }
  });

  it("puts every entity on a layer of the table, with a linetype of the table", () => {
    const tables = DxfOracle.tables(file);
    const layers = new Set(tables.get('LAYER')!.entries.map((e) => DxfOracle.first(e, 2)));
    const linetypes = new Set(tables.get('LTYPE')!.entries.map((e) => DxfOracle.first(e, 2)));
    for (const entity of entitiesOf(file)) {
      expect(DxfOracle.all(entity, 100)[0]).toBe('AcDbEntity');
      expect(layers.has(DxfOracle.first(entity, 8))).toBe(true);
    }
    for (const layer of tables.get('LAYER')!.entries) {
      expect(linetypes.has(DxfOracle.first(layer, 6))).toBe(true);
    }
    const hidden = tables.get('LAYER')!.entries.find((e) => DxfOracle.first(e, 2) === 'HIDDEN')!;
    expect(DxfOracle.first(hidden, 6)).toBe('HIDDEN');
  });

  it("writes each curve as its native entity", () => {
    expect(entitiesOf(file).map((e) => e.type)).toEqual([
      'LINE', 'CIRCLE', 'ARC', 'ARC', 'ELLIPSE', 'ELLIPSE', 'SPLINE', 'SPLINE', 'LWPOLYLINE', 'LWPOLYLINE',
    ]);
  });

  it("declares in a SPLINE exactly the knots, poles and weights it writes", () => {
    const splines = entitiesOf(file).filter((e) => e.type === 'SPLINE');
    expect(splines).toHaveLength(2);
    for (const spline of splines) {
      const knots = DxfOracle.all(spline, 40).length;
      const poles = DxfOracle.all(spline, 10).length;
      expect(DxfOracle.number(spline, 72)).toBe(knots);
      expect(DxfOracle.number(spline, 73)).toBe(poles);
      expect(DxfOracle.number(spline, 74)).toBe(0);
      expect(knots).toBe(poles + DxfOracle.number(spline, 71) + 1);
      const rational = (DxfOracle.number(spline, 70) & 4) === 4;
      expect(DxfOracle.all(spline, 41).length).toBe(rational ? poles : 0);
      // Planar, never closed or periodic.
      expect(DxfOracle.number(spline, 70) & 8).toBe(8);
      expect(DxfOracle.number(spline, 70) & 3).toBe(0);
    }
    expect(splines.map((s) => DxfOracle.number(s, 70) & 4)).toEqual([0, 4]);
  });

  it("writes only the layers and linetypes in use", () => {
    const visibleOnly = DxfOracle.parse(DxfWriter.write(drawingOf(everyKind().filter((e) => e.layer === 'visible'))));
    const tables = DxfOracle.tables(visibleOnly);
    expect(tables.get('LAYER')!.entries.map((e) => DxfOracle.first(e, 2))).toEqual(['0', 'VISIBLE']);
    expect(tables.get('LTYPE')!.entries.map((e) => DxfOracle.first(e, 2))).toEqual(['ByBlock', 'ByLayer', 'Continuous']);
  });

  it("writes a valid file for an empty drawing", () => {
    const empty = DxfOracle.parse(DxfWriter.write(drawingOf([])));
    expect(empty.sections.map((s) => s.name)).toEqual(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']);
    expect(entitiesOf(empty)).toHaveLength(0);
  });

  it("is the same bytes for the same drawing", () => {
    expect(DxfWriter.write(drawingOf(everyKind()))).toBe(text);
  });
});

describe("DxfWriter geometry round trip", () => {
  // Every written entity, read back by the format's own rules, lies on the
  // curve it was written from.
  const entities = everyKind();
  const file = DxfOracle.parse(DxfWriter.write(drawingOf(entities)));
  const written = entitiesOf(file);

  it.each(entities.map((entity, index) => [index, entity.curve.kind, entity] as const))(
    "entity %i (%s) reads back on its curve",
    (index, _kind, entity) => {
      const samples = 48;
      const expected = Curves.sample(entity.curve, samples);
      const actual = DxfOracle.sample(written[index], samples);
      expect(actual).toHaveLength(expected.length);
      const deviation = Math.max(...expected.map((p, i) => Math.hypot(p.x - actual[i].x, p.y - actual[i].y)));
      expect(deviation).toBeLessThan(1e-6);
    },
  );

  it("writes arc angles in degrees inside [0, 360)", () => {
    const arcs = written.filter((e) => e.type === 'ARC');
    expect(DxfOracle.number(arcs[0], 50)).toBeCloseTo((0.4 * 180) / Math.PI, 8);
    expect(DxfOracle.number(arcs[0], 51)).toBeCloseTo((2.9 * 180) / Math.PI, 8);
    // 7.0 rad is past a full turn: written as the same direction below 360°.
    expect(DxfOracle.number(arcs[1], 50)).toBeCloseTo((5.5 * 180) / Math.PI, 8);
    expect(DxfOracle.number(arcs[1], 51)).toBeCloseTo(((7.0 - 2 * Math.PI) * 180) / Math.PI, 8);
  });

  it("writes ellipse parameters in radians and the major axis relative to the centre", () => {
    const ellipse = written.filter((e) => e.type === 'ELLIPSE')[1];
    expect(DxfOracle.number(ellipse, 11)).toBe(-6);
    expect(DxfOracle.number(ellipse, 21)).toBe(2);
    expect(DxfOracle.number(ellipse, 40)).toBe(0.75);
    expect(DxfOracle.number(ellipse, 41)).toBe(4);
    expect(DxfOracle.number(ellipse, 42)).toBe(7.5);
  });
});

describe("DxfWriter splines above degree three", () => {
  // DXF allows them and the kernel's intersection curves are quintic or
  // sextic, but LibreCAD and the importers built on its reader draw nothing
  // for one: the curve where a wall meets a pipe was missing from the view.
  const sextic: Extract<Curve2D, { kind: 'bspline' }> = {
    kind: 'bspline',
    degree: 6,
    knots: [0, 0, 0, 0, 0, 0, 0, 0.4, 1, 1, 1, 1, 1, 1, 1],
    poles: [
      { x: 0, y: 0 }, { x: 3, y: 8 }, { x: 7, y: 9 }, { x: 12, y: 2 },
      { x: 15, y: -4 }, { x: 19, y: 1 }, { x: 22, y: 6 }, { x: 26, y: 3 },
    ],
  };
  const written = (curve: Curve2D) => entitiesOf(DxfOracle.parse(DxfWriter.write(drawingOf([{ layer: 'visible', curve }]))))[0];

  it("writes such a spline as a cubic that lies on it", () => {
    const spline = written(sextic);
    expect(spline.type).toBe('SPLINE');
    expect(DxfOracle.number(spline, 71)).toBe(3);
    expect(DxfOracle.number(spline, 70)).toBe(8);
    const knots = DxfOracle.all(spline, 40).length;
    const poles = DxfOracle.all(spline, 10).length;
    expect(DxfOracle.number(spline, 72)).toBe(knots);
    expect(DxfOracle.number(spline, 73)).toBe(poles);
    expect(knots).toBe(poles + 4);

    // The cubic keeps the curve's parameter, so equal samples compare like with like.
    const samples = 400;
    const expected = Curves.sample(sextic, samples);
    const actual = DxfOracle.sample(spline, samples);
    const deviation = Math.max(...expected.map((p, i) => Math.hypot(p.x - actual[i].x, p.y - actual[i].y)));
    // 1e-5 mm asked of the fit, the rest is the file's nine decimals.
    expect(deviation).toBeLessThan(2e-5);
  });

  it("asks the same closeness in millimetres of an inch drawing", () => {
    const inches = entitiesOf(DxfOracle.parse(DxfWriter.write(drawingOf([{ layer: 'visible', curve: sextic }], 'in'))))[0];
    // The same numbers read as inches are 25.4 times larger: the fit is 25.4 times finer.
    expect(DxfOracle.all(inches, 10).length).toBeGreaterThan(DxfOracle.all(written(sextic), 10).length);
  });

  it("leaves cubics and lower degrees alone, rational ones included", () => {
    const cubic: Curve2D = { kind: 'bspline', degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 0 }] };
    const conic: Curve2D = { kind: 'bspline', degree: 2, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], weights: [1, Math.SQRT1_2, 1] };
    expect(DxfOracle.number(written(cubic), 71)).toBe(3);
    expect(DxfOracle.all(written(cubic), 10)).toHaveLength(4);
    expect(DxfOracle.number(written(conic), 71)).toBe(2);
    expect(DxfOracle.number(written(conic), 70)).toBe(12);
    expect(DxfOracle.all(written(conic), 41)).toHaveLength(3);
  });
});

describe("DxfWriter numbers", () => {
  it("never writes an exponent, a negative zero or a bare integer", () => {
    expect(DxfWriter.real(0)).toBe('0.0');
    expect(DxfWriter.real(-0)).toBe('0.0');
    expect(DxfWriter.real(-1e-12)).toBe('0.0');
    expect(DxfWriter.real(1e-7)).toBe('0.0000001');
    expect(DxfWriter.real(40)).toBe('40.0');
    expect(DxfWriter.real(-12.5)).toBe('-12.5');
    expect(DxfWriter.real(1 / 3)).toBe('0.333333333');
    expect(DxfWriter.real(123456789012.25)).toBe('123456789012.25');
  });

  it("refuses what it cannot write", () => {
    expect(() => DxfWriter.real(NaN)).toThrow();
    expect(() => DxfWriter.real(Infinity)).toThrow();
    expect(() => DxfWriter.real(1e21)).toThrow();
  });

  it("writes no real with an exponent anywhere in a file", () => {
    const tiny: DrawingEntity[] = [
      { layer: 'visible', curve: { kind: 'line', a: { x: 1e-12, y: -1e-12 }, b: { x: 1e9, y: 2.5e-8 } } },
    ];
    const file = DxfOracle.parse(DxfWriter.write(drawingOf(tiny)));
    for (const pair of file.pairs) {
      expect(/[0-9]e[-+]?[0-9]/i.test(pair.value) && pair.code >= 10 && pair.code < 60).toBe(false);
      expect(pair.value).not.toBe('-0.0');
      expect(pair.value.includes('NaN')).toBe(false);
    }
  });

  it("refuses a drawing with a non-finite coordinate or a malformed spline", () => {
    const bad: DrawingEntity[] = [{ layer: 'visible', curve: { kind: 'circle', center: { x: NaN, y: 0 }, radius: 1 } }];
    expect(() => DxfWriter.write({ unit: 'mm', entities: bad, bounds: null, warnings: [] })).toThrow();
    const spline: DrawingEntity[] = [{
      layer: 'visible',
      curve: { kind: 'bspline', degree: 3, knots: [0, 0, 0, 1, 1, 1], poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 1 }] },
    }];
    expect(() => DxfWriter.write(drawingOf(spline))).toThrow(/knots/);
  });
});

describe("DxfWriter units", () => {
  const cases: [LengthUnit, number, number][] = [
    ['mm', 4, 1],
    ['cm', 5, 1],
    ['m', 6, 1],
    ['in', 1, 0],
    ['ft', 2, 0],
  ];

  it.each(cases)("declares %s as $INSUNITS %i, $MEASUREMENT %i and leaves the numbers alone", (unit, insunits, measurement) => {
    const entities: DrawingEntity[] = [
      { layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 1 } } },
      { layer: 'hidden', curve: { kind: 'line', a: { x: 0, y: 1 }, b: { x: 2, y: 2 } } },
    ];
    const file = DxfOracle.parse(DxfWriter.write(drawingOf(entities, unit)));
    expect(DxfOracle.headerVariable(file, '$INSUNITS')).toEqual([{ code: 70, value: String(insunits) }]);
    expect(DxfOracle.headerVariable(file, '$MEASUREMENT')).toEqual([{ code: 70, value: String(measurement) }]);
    const line = entitiesOf(file)[0];
    expect([DxfOracle.number(line, 11), DxfOracle.number(line, 21)]).toEqual([2, 1]);
    expect(DxfOracle.headerVariable(file, '$EXTMAX').map((p) => Number(p.value))).toEqual([2, 2, 0]);
  });

  it("sizes the hidden linetype's dashes in the drawing's unit", () => {
    const entities: DrawingEntity[] = [{ layer: 'hidden', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 1 } } }];
    const dash = (unit: LengthUnit) => {
      const file = DxfOracle.parse(DxfWriter.write(drawingOf(entities, unit)));
      const hidden = DxfOracle.tables(file).get('LTYPE')!.entries.find((e) => DxfOracle.first(e, 2) === 'HIDDEN')!;
      expect(DxfOracle.number(hidden, 73)).toBe(2);
      return DxfOracle.all(hidden, 49).map(Number);
    };
    expect(dash('mm')).toEqual([6.35, -3.175]);
    expect(dash('in')).toEqual([0.25, -0.125]);
    expect(dash('m')).toEqual([0.00635, -0.003175]);
  });
});

describe("DxfWriter golden files", () => {
  // Stored with LF line ends so no checkout setting can touch them; the
  // CRLF the writer produces is asserted in the structure tests.
  const golden = (text: string) => text.replace(/\r\n/g, '\n');

  it("every curve kind on every layer", async () => {
    await expect(golden(DxfWriter.write(drawingOf(everyKind())))).toMatchFileSnapshot('./golden/every-kind.dxf');
  });

  it("an empty drawing", async () => {
    await expect(golden(DxfWriter.write(drawingOf([])))).toMatchFileSnapshot('./golden/empty.dxf');
  });

  it("an inch drawing with hidden lines", async () => {
    const entities: DrawingEntity[] = [
      { layer: 'visible', curve: { kind: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } } },
      { layer: 'visible', curve: { kind: 'arc', center: { x: 2, y: 0.5 }, radius: 0.5, start: 1.5 * Math.PI, end: 2.5 * Math.PI } },
      { layer: 'hidden', curve: { kind: 'circle', center: { x: 1, y: 0.5 }, radius: 0.125 } },
    ];
    await expect(golden(DxfWriter.write(drawingOf(entities, 'in')))).toMatchFileSnapshot('./golden/inch-hidden.dxf');
  });
});
