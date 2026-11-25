import { describe, it, expect } from "vitest";
import { ImportedTexts } from "../../../io/drawing/imported-text.js";
import type { FontMeasure, ImportedText, ResolvedText } from "../../../io/drawing/imported-text.js";
import { Affine } from "../../../io/drawing/affine.js";
import { SketchImport } from "../../../io/drawing/sketch-import.js";

// A file's text and a font's measurements, made into the text a sketch
// writes: its em size, its anchor on the first baseline, its line spacing —
// and the statements a plan gives it.

const OPTIONS = { tolerance: 1e-5, joinTolerance: 1e-3, decimals: 6 };

/** A font whose capitals are 0.7 em tall, 0.9 above and 0.2 below the baseline with 0.05 between lines; every letter 0.5 em wide. */
const measure = (lines: string[], more: Partial<FontMeasure> = {}): FontMeasure => ({
  family: 'Test Sans',
  substituted: false,
  capital: 0.7,
  ascent: 0.9,
  descent: 0.2,
  lineGap: 0.05,
  advances: lines.map((line) => line.length * 0.5),
  ...more,
});

const text = (more: Partial<ImportedText> = {}): ImportedText => ({
  layer: '0',
  lines: ['ABCD'],
  at: { x: 10, y: 20 },
  angle: 0,
  align: 'left',
  rise: 0,
  size: { capital: 7 },
  letterSpacing: 0,
  font: { families: ['Test Sans'], bold: false, italic: false },
  ...more,
});

const resolved = (source: ImportedText, more: Partial<FontMeasure> = {}): ResolvedText => {
  const result = ImportedTexts.resolve(source, measure(source.lines, more));
  if ('refused' in result) {
    throw new Error(`refused: ${result.refused}`);
  }
  return result.text;
};

describe("ImportedTexts.resolve", () => {
  it("turns a capital height into the em that gives it in the font, by the font's own capital", () => {
    const made = resolved(text());
    expect(made.size).toBeCloseTo(10, 12);
    expect(made.capital).toBeCloseTo(7, 12);
    expect(made.widths[0]).toBeCloseTo(20, 12);
    expect(made).toMatchObject({ text: 'ABCD', font: 'Test Sans', standsFor: null, at: { x: 10, y: 20 }, lineSpacing: 1 });
  });

  it("takes an em as it is", () => {
    expect(resolved(text({ size: { em: 12 } })).size).toBe(12);
    expect(resolved(text({ size: { em: 12 } })).capital).toBeCloseTo(8.4, 12);
  });

  it("lowers the anchor from the file's point to the baseline: half a capital for Middle, a whole one for Top", () => {
    expect(resolved(text({ rise: 0.5 })).at).toEqual({ x: 10, y: 16.5 });
    expect(resolved(text({ rise: 1 })).at).toEqual({ x: 10, y: 13 });
  });

  it("lowers it across the baseline when the text is turned", () => {
    const made = resolved(text({ rise: 1, angle: Math.PI / 2 }));
    // Reading upwards, the capitals' tops are to the left: the baseline is 7 to the right of the point.
    expect(made.at.x).toBeCloseTo(17, 12);
    expect(made.at.y).toBeCloseTo(20, 12);
  });

  it("gives the line distance a file asks for as a multiple of the font's own", () => {
    // The font's lines are (0.9 + 0.2 + 0.05) × 10 = 11.5 apart; the file wants 5/3 of the capital height.
    const made = resolved(text({ lines: ['A', 'B'], lineAdvance: 7 * (5 / 3) }));
    expect(made.lineSpacing).toBeCloseTo((7 * (5 / 3)) / 11.5, 12);
    expect(made.lineAdvance).toBeCloseTo(7 * (5 / 3), 12);
    expect(made.text).toBe('A\nB');
  });

  it("counts letter spacing in a line's width", () => {
    expect(resolved(text({ letterSpacing: 2 })).widths[0]).toBeCloseTo(20 + 3 * 2, 12);
  });

  it("names the family a stand-in is written for", () => {
    expect(resolved(text({ font: { families: ['Arial', 'sans-serif'], bold: false, italic: false } }), { family: 'Liberation Sans', substituted: true }))
      .toMatchObject({ font: 'Liberation Sans', standsFor: 'Arial' });
  });

  it("refuses for the file's own reason, for a font that is not installed, and for a line wider than its box", () => {
    expect(ImportedTexts.resolve(text({ issue: 'shape' }), measure(['ABCD']))).toEqual({ refused: 'shape' });
    expect(ImportedTexts.resolve(text(), measure(['ABCD'], { family: null }))).toEqual({ refused: 'font' });
    expect(ImportedTexts.resolve(text(), undefined)).toEqual({ refused: 'font' });
    // 20 wide: fits a box of 25, not one of 20.2 (too near to call) nor one of 15.
    expect('text' in ImportedTexts.resolve(text({ boxWidth: 25 }), measure(['ABCD']))).toBe(true);
    expect(ImportedTexts.resolve(text({ boxWidth: 20.2 }), measure(['ABCD']))).toEqual({ refused: 'wrap' });
    expect(ImportedTexts.resolve(text({ boxWidth: 15 }), measure(['ABCD']))).toEqual({ refused: 'wrap' });
  });
});

describe("ImportedTexts: a resolved text's geometry", () => {
  it("runs each line's baseline from the anchor: to its right, about it, or up to it", () => {
    expect(ImportedTexts.baseline(resolved(text()))).toEqual({ a: { x: 10, y: 20 }, b: { x: 30, y: 20 } });
    expect(ImportedTexts.baseline(resolved(text({ align: 'center' })))).toEqual({ a: { x: 0, y: 20 }, b: { x: 20, y: 20 } });
    expect(ImportedTexts.baseline(resolved(text({ align: 'right' })))).toEqual({ a: { x: -10, y: 20 }, b: { x: 10, y: 20 } });
  });

  it("boxes each line from its baseline to the top of its capitals, the next one a line lower", () => {
    const boxes = ImportedTexts.boxes(resolved(text({ lines: ['ABCD', 'AB'], lineAdvance: 12 })));
    expect(boxes[0]).toEqual([{ x: 10, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 27 }, { x: 10, y: 27 }]);
    expect(boxes[1]).toEqual([{ x: 10, y: 8 }, { x: 20, y: 8 }, { x: 20, y: 15 }, { x: 10, y: 15 }]);
    expect(ImportedTexts.bounds([resolved(text({ lines: ['ABCD', 'AB'], lineAdvance: 12 }))])).toEqual({ min: { x: 10, y: 8 }, max: { x: 30, y: 27 } });
    expect(ImportedTexts.bounds([])).toBeNull();
  });

  it("moves, turns and scales with a placement", () => {
    const placed = ImportedTexts.placed(resolved(text({ letterSpacing: 1 })), Affine.placement(2, Math.PI / 2, { x: 100, y: 0 }));
    expect(placed.at.x).toBeCloseTo(60, 9);
    expect(placed.at.y).toBeCloseTo(20, 9);
    expect(placed.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(placed.size).toBeCloseTo(20, 12);
    expect(placed.letterSpacing).toBeCloseTo(2, 12);
    expect(placed.capital).toBeCloseTo(14, 12);
    expect(placed.widths[0]).toBeCloseTo(46, 12);
  });

  it("tells a turn and a scale from what stretches, skews or mirrors", () => {
    const frame = ImportedTexts.frameUnder(Affine.placement(3, 0.4, { x: 5, y: 5 }), 0.1)!;
    expect(frame.angle).toBeCloseTo(0.5, 12);
    expect(frame.scale).toBeCloseTo(3, 12);
    expect(ImportedTexts.frameUnder({ a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0)).toBeNull();
    expect(ImportedTexts.frameUnder({ a: 1, b: 0, c: 0.3, d: 1, e: 0, f: 0 }, 0)).toBeNull();
    expect(ImportedTexts.frameUnder({ a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }, 0)).toBeNull();
    expect(ImportedTexts.frameUnder({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 0)).toBeNull();
  });
});

describe("SketchImport: text", () => {
  const line = { kind: 'line' as const, a: { x: 0, y: 0 }, b: { x: 40, y: 0 } };

  it("writes a level text as a text placed by its anchor, after everything that is drawn", () => {
    const plan = SketchImport.plan([line], OPTIONS, [{ x: 1, y: 1 }], { texts: [resolved(text({ size: { capital: 3.5 }, align: 'center' }))] });
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'point', 'text']);
    expect(plan.primitives[2]).toEqual({
      kind: 'text', text: 'ABCD', font: 'Test Sans', bold: false, italic: false,
      size: 5, align: 'center', lineSpacing: 1, letterSpacing: 0, at: { x: 10, y: 20 },
    });
    expect(plan.joins).toEqual([]);
  });

  it("writes a turned text along a guide line on its baseline, as long as the text is wide, the lines before the texts", () => {
    const upright = resolved(text({ angle: Math.PI / 2 }));
    const level = resolved(text({ at: { x: 50, y: 50 } }));
    const plan = SketchImport.plan([line], OPTIONS, [], { texts: [upright, level] });
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'line', 'text', 'text']);
    expect(plan.primitives[1]).toEqual({ kind: 'line', start: { x: 10, y: 20 }, end: { x: 10, y: 40 }, guide: true });
    expect(plan.primitives[2]).toMatchObject({ kind: 'text', path: 1 });
    expect((plan.primitives[2] as { at?: unknown }).at).toBeUndefined();
    expect(plan.primitives[3]).toMatchObject({ kind: 'text', at: { x: 50, y: 50 } });
    // A baseline is a guide: it joins nothing.
    expect(plan.joins).toEqual([]);
  });

  it("centres the baseline of a centred text on its anchor, and ends a right-aligned one's there", () => {
    const made = (align: 'center' | 'right') => SketchImport.plan([], OPTIONS, [], { texts: [resolved(text({ angle: Math.PI, align }))] }).primitives[0];
    // Half a turn: the text runs towards −X.
    expect(made('center')).toEqual({ kind: 'line', start: { x: 20, y: 20 }, end: { x: 0, y: 20 }, guide: true });
    expect(made('right')).toEqual({ kind: 'line', start: { x: 30, y: 20 }, end: { x: 10, y: 20 }, guide: true });
  });

  it("rounds a text's size and place like everything else, and writes one given twice once", () => {
    const one = resolved(text({ at: { x: 1 / 3, y: 2 / 3 }, size: { capital: 1 } }));
    const plan = SketchImport.plan([], OPTIONS, [], { texts: [one, { ...one }, resolved(text({ at: { x: 1 / 3, y: 2 / 3 }, size: { capital: 2 } }))] });
    expect(plan.primitives).toHaveLength(2);
    expect(plan.primitives[0]).toMatchObject({ size: 1.428571, at: { x: 0.333333, y: 0.666667 } });
    expect(plan.duplicates).toBe(0);
  });

  it("fixes a level text by its anchor, and a turned one by the ends of its baseline", () => {
    const plan = SketchImport.plan([], OPTIONS, [], { texts: [resolved(text({ angle: 1 })), resolved(text())] });
    const pins = SketchImport.pins(plan, { joined: true, decimals: OPTIONS.decimals });
    expect(pins).toEqual([
      { kind: 'fix', point: { primitive: 0, point: 'start' } },
      { kind: 'fix', point: { primitive: 0, point: 'end' } },
      { kind: 'fix', point: { primitive: 2, point: 'anchor' } },
    ]);
  });

  it("draws a text's outline as its anchor, and nothing for one on a baseline", () => {
    const plan = SketchImport.plan([], OPTIONS, [], { texts: [resolved(text({ angle: 1 })), resolved(text())] });
    expect(SketchImport.outline(plan.primitives[1])).toEqual([]);
    expect(SketchImport.outline(plan.primitives[2])).toEqual([{ x: 10, y: 20 }]);
  });
});
