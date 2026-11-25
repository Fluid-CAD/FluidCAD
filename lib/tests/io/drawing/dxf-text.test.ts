import { describe, it, expect } from "vitest";
import { DxfReader } from "../../../io/drawing/dxf-reader.js";
import { DxfMText } from "../../../io/drawing/dxf-mtext.js";
import type { ImportedText } from "../../../io/drawing/imported-text.js";

// The text of a DXF as the reader hands it on: where the file places it,
// how large, in which font — and, for what a sketch text cannot be, why.

type Groups = (string | number)[];

function dxf(parts: { tables?: Groups; blocks?: Groups; entities?: Groups }): string {
  const section = (name: string, groups: Groups | undefined): Groups =>
    groups ? [0, "SECTION", 2, name, ...groups, 0, "ENDSEC"] : [];
  return [
    ...section("TABLES", parts.tables),
    ...section("BLOCKS", parts.blocks),
    ...section("ENTITIES", parts.entities ?? []),
    0, "EOF",
  ].map(String).join("\n");
}

/** A style table: each style a name, a font file, and whatever else follows. */
const styles = (...entries: Groups[]): Groups => [0, "TABLE", 2, "STYLE", ...entries.flat(), 0, "ENDTAB"];
const style = (name: string, file: string, more: Groups = []): Groups => [0, "STYLE", 2, name, 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 3, file, 4, "", ...more];
/** What AutoCAD writes after a TrueType style: the family, and its weight and slant in a number. */
const truetype = (family: string, flags = 0): Groups => [1001, "ACAD", 1000, family, 1071, flags];
const ARIAL = styles(style("NOTES", "arial.ttf", truetype("Arial", 34)));

const textsOf = (parts: Parameters<typeof dxf>[0]): ImportedText[] => DxfReader.read(dxf(parts)).texts;
const only = (parts: Parameters<typeof dxf>[0]): ImportedText => {
  const texts = textsOf(parts);
  expect(texts).toHaveLength(1);
  return texts[0];
};
const text = (more: Groups = [], content = "PLATE A"): Groups => [0, "TEXT", 8, "NOTES", 7, "NOTES", 10, 30, 20, 20, 40, 5, 1, content, ...more];

describe("DxfReader: TEXT", () => {
  it("reads a text as text, on its layer, by its first point and the height of its capitals: not left out", () => {
    const read = DxfReader.read(dxf({ tables: ARIAL, entities: [...text(), 0, "LINE", 8, "0", 10, 0, 20, 0, 11, 1, 21, 0] }));
    expect(read.texts).toEqual([{
      layer: 'NOTES',
      lines: ['PLATE A'],
      at: { x: 30, y: 20 },
      angle: 0,
      align: 'left',
      rise: 0,
      size: { capital: 5 },
      letterSpacing: 0,
      font: { families: ['Arial'], bold: false, italic: false },
    }]);
    expect(read.skipped).toEqual({});
    expect(read.layers).toEqual([{ name: 'NOTES', count: 1, hidden: false }, { name: '0', count: 1, hidden: false }]);
  });

  it("places a justified text by its second point: an end of a line of it, at its baseline, its middle or its top", () => {
    const justified = (horizontal: number, vertical: number) => only({ tables: ARIAL, entities: text([72, horizontal, 73, vertical, 11, 80, 21, 40]) });
    expect(justified(1, 0)).toMatchObject({ at: { x: 80, y: 40 }, align: 'center', rise: 0 });
    expect(justified(2, 0)).toMatchObject({ at: { x: 80, y: 40 }, align: 'right', rise: 0 });
    expect(justified(0, 2)).toMatchObject({ at: { x: 80, y: 40 }, align: 'left', rise: 0.5 });
    expect(justified(1, 3)).toMatchObject({ at: { x: 80, y: 40 }, align: 'center', rise: 1 });
    expect(justified(1, 3).issue).toBeUndefined();
  });

  it("marks a text placed by its whole extent or its bottom line: Aligned, Middle, Fit, Bottom", () => {
    for (const [horizontal, vertical] of [[3, 0], [4, 0], [5, 0], [0, 1], [1, 1]]) {
      expect(only({ tables: ARIAL, entities: text([72, horizontal, 73, vertical, 11, 80, 21, 40]) }).issue).toBe('placement');
    }
  });

  it("reads the angle in degrees", () => {
    expect(only({ tables: ARIAL, entities: text([50, 90]) }).angle).toBeCloseTo(Math.PI / 2, 12);
  });

  it("marks letters that are stretched, slanted, backwards or upside down", () => {
    expect(only({ tables: ARIAL, entities: text([41, 0.8]) }).issue).toBe('shape');
    expect(only({ tables: ARIAL, entities: text([51, 15]) }).issue).toBe('shape');
    expect(only({ tables: ARIAL, entities: text([71, 2]) }).issue).toBe('shape');
    expect(only({ tables: ARIAL, entities: text([71, 4]) }).issue).toBe('shape');
    expect(only({ tables: ARIAL, entities: text([41, 1, 51, 0, 71, 0]) }).issue).toBeUndefined();
  });

  it("marks a text on a plane that is flipped over or tilted", () => {
    expect(only({ tables: ARIAL, entities: text([210, 0, 220, 0, 230, -1]) }).issue).toBe('shape');
    expect(only({ tables: ARIAL, entities: text([210, 0, 220, 0.6, 230, 0.8]) }).issue).toBe('shape');
  });

  it("writes the characters a text's codes stand for, and drops the ones that underline", () => {
    expect(only({ tables: ARIAL, entities: text([], "%%c12 %%p0.1 45%%d %%uNOTE%%u 50%%% \\U+00B5m %%065") }).lines)
      .toEqual(['Ø12 ±0.1 45° NOTE 50% µm A']);
  });

  it("leaves out a text that draws nothing", () => {
    expect(textsOf({ tables: ARIAL, entities: [...text([], "   "), 0, "TEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 0, 1, "no height"] })).toEqual([]);
  });
});

describe("DxfReader: the font of a text", () => {
  const fontOf = (table: Groups, more: Groups = []) => only({ tables: table, entities: text(more) }).font;

  it("takes the family, weight and slant AutoCAD writes with a TrueType style", () => {
    expect(fontOf(styles(style("NOTES", "arial.ttf", truetype("Arial", 0x2000000 | 34))))).toEqual({ families: ['Arial'], bold: true, italic: false });
    expect(fontOf(styles(style("NOTES", "whatever.ttf", truetype("ISOCPEUR", 0x1000000 | 34))))).toEqual({ families: ['ISOCPEUR'], bold: false, italic: true });
  });

  it("tells the family from the font file's name when the style says no more", () => {
    expect(fontOf(styles(style("NOTES", "arialbd.ttf")))).toEqual({ families: ['Arial'], bold: true, italic: false });
    expect(fontOf(styles(style("NOTES", "C:\\Windows\\Fonts\\TIMESI.TTF")))).toEqual({ families: ['Times New Roman'], bold: false, italic: true });
    expect(fontOf(styles(style("NOTES", "isocpeur.ttf")))).toEqual({ families: ['isocpeur'], bold: false, italic: false });
  });

  it("has no family for a pen font, a style the file does not define, or no style at all", () => {
    expect(fontOf(styles(style("NOTES", "txt")))).toEqual({ families: [], bold: false, italic: false });
    expect(fontOf(styles(style("NOTES", "romans.shx")))).toEqual({ families: [], bold: false, italic: false });
    expect(fontOf(styles(style("OTHER", "arial.ttf")))).toEqual({ families: [], bold: false, italic: false });
    expect(only({ entities: [0, "TEXT", 8, "0", 10, 0, 20, 0, 40, 2, 1, "hello"] }).font.families).toEqual([]);
  });

  it("uses the STANDARD style for a text that names none", () => {
    const read = only({ tables: styles(style("Standard", "arial.ttf")), entities: [0, "TEXT", 8, "0", 10, 0, 20, 0, 40, 2, 1, "hello"] });
    expect(read.font.families).toEqual(['Arial']);
  });

  it("marks every text of a style that stretches, slants or stacks its letters", () => {
    const stretched = styles([0, "STYLE", 2, "NOTES", 70, 0, 41, 0.8, 50, 0, 3, "arial.ttf"]);
    const slanted = styles([0, "STYLE", 2, "NOTES", 70, 0, 41, 1, 50, 15, 3, "arial.ttf"]);
    const stacked = styles([0, "STYLE", 2, "NOTES", 70, 4, 41, 1, 50, 0, 3, "arial.ttf"]);
    for (const table of [stretched, slanted, stacked]) {
      // The text itself says nothing: an MTEXT has only its style to go by.
      expect(only({ tables: table, entities: [0, "MTEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 3, 71, 1, 1, "note"] }).issue).toBe('shape');
    }
  });
});

describe("DxfReader: text in blocks", () => {
  const block = (name: string, groups: Groups, base: [number, number] = [0, 0]): Groups =>
    [0, "BLOCK", 8, "0", 2, name, 70, 0, 10, base[0], 20, base[1], ...groups, 0, "ENDBLK"];
  const LABEL = block("LABEL", [0, "TEXT", 8, "0", 7, "NOTES", 10, 2, 20, 0, 40, 3, 1, "A1"]);

  it("moves, turns and scales a block's text with its reference, on the reference's layer", () => {
    const read = only({ tables: ARIAL, blocks: LABEL, entities: [0, "INSERT", 8, "TAGS", 2, "LABEL", 10, 10, 20, 20, 41, 2, 42, 2, 50, 90] });
    expect(read.layer).toBe('TAGS');
    expect(read.at.x).toBeCloseTo(10, 9);
    expect(read.at.y).toBeCloseTo(24, 9);
    expect(read.angle).toBeCloseTo(Math.PI / 2, 12);
    expect(read.size).toEqual({ capital: 6 });
    expect(read.issue).toBeUndefined();
  });

  it("marks a text its reference stretches or mirrors, which no sketch text can follow", () => {
    expect(only({ tables: ARIAL, blocks: LABEL, entities: [0, "INSERT", 8, "0", 2, "LABEL", 10, 0, 20, 0, 41, 2, 42, 1] }).issue).toBe('shape');
    expect(only({ tables: ARIAL, blocks: LABEL, entities: [0, "INSERT", 8, "0", 2, "LABEL", 10, 0, 20, 0, 41, -1, 42, 1] }).issue).toBe('shape');
    // Mirrored both ways is a half turn.
    const turned = only({ tables: ARIAL, blocks: LABEL, entities: [0, "INSERT", 8, "0", 2, "LABEL", 10, 0, 20, 0, 41, -1, 42, -1] });
    expect(turned.issue).toBeUndefined();
    expect(Math.abs(turned.angle)).toBeCloseTo(Math.PI, 12);
  });

  it("reads the attribute values of a reference as text where they show, and neither an invisible one nor a definition", () => {
    const read = DxfReader.read(dxf({
      tables: ARIAL,
      blocks: block("TAG", [0, "ATTDEF", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 3, 1, "default", 3, "Number?", 2, "NO"]),
      entities: [
        0, "INSERT", 8, "TAGS", 66, 1, 2, "TAG", 10, 50, 20, 50,
        0, "ATTRIB", 8, "0", 7, "NOTES", 10, 50, 20, 50, 40, 3, 1, "B-12", 2, "NO", 70, 0, 72, 1, 74, 2, 11, 55, 21, 51.5,
        0, "ATTRIB", 8, "0", 7, "NOTES", 10, 50, 20, 40, 40, 3, 1, "hidden", 2, "ID", 70, 1,
        0, "SEQEND", 8, "TAGS",
      ],
    }));
    expect(read.texts).toHaveLength(1);
    // An attribute keeps its vertical justification under 74.
    expect(read.texts[0]).toMatchObject({ lines: ['B-12'], at: { x: 55, y: 51.5 }, align: 'center', rise: 0.5, size: { capital: 3 } });
    expect(read.skipped).toEqual({});
  });
});

describe("DxfReader: MTEXT", () => {
  const mtext = (content: string, more: Groups = [], attachment = 1): Groups =>
    [0, "MTEXT", 8, "NOTES", 7, "NOTES", 10, 10, 20, 50, 40, 4, 71, attachment, 1, content, ...more];

  it("reads its paragraphs as lines, placed by the top of the first one's capitals, five thirds of the height apart", () => {
    const read = only({ tables: ARIAL, entities: mtext("FIRST LINE\\PSECOND") });
    expect(read).toEqual({
      layer: 'NOTES',
      lines: ['FIRST LINE', 'SECOND'],
      at: { x: 10, y: 50 },
      angle: 0,
      align: 'left',
      rise: 1,
      size: { capital: 4 },
      lineAdvance: 4 * (5 / 3),
      letterSpacing: 0,
      font: { families: ['Arial'], bold: false, italic: false },
    });
  });

  it("joins a long content from its pieces, and takes the line spacing factor", () => {
    const read = only({ tables: ARIAL, entities: [0, "MTEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 2, 71, 1, 44, 1.5, 3, "ONE ", 3, "TWO\\P", 1, "THREE"] });
    expect(read.lines).toEqual(['ONE TWO', 'THREE']);
    expect(read.lineAdvance).toBeCloseTo(2 * (5 / 3) * 1.5, 12);
  });

  it("takes the attachment's side, and marks one attached by its middle or bottom", () => {
    expect(only({ tables: ARIAL, entities: mtext("A", [], 2) })).toMatchObject({ align: 'center', rise: 1 });
    expect(only({ tables: ARIAL, entities: mtext("A", [], 3) }).align).toBe('right');
    expect(only({ tables: ARIAL, entities: mtext("A", [], 3) }).issue).toBeUndefined();
    for (const attachment of [4, 5, 6, 7, 8, 9]) {
      expect(only({ tables: ARIAL, entities: [0, "MTEXT", 8, "0", 7, "NOTES", 10, 0, 20, 0, 40, 4, 71, attachment, 1, "A"] }).issue).toBe('placement');
    }
  });

  it("reads the angle from its rotation in radians, or from its direction, whichever comes last", () => {
    expect(only({ tables: ARIAL, entities: mtext("A", [50, Math.PI / 6]) }).angle).toBeCloseTo(Math.PI / 6, 12);
    expect(only({ tables: ARIAL, entities: mtext("A", [11, 0, 21, 1, 31, 0]) }).angle).toBeCloseTo(Math.PI / 2, 12);
    expect(only({ tables: ARIAL, entities: mtext("A", [11, 0, 21, 1, 31, 0, 50, 0.25]) }).angle).toBeCloseTo(0.25, 12);
  });

  it("keeps the width of the box it wraps in, for whoever knows how wide the text is", () => {
    expect(only({ tables: ARIAL, entities: mtext("A", [41, 60]) }).boxWidth).toBe(60);
    expect(only({ tables: ARIAL, entities: mtext("A", [41, 0]) }).boxWidth).toBeUndefined();
  });

  it("takes a font and a height the whole text is written in from its codes", () => {
    const read = only({ tables: ARIAL, entities: mtext("{\\fTimes New Roman|b1|i0|c0|p18;\\H2.5;NOTE 1\\PNOTE 2}") });
    expect(read.font).toEqual({ families: ['Times New Roman'], bold: true, italic: false });
    expect(read.size).toEqual({ capital: 2.5 });
    expect(read.lineAdvance).toBeCloseTo(2.5 * (5 / 3), 12);
    expect(read.issue).toBeUndefined();
  });

  it("marks a text that is not written one way throughout, and one set top to bottom", () => {
    expect(only({ tables: ARIAL, entities: mtext("plain {\\fArial|b1;bold} plain") }).issue).toBe('format');
    expect(only({ tables: ARIAL, entities: mtext("1\\S1/2;") }).issue).toBe('format');
    expect(only({ tables: ARIAL, entities: mtext("A", [72, 3]) }).issue).toBe('format');
    expect(only({ tables: ARIAL, entities: mtext("\\W0.8;narrow") }).issue).toBe('shape');
  });

  it("scales a block's multi-line text, its line distance and its box with the reference", () => {
    const read = only({
      tables: ARIAL,
      blocks: [0, "BLOCK", 8, "0", 2, "NOTE", 70, 0, 10, 0, 20, 0, ...mtext("A\\PB", [41, 30]), 0, "ENDBLK"],
      entities: [0, "INSERT", 8, "0", 2, "NOTE", 10, 0, 20, 0, 41, 3, 42, 3],
    });
    expect(read.size).toEqual({ capital: 12 });
    expect(read.lineAdvance).toBeCloseTo(20, 12);
    expect(read.boxWidth).toBeCloseTo(90, 12);
    expect(read.at).toEqual({ x: 30, y: 150 });
  });
});

describe("DxfMText.parse", () => {
  const plain = (content: string) => DxfMText.parse(content);

  it("breaks lines at \\P and ^J, and drops the spaces a paragraph ends with", () => {
    expect(plain("ONE \\PTWO^JTHREE\\P").lines).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it("writes escaped characters, special codes and characters by number", () => {
    expect(plain("a\\\\b \\{c\\} 10\\~mm %%c5 %%D %%p \\U+03A9 %%%").lines).toEqual(['a\\b {c} 10 mm Ø5 ° ± Ω %']);
  });

  it("drops what changes no letter: underline, overline, strike-through, colour, alignment in the line", () => {
    const read = plain("\\LUNDER\\l \\OOVER\\o \\KSTRIKE\\k \\C1;RED \\c255;TRUE \\A1;MID");
    expect(read.lines).toEqual(['UNDER OVER STRIKE RED TRUE MID']);
    expect(read.mixed).toBe(false);
    expect(read.distorted).toBe(false);
  });

  it("gives the font and the height every letter is under", () => {
    expect(plain("\\fArial|b0|i1|c0|p34;\\H3.5;ALL OF IT")).toMatchObject({ font: { family: 'Arial', bold: false, italic: true }, height: 3.5, heightFactor: 1, mixed: false });
    expect(plain("\\H1.5x;ALL OF IT")).toMatchObject({ heightFactor: 1.5, mixed: false });
    expect(plain("ALL OF IT").font).toBeUndefined();
    expect(plain("ALL OF IT").height).toBeUndefined();
  });

  it("is mixed when the font, the height or the tracking changes part-way, and not when a code repeats what is in force", () => {
    expect(plain("small \\H5;LARGE").mixed).toBe(true);
    expect(plain("one {\\fArial|b1;two}").mixed).toBe(true);
    expect(plain("\\T1.5;spaced").mixed).toBe(true);
    expect(plain("{\\fArial|b0|i0;one }{\\fArial|b0|i0;two}").mixed).toBe(false);
    expect(plain("{\\fArial|b0|i0;one }{\\fArial|b0|i0;two}").lines).toEqual(['one two']);
  });

  it("is mixed for stacked fractions, tabs, columns and paragraphs with their own indent or alignment", () => {
    expect(plain("1\\S1#2;").mixed).toBe(true);
    expect(plain("A^IB").mixed).toBe(true);
    expect(plain("A\\NB").mixed).toBe(true);
    expect(plain("\\pxqc;centred").mixed).toBe(true);
    expect(plain("\\pi2,l4;indented").mixed).toBe(true);
    expect(plain("\\pxql;plain").mixed).toBe(false);
    expect(plain("\\pi0,l0;plain").mixed).toBe(false);
  });

  it("notes a width factor or a slant anywhere in the text", () => {
    expect(plain("\\W0.7;narrow").distorted).toBe(true);
    expect(plain("\\Q15;slanted").distorted).toBe(true);
    expect(plain("\\W1;\\Q0;plain").distorted).toBe(false);
  });

  it("reads a TEXT's own codes without taking its backslashes for anything", () => {
    expect(DxfMText.plain("C:\\PARTS\\P1 %%c8")).toBe('C:\\PARTS\\P1 Ø8');
  });
});
