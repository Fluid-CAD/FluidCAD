import { describe, it, expect } from "vitest";
import { SvgReader } from "../../../io/drawing/svg-reader.js";
import type { ImportedText } from "../../../io/drawing/imported-text.js";

// The <text> of an SVG as the reader hands it on: the start of each line's
// baseline, the em, the fonts asked for — and, for what a sketch text
// cannot be, why.

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** A 100 × 100 page, one unit a pixel: a point at SVG (x, y) is read at (x, 100 − y). */
function page(body: string, attributes = 'width="100" height="100" viewBox="0 0 100 100"'): string {
  return `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ${attributes}>${body}</svg>`;
}
const textsOf = (body: string, attributes?: string): ImportedText[] => SvgReader.read(page(body, attributes)).texts;
const only = (body: string, attributes?: string): ImportedText => {
  const texts = textsOf(body, attributes);
  expect(texts).toHaveLength(1);
  return texts[0];
};

describe("SvgReader: text", () => {
  it("reads a text as text, by the start of its baseline, with its em and its fonts: not left out", () => {
    const read = SvgReader.read(page('<text x="10" y="30" font-family="\'Open Sans\', Arial, sans-serif" font-size="8">Plate A</text>'));
    expect(read.texts).toEqual([{
      layer: '(no layer)',
      lines: ['Plate A'],
      at: { x: 10, y: 70 },
      angle: 0,
      align: 'left',
      rise: 0,
      size: { em: 8 },
      letterSpacing: 0,
      font: { families: ['Open Sans', 'Arial', 'sans-serif'], bold: false, italic: false },
    }]);
    expect(read.skipped).toEqual({});
    expect(read.layers).toEqual([{ name: '(no layer)', count: 1, hidden: false }]);
  });

  it("starts at the origin with a medium font of no particular family when the file says nothing", () => {
    expect(only('<text>plain</text>')).toMatchObject({ at: { x: 0, y: 100 }, size: { em: 16 }, font: { families: ['sans-serif'] } });
  });

  it("takes text-anchor as the end of the line the point is, and weight and style as bold and italic", () => {
    expect(only('<text x="50" y="50" text-anchor="middle">A</text>').align).toBe('center');
    expect(only('<text x="50" y="50" style="text-anchor:end">A</text>').align).toBe('right');
    expect(only('<text font-weight="bold" font-style="italic">A</text>').font).toMatchObject({ bold: true, italic: true });
    expect(only('<text font-weight="700">A</text>').font.bold).toBe(true);
    expect(only('<text font-weight="500" font-style="normal">A</text>').font).toMatchObject({ bold: false, italic: false });
  });

  it("inherits what a group, a style sheet or the root sets, and resolves sizes relative to it", () => {
    const read = only(`<style>.note { font-family: Georgia, serif; font-size: 10px } .big { font-size: 150% }</style>
      <g class="note" font-weight="bold"><g letter-spacing="0.1em"><text class="big" x="5" y="5">A</text></g></g>`);
    expect(read.font).toEqual({ families: ['Georgia', 'serif'], bold: true, italic: false });
    expect(read.size).toEqual({ em: 15 });
    // An em of letter spacing set where the font is 10: one unit, inherited as that.
    expect(read.letterSpacing).toBeCloseTo(1, 12);
  });

  it("reads the font shorthand, as a plotting program writes it", () => {
    const read = only('<text x="5" y="5" style="font: italic bold 12px/14px \'DejaVu Sans\', sans-serif; text-anchor: middle">A</text>');
    expect(read.font).toEqual({ families: ['DejaVu Sans', 'sans-serif'], bold: true, italic: true });
    expect(read.size).toEqual({ em: 12 });
    expect(read.align).toBe('center');
  });

  it("takes sizes in physical units by the page's own measure", () => {
    // A page of 100 units for 100 mm: a 10pt font is 10/72 inch, 3.5278 mm.
    const read = only('<text x="5" y="5" font-size="10pt">A</text>', 'width="100mm" height="100mm" viewBox="0 0 100 100"');
    expect((read.size as { em: number }).em).toBeCloseTo(10 * 96 / 72, 9);
  });

  it("collapses white space the way a browser does, and keeps it when asked to", () => {
    expect(only('<text>\n   two   words\n   more  </text>').lines).toEqual(['two words more']);
    expect(only('<text>  a <tspan> b </tspan> c  </text>').lines).toEqual(['a b c']);
    expect(only('<text xml:space="preserve">  two   words </text>').lines).toEqual(['  two   words ']);
  });

  it("reads character references and CDATA as the characters they are", () => {
    expect(only('<text>&#216;12 &amp; <![CDATA[<5>]]></text>').lines).toEqual(['Ø12 & <5>']);
  });

  it("leaves out text that draws nothing, is not displayed or is not painted", () => {
    expect(textsOf('<text>   </text><text display="none">A</text><g display="none"><text>B</text></g>')).toEqual([]);
    expect(textsOf('<text fill="none">outline of nothing</text><text visibility="hidden">C</text>')).toEqual([]);
    expect(textsOf('<text fill="none" stroke="#000">outlined</text>')).toHaveLength(1);
  });
});

describe("SvgReader: text in pieces", () => {
  it("reads each line a drawing program wrote as a tspan with its own place as a text of its own", () => {
    // What Inkscape writes for two lines.
    const texts = textsOf(`<text xml:space="preserve" style="font-size:6px;font-family:Arial" x="10" y="20"><tspan
      x="10" y="20">First line</tspan><tspan x="10" y="27.5">Second</tspan></text>`);
    expect(texts.map((text) => [text.lines[0], text.at.x, text.at.y])).toEqual([['First line', 10, 80], ['Second', 10, 72.5]]);
    expect(texts.every((text) => text.issue === undefined && (text.size as { em: number }).em === 6)).toBe(true);
  });

  it("follows a line break written as an x with a dy", () => {
    const texts = textsOf('<text x="10" y="20" font-size="10">one<tspan x="10" dy="1.2em">two</tspan><tspan x="10" dy="12">three</tspan></text>');
    expect(texts.map((text) => [text.lines[0], text.at.y])).toEqual([['one', 80], ['two', 68], ['three', 56]]);
  });

  it("moves a text's start by a dx or dy that comes before its first letter", () => {
    expect(only('<text x="10" y="20" dx="5" dy="-2">A</text>').at).toEqual({ x: 15, y: 82 });
  });

  it("keeps a span that changes nothing about the letters in its line", () => {
    const read = only('<text x="10" y="20">Order <tspan fill="red">12</tspan> of 40</text>');
    expect(read.lines).toEqual(['Order 12 of 40']);
    expect(read.issue).toBeUndefined();
  });

  it("marks a line that changes font, size or weight part-way, or shifts from where its letters ended", () => {
    expect(only('<text>plain <tspan font-weight="bold">bold</tspan></text>').issue).toBe('format');
    expect(only('<text>x<tspan font-size="8">2</tspan></text>').issue).toBe('format');
    expect(only('<text>H<tspan dy="3">2</tspan>O</text>').issue).toBe('format');
    expect(only('<text>a<tspan dx="4">b</tspan></text>').issue).toBe('format');
    expect(only('<text>a<tspan baseline-shift="super">2</tspan></text>').issue).toBe('format');
  });

  it("marks letters placed one by one, as a file converted from a PDF has them", () => {
    expect(only('<text x="10 16.2 21.9 28" y="20">Text</text>').issue).toBe('glyphs');
    expect(only('<text y="20"><tspan x="10 16.2 21.9 28">Text</tspan></text>').issue).toBe('glyphs');
    expect(only('<text x="10" y="20" dx="0 1 1 1">Text</text>').issue).toBe('glyphs');
    expect(only('<text x="10" y="20" rotate="15">Text</text>').issue).toBe('glyphs');
    expect(only('<text x="10" y="20" rotate="0">Text</text>').issue).toBeUndefined();
  });

  it("marks text on a path, and what a sketch text has no word for", () => {
    expect(textsOf('<path id="p" d="M0 0 H50" fill="none" stroke="#000"/><text><textPath xlink:href="#p">along</textPath></text>')).toEqual([]);
    expect(only('<text>before <textPath xlink:href="#p">along</textPath></text>').issue).toBe('path');
    expect(only('<text writing-mode="tb">down</text>').issue).toBe('format');
    expect(only('<text style="writing-mode: vertical-rl">down</text>').issue).toBe('format');
    expect(only('<text direction="rtl">A</text>').issue).toBe('format');
    expect(only('<text textLength="80">fitted</text>').issue).toBe('format');
    expect(only('<text word-spacing="4">two words</text>').issue).toBe('format');
    expect(only('<text dominant-baseline="middle">A</text>').issue).toBe('format');
    expect(only('<text font-variant="small-caps">A</text>').issue).toBe('format');
    expect(only('<text dominant-baseline="auto" word-spacing="0" writing-mode="lr-tb">A</text>').issue).toBeUndefined();
  });
});

describe("SvgReader: text under transforms", () => {
  it("works a move, a turn and a scale into where the text stands, how it is turned and how large it is", () => {
    // Turned a quarter turn clockwise on the page (Y down): it reads downwards, which is −90° with Y up.
    const read = only('<g transform="translate(50 50) rotate(90) scale(2)"><text x="5" y="0" font-size="6" letter-spacing="1">A</text></g>');
    expect(read.at.x).toBeCloseTo(50, 9);
    expect(read.at.y).toBeCloseTo(40, 9);
    expect(read.angle).toBeCloseTo(-Math.PI / 2, 12);
    expect((read.size as { em: number }).em).toBeCloseTo(12, 12);
    expect(read.letterSpacing).toBeCloseTo(2, 12);
    expect(read.issue).toBeUndefined();
  });

  it("reads a text that is upright on the page as level in the drawing: turning the page over mirrors nothing", () => {
    expect(only('<text x="10" y="20" transform="rotate(-30 10 20)">A</text>').angle).toBeCloseTo(Math.PI / 6, 12);
    expect(only('<text x="10" y="20">A</text>').angle).toBe(0);
  });

  it("scales with the page's view box", () => {
    // 200 units drawn on a 100-unit page keep their own numbers: the drawing is in view box units.
    const read = only('<text x="20" y="40" font-size="10">A</text>', 'width="100" height="100" viewBox="0 0 200 200"');
    expect(read.at).toEqual({ x: 20, y: 160 });
    expect(read.size).toEqual({ em: 10 });
  });

  it("marks a text that is stretched, skewed or mirrored", () => {
    expect(only('<text transform="scale(2 1)">A</text>').issue).toBe('shape');
    expect(only('<text transform="skewX(20)">A</text>').issue).toBe('shape');
    expect(only('<text transform="scale(-1 1)">A</text>').issue).toBe('shape');
    expect(only('<text transform="scale(-1 -1)">A</text>').issue).toBeUndefined();
  });

  it("draws a text again where a reference puts it, inheriting from the reference", () => {
    const texts = textsOf(`<defs><text id="tag" x="2" y="0" font-size="5">TAG</text></defs>
      <use xlink:href="#tag" x="10" y="10" font-family="Arial"/><use xlink:href="#tag" transform="translate(60 60) rotate(-90)" font-weight="bold"/>`);
    expect(texts.map((text) => text.at.x)).toEqual([12, 60]);
    expect(texts[0].font).toEqual({ families: ['Arial'], bold: false, italic: false });
    expect(texts[1].font.bold).toBe(true);
    expect(texts[1].angle).toBeCloseTo(Math.PI / 2, 12);
  });

  it("puts text on the layer it is in, hidden with it", () => {
    const read = SvgReader.read(page(`<g inkscape:groupmode="layer" inkscape:label="Notes" style="display:none"><text x="1" y="1">note</text></g>
      <g inkscape:groupmode="layer" inkscape:label="Art"><text x="1" y="9">art</text><rect width="5" height="5"/></g>`));
    expect(read.texts.map((text) => text.layer)).toEqual(['Notes', 'Art']);
    expect(read.layers).toEqual([{ name: 'Art', count: 5, hidden: false }, { name: 'Notes', count: 1, hidden: true }]);
  });
});
