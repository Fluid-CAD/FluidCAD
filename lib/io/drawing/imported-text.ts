import type { DrawingBounds, Vec2 } from "./drawing.js";
import { Affine, type Affine2 } from "./affine.js";

// Text of an imported file, on its way to a sketch's `text()` statement.
//
// A file says where a text is and how large in its own terms — a DXF the
// height of a capital letter, an SVG the font's em — and names a font. A
// sketch text is an em size, a font that is installed where the sketch is
// built, and the point its first baseline starts from. Getting from one to
// the other takes the font's own measurements, which only the machine that
// has the font can give: a reader returns `ImportedText`s, whoever imports
// has their fonts measured (`FontMeasure`), and `ImportedTexts.resolve`
// turns the two into a text a sketch can write — or says why it cannot.

/** The font a text asks for. */
export type TextFont = {
  /**
   * Family names, most wanted first: the first that is installed counts. A
   * generic CSS name (`serif`, `sans-serif`, `monospace`) stands for any
   * font of that kind. Empty for a font that has no outlines to install: an
   * AutoCAD pen font (SHX).
   */
  families: string[];
  bold: boolean;
  italic: boolean;
};

/**
 * Why a text of the file cannot be a sketch text, whatever fonts are
 * installed:
 *
 * - `shape` — its letters are stretched, slanted or mirrored;
 * - `placement` — the file places it by something only its own font's
 *   letters decide: fitted between two points, by its full extent, or by
 *   its bottom line;
 * - `format` — it changes font, size or spacing part-way, stacks
 *   fractions, uses tabs or columns, or runs top to bottom;
 * - `glyphs` — the file places its letters one by one;
 * - `path` — it follows a curve.
 */
export type TextIssue = 'shape' | 'placement' | 'format' | 'glyphs' | 'path';

/** One text of an imported file, in the file's coordinates and unit. */
export type ImportedText = {
  /** The layer the file put it on; null outside any layer. */
  layer: string | null;
  /** Its lines, as they are to be drawn: already broken, escapes resolved. */
  lines: string[];
  /** The point the file places it by. */
  at: Vec2;
  /** The way its baseline runs: radians, counter-clockwise from the X axis. */
  angle: number;
  /** Which end of each line `at` is: its start, its middle, its end. */
  align: 'left' | 'center' | 'right';
  /** How far above the first line's baseline `at` is, in capital heights: 0 on the baseline, 1 at the top of the capitals. */
  rise: number;
  /** Its size as the file gives it: the height of a capital letter, or the font's em. */
  size: { capital: number } | { em: number };
  /** From one line's baseline to the next; absent for the font's own line height. */
  lineAdvance?: number;
  /** Added between letters. */
  letterSpacing: number;
  /** The width of the box the file wraps the text in; absent when it wraps in none. */
  boxWidth?: number;
  font: TextFont;
  /** Why it cannot be a sketch text; absent when nothing in the file stands in the way. */
  issue?: TextIssue;
};

/** What is asked of the machine that has the fonts, for one text: which font, and how wide each line is in it. */
export type FontMeasureRequest = TextFont & { lines: string[] };

/**
 * A font as it measures where the sketch is built. Lengths are shares of
 * the em.
 */
export type FontMeasure = {
  /** The installed family the request came to; null when none of the families asked for is installed in that weight and style. */
  family: string | null;
  /** The family is not the first one asked for by name: a font made to the same letter widths, or the pick for a generic name. */
  substituted: boolean;
  /** The height of a flat capital (an H). */
  capital: number;
  /** Above the baseline, and below it (a depth: positive). */
  ascent: number;
  descent: number;
  /** Extra room the font asks for between lines. */
  lineGap: number;
  /** How far each requested line advances, in order. */
  advances: number[];
};

/** Why a text is left out once the fonts are known: the file's own reason, no installed font, or a line that would wrap. */
export type TextRefusal = TextIssue | 'font' | 'wrap';

/** A text ready for a sketch, still in the file's coordinates and unit. */
export type ResolvedText = {
  /** The lines, joined by newlines. */
  text: string;
  /** The installed family it is written with. */
  font: string;
  /** The family the file asked for first, when `font` stands in for it. */
  standsFor: string | null;
  bold: boolean;
  italic: boolean;
  /** The em size. */
  size: number;
  align: 'left' | 'center' | 'right';
  /** The multiple of the font's own line height the lines are set at. */
  lineSpacing: number;
  letterSpacing: number;
  /** Where the first baseline starts (or is centred, or ends: see `align`). */
  at: Vec2;
  /** Radians, counter-clockwise. */
  angle: number;
  /** The height of its capitals, the distance between its baselines, and the width of each line: what a preview draws. */
  capital: number;
  lineAdvance: number;
  widths: number[];
};

/** A wrapping box is taken as wide enough when the text is at most this share of it: under it, nothing wraps whatever the rounding. */
const FITS_BOX = 0.98;

export class ImportedTexts {
  /** What to have measured for `text`. */
  static request(text: ImportedText): FontMeasureRequest {
    return { families: text.font.families, bold: text.font.bold, italic: text.font.italic, lines: text.lines };
  }

  /**
   * The sketch text `text` is, given how its font measures — or why it is
   * left out.
   *
   * A capital height becomes an em size by the font's own capital: the
   * measured height of its H, not a constant. The anchor goes down from the
   * file's point to the first baseline by `rise` capital heights, across
   * the baseline's direction. A line distance the file gives becomes the
   * multiple of the font's own line height that produces it.
   */
  static resolve(text: ImportedText, measure: FontMeasure | undefined): { text: ResolvedText } | { refused: TextRefusal } {
    if (text.issue) {
      return { refused: text.issue };
    }
    if (!measure || measure.family === null || !(measure.capital > 0)) {
      return { refused: 'font' };
    }
    const size = 'em' in text.size ? text.size.em : text.size.capital / measure.capital;
    const capital = size * measure.capital;
    if (!(size > 0) || !Number.isFinite(size)) {
      return { refused: 'shape' };
    }
    const widths = text.lines.map((line, i) => (measure.advances[i] ?? 0) * size + Math.max(0, [...line].length - 1) * text.letterSpacing);
    if (text.boxWidth !== undefined && widths.some((width) => width > text.boxWidth! * FITS_BOX)) {
      return { refused: 'wrap' };
    }
    const natural = (measure.ascent + measure.descent + measure.lineGap) * size;
    const lineAdvance = text.lineAdvance ?? natural;
    const up = { x: -Math.sin(text.angle), y: Math.cos(text.angle) };
    const drop = text.rise * capital;
    return {
      text: {
        text: text.lines.join('\n'),
        font: measure.family,
        standsFor: measure.substituted ? text.font.families[0] ?? null : null,
        bold: text.font.bold,
        italic: text.font.italic,
        size,
        align: text.align,
        lineSpacing: natural > 0 ? lineAdvance / natural : 1,
        letterSpacing: text.letterSpacing,
        at: { x: text.at.x - up.x * drop, y: text.at.y - up.y * drop },
        angle: text.angle,
        capital,
        lineAdvance,
        widths,
      },
    };
  }

  /**
   * A resolved text under `m`, which must be a move, a turn and one scale
   * for both axes — what placing a drawing in a sketch is.
   */
  static placed(text: ResolvedText, m: Affine2): ResolvedText {
    const scale = Math.hypot(m.a, m.b);
    return {
      ...text,
      size: text.size * scale,
      letterSpacing: text.letterSpacing * scale,
      at: Affine.point(m, text.at),
      angle: text.angle + Math.atan2(m.b, m.a),
      capital: text.capital * scale,
      lineAdvance: text.lineAdvance * scale,
      widths: text.widths.map((width) => width * scale),
    };
  }

  /** Where line `index` of a text starts and ends on its baseline. */
  static baseline(text: ResolvedText, index = 0): { a: Vec2; b: Vec2 } {
    const along = { x: Math.cos(text.angle), y: Math.sin(text.angle) };
    const down = index * text.lineAdvance;
    const origin = { x: text.at.x + along.y * down, y: text.at.y - along.x * down };
    const width = text.widths[index] ?? 0;
    const from = text.align === 'left' ? 0 : text.align === 'center' ? -width / 2 : -width;
    return {
      a: { x: origin.x + along.x * from, y: origin.y + along.y * from },
      b: { x: origin.x + along.x * (from + width), y: origin.y + along.y * (from + width) },
    };
  }

  /**
   * The box each line of a text fills, from its baseline to the top of its
   * capitals: four corners, counter-clockwise from the baseline's start.
   * What a preview draws where the text will land.
   */
  static boxes(text: ResolvedText): Vec2[][] {
    const up = { x: -Math.sin(text.angle) * text.capital, y: Math.cos(text.angle) * text.capital };
    return text.widths.map((_, index) => {
      const { a, b } = ImportedTexts.baseline(text, index);
      return [a, b, { x: b.x + up.x, y: b.y + up.y }, { x: a.x + up.x, y: a.y + up.y }];
    });
  }

  /** The bounds of the boxes of `texts`; null for none. */
  static bounds(texts: readonly ResolvedText[]): DrawingBounds | null {
    const box = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
    for (const text of texts) {
      for (const corner of ImportedTexts.boxes(text).flat()) {
        box.min.x = Math.min(box.min.x, corner.x);
        box.min.y = Math.min(box.min.y, corner.y);
        box.max.x = Math.max(box.max.x, corner.x);
        box.max.y = Math.max(box.max.y, corner.y);
      }
    }
    return Number.isFinite(box.min.x) ? box : null;
  }

  /**
   * What `m` does to a text's frame: the angle it turns the baseline to and
   * the one scale it applies — or null when it stretches, skews or mirrors
   * the letters, which no sketch text can follow.
   */
  static frameUnder(m: Affine2, angle: number): { angle: number; scale: number } | null {
    const along = Affine.vector(m, { x: Math.cos(angle), y: Math.sin(angle) });
    const across = Affine.vector(m, { x: -Math.sin(angle), y: Math.cos(angle) });
    const [su, sv] = [Math.hypot(along.x, along.y), Math.hypot(across.x, across.y)];
    const larger = Math.max(su, sv);
    if (!(larger > 0) || !Number.isFinite(larger)) {
      return null;
    }
    const square = Math.abs(along.x * across.x + along.y * across.y) <= su * sv * 1e-9;
    const upright = along.x * across.y - along.y * across.x > 0;
    if (Math.abs(su - sv) > larger * 1e-9 || !square || !upright) {
      return null;
    }
    return { angle: Math.atan2(along.y, along.x), scale: su };
  }
}
