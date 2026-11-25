import { describe, it, expect, beforeAll } from "vitest";
import { render, setupOC } from "../setup.js";
import sketch from "../../core/sketch.js";
import { DxfReader } from "../../io/drawing/dxf-reader.js";
import { SvgReader } from "../../io/drawing/svg-reader.js";
import { Affine } from "../../io/drawing/affine.js";
import type { Affine2 } from "../../io/drawing/affine.js";
import { SketchImport } from "../../io/drawing/sketch-import.js";
import type { SketchImportPlan } from "../../io/drawing/sketch-import.js";
import { ImportedTexts } from "../../io/drawing/imported-text.js";
import type { FontMeasure, ImportedText, ResolvedText } from "../../io/drawing/imported-text.js";
import { FontRegistry } from "../../io/font-registry.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { OPTIONS, draw, solved } from "./sketch-plan.js";

// Imported text end to end: a file read, its texts resolved against a real
// font, planned as `text()` statements, drawn in a sketch — and the
// letters measured where the kernel put them. What this pins is that a
// text lands where the file has it: on its baseline, as tall as the file
// says, turned the way it is turned.
//
// The font is whichever the machine gives a text without one. Its H is the
// yardstick: a flat capital, so its box says exactly where the baseline
// and the capital line are.

type Groups = (string | number)[];

/** The font, and its H: left and right side bearings and height, as shares of the em. */
let family = '';
let H = { left: 0, right: 0, top: 0, advance: 0 };

/** How a font measures, taken from the font itself: what the server answers a measure request with. */
function measureOf(text: ImportedText): FontMeasure {
  const font = FontRegistry.resolve({ font: family, weight: text.font.bold ? 700 : 400, italic: text.font.italic });
  const em = font.unitsPerEm;
  return {
    family,
    substituted: false,
    capital: font.glyphForCodePoint(72).bbox.maxY / em,
    ascent: font.ascent / em,
    descent: -font.descent / em,
    lineGap: font.lineGap / em,
    advances: text.lines.map((line) => font.layout(line).positions.reduce((sum, position) => sum + position.xAdvance, 0) / em),
  };
}

function resolvedOf(texts: readonly ImportedText[], m: Affine2 = Affine.IDENTITY): ResolvedText[] {
  return texts.map((text) => {
    const result = ImportedTexts.resolve(text, measureOf(text));
    if ('refused' in result) {
      throw new Error(`refused: ${result.refused}`);
    }
    return ImportedTexts.placed(result.text, m);
  });
}

/** A DXF whose one style draws in the test's font. */
function dxf(entities: Groups, blocks: Groups = []): string {
  return [
    0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "STYLE",
    0, "STYLE", 2, "NOTES", 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 3, "notes.ttf", 4, "", 1001, "ACAD", 1000, family, 1071, 34,
    0, "ENDTAB", 0, "ENDSEC",
    0, "SECTION", 2, "BLOCKS", ...blocks, 0, "ENDSEC",
    0, "SECTION", 2, "ENTITIES", ...entities, 0, "ENDSEC", 0, "EOF",
  ].map(String).join("\n");
}

function planOf(texts: readonly ImportedText[], m: Affine2 = Affine.IDENTITY): SketchImportPlan {
  return SketchImport.plan([], OPTIONS, [], { texts: resolvedOf(texts, m) });
}

/** The plan drawn in a sketch: the exact box of each text's letters, in the order of the plan's texts. */
function drawnBoxes(plan: SketchImportPlan): { minX: number; maxX: number; minY: number; maxY: number }[] {
  sketch("xy", () => draw(plan));
  return render().getAllSceneObjects()
    .filter((object) => object.getType() === 'text')
    .map((object) => ShapeOps.unionBoundingBoxes(object.getShapes().map((shape) => ShapeOps.getExactBoundingBox(shape))));
}

/** Within a micron: the plan writes six decimals. */
const CLOSE = 5;

describe("text imported into a sketch", () => {
  setupOC();

  beforeAll(async () => {
    await FontRegistry.init();
    const font = FontRegistry.resolve({});
    family = font.familyName;
    const glyph = font.glyphForCodePoint(72);
    H = {
      left: glyph.bbox.minX / font.unitsPerEm,
      right: (glyph.advanceWidth - glyph.bbox.maxX) / font.unitsPerEm,
      top: glyph.bbox.maxY / font.unitsPerEm,
      advance: glyph.advanceWidth / font.unitsPerEm,
    };
  });

  it("stands a DXF text on the file's point, its capitals as tall as the file's height", () => {
    const read = DxfReader.read(dxf([0, "TEXT", 8, "0", 7, "NOTES", 10, 30, 20, 20, 40, 5, 1, "H"]));
    const plan = planOf(read.texts);
    const [text] = plan.primitives;
    expect(text).toMatchObject({ kind: 'text', font: family, at: { x: 30, y: 20 } });
    // The em is the height over the share of the em a capital takes — not the height itself.
    const em = (text as { size: number }).size;
    expect(em).toBeCloseTo(5 / H.top, CLOSE);
    const [box] = drawnBoxes(plan);
    expect(box.minY).toBeCloseTo(20, CLOSE);
    expect(box.maxY).toBeCloseTo(25, CLOSE);
    // The H starts its own side bearing past the point, like every first letter.
    expect(box.minX).toBeCloseTo(30 + H.left * em, CLOSE);
  });

  it("centres a Middle Centre text on its point, and hangs a Top Right one from it", () => {
    const read = DxfReader.read(dxf([
      0, "TEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 5, 1, "HH", 72, 1, 73, 2, 11, 80, 21, 40,
      0, "TEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 5, 1, "HH", 72, 2, 73, 3, 11, 80, 21, 10,
    ]));
    const em = 5 / H.top;
    const [middle, top] = drawnBoxes(planOf(read.texts));
    // Half the capital height above and below the point; the line's advance centred on it.
    expect(middle.minY).toBeCloseTo(37.5, CLOSE);
    expect(middle.maxY).toBeCloseTo(42.5, CLOSE);
    expect((middle.minX - H.left * em + middle.maxX + H.right * em) / 2).toBeCloseTo(80, CLOSE);
    // The capitals' tops at the point's height; the line ends at the point.
    expect(top.maxY).toBeCloseTo(10, CLOSE);
    expect(top.minY).toBeCloseTo(5, CLOSE);
    expect(top.maxX + H.right * em).toBeCloseTo(80, CLOSE);
  });

  it("turns a text the way the file turns it: along a guide line on its baseline", () => {
    const read = DxfReader.read(dxf([0, "TEXT", 8, "0", 7, "NOTES", 10, 30, 20, 20, 40, 5, 50, 90, 1, "H"]));
    const plan = planOf(read.texts);
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'text']);
    expect(plan.primitives[0]).toMatchObject({ start: { x: 30, y: 20 }, guide: true });
    const em = 5 / H.top;
    const [box] = drawnBoxes(plan);
    // Reading upwards: the baseline is the line x = 30, the capitals reach 5 to its left,
    // and the letter starts its side bearing above the point.
    expect(box.maxX).toBeCloseTo(30, CLOSE);
    expect(box.minX).toBeCloseTo(25, CLOSE);
    expect(box.minY).toBeCloseTo(20 + H.left * em, CLOSE);
  });

  it("keeps a turned text's justification: centred on its point, or ending at it", () => {
    const read = DxfReader.read(dxf([
      0, "TEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 5, 50, 90, 1, "HH", 72, 1, 73, 0, 11, 30, 21, 40,
      0, "TEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 5, 50, 180, 1, "HH", 72, 2, 73, 3, 11, 60, 21, 40,
    ]));
    const em = 5 / H.top;
    const [centred, upsideDown] = drawnBoxes(planOf(read.texts));
    expect((centred.minY - H.left * em + centred.maxY + H.right * em) / 2).toBeCloseTo(40, CLOSE);
    expect(centred.maxX).toBeCloseTo(30, CLOSE);
    // Half a turn, Top Right: the capitals' tops are at the point's height, now below the baseline,
    // and the line runs towards −X to end at the point.
    expect(upsideDown.minY).toBeCloseTo(40, CLOSE);
    expect(upsideDown.maxY).toBeCloseTo(45, CLOSE);
    expect(upsideDown.minX - H.right * em).toBeCloseTo(60, CLOSE);
  });

  it("sets the lines of a multi-line text five thirds of its height apart, the first one's capitals under its point", () => {
    const read = DxfReader.read(dxf([0, "MTEXT", 8, "0", 7, "NOTES", 10, 10, 20, 50, 40, 4, 71, 1, 1, "H\\PH\\PH"]));
    const plan = planOf(read.texts);
    expect(plan.primitives).toHaveLength(1);
    const [box] = drawnBoxes(plan);
    expect(box.maxY).toBeCloseTo(50, CLOSE);
    // Three lines: the last baseline is the first one's, 46, less two line distances of 20/3.
    expect(box.minY).toBeCloseTo(46 - 2 * (20 / 3), CLOSE);
  });

  it("carries a block's text through a reference that moves, turns and scales it", () => {
    const read = DxfReader.read(dxf(
      [0, "INSERT", 8, "0", 2, "TAG", 10, 100, 20, 50, 41, 2, 42, 2, 50, 90],
      [0, "BLOCK", 8, "0", 2, "TAG", 70, 0, 10, 0, 20, 0, 0, "TEXT", 8, "0", 7, "NOTES", 10, 3, 20, 1, 40, 2.5, 1, "H", 0, "ENDBLK"],
    ));
    const [box] = drawnBoxes(planOf(read.texts));
    // The text's point (3, 1), doubled and turned a quarter turn about the insertion point: (98, 56).
    // Its capitals are 5 tall now, and reach to the left of a baseline that runs upwards.
    expect(box.maxX).toBeCloseTo(98, CLOSE);
    expect(box.minX).toBeCloseTo(93, CLOSE);
    expect(box.minY).toBeCloseTo(56 + H.left * (5 / H.top), CLOSE);
  });

  it("stands an SVG text on its baseline, its em the file's font size, the page turned over", () => {
    const read = SvgReader.read(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <text x="10" y="30" font-family="${family}" font-size="10">H</text>
      <text x="50" y="60" font-family="${family}" font-size="10" text-anchor="middle">HH</text></svg>`);
    const plan = planOf(read.texts);
    expect(plan.primitives[0]).toMatchObject({ kind: 'text', size: 10, at: { x: 10, y: 70 } });
    const [left, centred] = drawnBoxes(plan);
    expect(left.minY).toBeCloseTo(70, CLOSE);
    expect(left.maxY).toBeCloseTo(70 + 10 * H.top, CLOSE);
    expect(left.minX).toBeCloseTo(10 + 10 * H.left, CLOSE);
    expect((centred.minX - 10 * H.left + centred.maxX + 10 * H.right) / 2).toBeCloseTo(50, CLOSE);
    expect(centred.minY).toBeCloseTo(40, CLOSE);
  });

  it("turns an SVG text with its transform: clockwise on the page is clockwise in the sketch", () => {
    const read = SvgReader.read(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
      <text x="20" y="20" transform="rotate(90 20 20)" font-family="${family}" font-size="10">H</text></svg>`);
    const [box] = drawnBoxes(planOf(read.texts));
    // The baseline starts at (20, 80) and runs down the page; the capitals reach to the right of it.
    expect(box.minX).toBeCloseTo(20, CLOSE);
    expect(box.maxX).toBeCloseTo(20 + 10 * H.top, CLOSE);
    expect(box.maxY).toBeCloseTo(80 - 10 * H.left, CLOSE);
  });

  it("moves, turns and scales text with the drawing it is placed with", () => {
    const read = DxfReader.read(dxf([0, "TEXT", 8, "0", 7, "NOTES", 10, 30, 20, 20, 40, 5, 1, "H"]));
    // Twice the size, a quarter turn, moved: the point (30, 20) lands on (100 − 40, 60) = (60, 60).
    const [box] = drawnBoxes(planOf(read.texts, Affine.placement(2, Math.PI / 2, { x: 100, y: 0 })));
    expect(box.maxX).toBeCloseTo(60, CLOSE);
    expect(box.minX).toBeCloseTo(50, CLOSE);
    expect(box.minY).toBeCloseTo(60 + H.left * (10 / H.top), CLOSE);
  });

  it("fixes text in place with the outline: a level one by its anchor, a turned one by its baseline, nothing stated twice", () => {
    const read = DxfReader.read(dxf([
      0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, 0, 20, 0, 10, 40, 20, 0, 10, 40, 20, 20, 10, 0, 20, 20,
      0, "TEXT", 8, "0", 7, "NOTES", 10, 5, 20, 5, 40, 3, 1, "PLATE",
      0, "TEXT", 8, "0", 7, "NOTES", 10, 35, 20, 5, 40, 3, 50, 90, 1, "SIDE",
    ]));
    const plan = SketchImport.plan(read.entities.map((e) => e.curve), OPTIONS, [], { texts: resolvedOf(read.texts) });
    expect(plan.primitives.map((p) => p.kind)).toEqual(['line', 'line', 'line', 'line', 'line', 'text', 'text']);
    expect(solved(plan, true)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
    expect(solved(plan, false)).toEqual({ outcome: 'solved', dof: 0, redundant: 0, conflicting: 0 });
  });

  it("leaves text free to move when it is not fixed: two freedoms for an anchor, four for a baseline", () => {
    const read = DxfReader.read(dxf([
      0, "TEXT", 8, "0", 7, "NOTES", 10, 5, 20, 5, 40, 3, 1, "PLATE",
      0, "TEXT", 8, "0", 7, "NOTES", 10, 35, 20, 5, 40, 3, 50, 90, 1, "SIDE",
    ]));
    const plan = planOf(read.texts);
    const made = sketch("xy", () => draw(plan)) as any;
    const solver = render().getRenderedObjects().find((o) => o.id === made.id)!.object.solver;
    expect(solver.dof).toBe(6);
  });
});
