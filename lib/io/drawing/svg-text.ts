import { Affine, type Affine2 } from "./affine.js";
import { ImportedTexts } from "./imported-text.js";
import type { ImportedText, TextIssue } from "./imported-text.js";
import { SvgValues } from "./svg-values.js";
import type { XmlElement } from "./xml.js";

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

/** What the reader lends for reading text: the cascade and its units. */
export type SvgTextHost = {
  /** The properties an element is given by its attributes, the style sheets and its `style`. */
  declared(element: XmlElement): ReadonlyMap<string, string>;
  /** User units per absolute unit: what `1mm` is in the file's coordinates. */
  units: Readonly<Record<string, number>>;
  /** The namespace the file's SVG elements are in. */
  namespace: string;
};

/** The text properties an element has, each inherited unless it declares its own. */
type Style = {
  families: string[];
  /** In user units. */
  size: number;
  bold: boolean;
  italic: boolean;
  anchor: 'left' | 'center' | 'right';
  /** In user units. */
  letterSpacing: number;
  /** White space is kept as written (`xml:space="preserve"`, `white-space: pre`). */
  preserve: boolean;
  /** Something a sketch text has no word for is set: why, by the issue it makes. */
  issue: TextIssue | null;
};

/** A stretch of characters written one way. */
type Run = { text: string; style: Style };

/** Characters placed from one point: what one sketch text can be. */
type Chunk = { x: number; y: number; runs: Run[] };

/** The size `medium` is, in CSS pixels, and the other keywords by their share of it. */
const MEDIUM = 16;
const SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9 / 16, 'x-small': 10 / 16, small: 13 / 16, medium: 1, large: 18 / 16, 'x-large': 24 / 16, 'xx-large': 2,
};

const START: Style = {
  families: [],
  size: MEDIUM,
  bold: false,
  italic: false,
  anchor: 'left',
  letterSpacing: 0,
  preserve: false,
  issue: null,
};

/**
 * The `<text>` of an SVG as texts a sketch may take.
 *
 * SVG places text by the start of its baseline: `x` and `y` on the element
 * are that point, and `text-anchor` says whether it is the start, the
 * middle or the end of the line. That is what a sketch text's anchor is,
 * so a line of text placed by one point comes in as it is: its
 * `font-size` is the em, its `font-family` list is searched for a font
 * that is installed, `font-weight` and `font-style` say bold and italic,
 * `letter-spacing` is the same thing. Properties are taken from where
 * they are set — attributes, a `style`, the style sheets, the `font`
 * shorthand — and inherited down to the letters.
 *
 * A `<tspan>` with an `x` of its own starts again from another point, the
 * way a drawing program writes each line of a paragraph: every such piece
 * is a text of its own. White space is collapsed the way a browser does,
 * unless `xml:space="preserve"` keeps it.
 *
 * Every transform above the text is worked into where it stands, how it is
 * turned and how large it is. One that stretches, skews or mirrors the
 * letters is marked `shape`.
 *
 * Marked instead of read, since a sketch text places a whole line and
 * writes it one way: letters placed one by one (a list of numbers in `x`,
 * `y`, `dx`, `dy`, or a `rotate`) are `glyphs` — what a file converted
 * from a PDF is made of; a `<textPath>` is `path`; a line that changes
 * font, size or weight part-way, a shift from where the letters before it
 * ended (`dx`, a `dy` or a `y` in mid-line), `textLength`, word spacing,
 * small capitals, a baseline moved off the letters' own
 * (`dominant-baseline`, `baseline-shift`), text set top to bottom or right
 * to left are `format`.
 */
export class SvgText {
  /**
   * The texts of one `<text>` element.
   *
   * @param lineage The elements its properties are inherited from, outermost first.
   * @param m The element's own coordinates → the drawing's.
   */
  static read(element: XmlElement, lineage: readonly XmlElement[], m: Affine2, layer: string | null, host: SvgTextHost): ImportedText[] {
    let style = START;
    for (const ancestor of lineage) {
      style = SvgText.styled(ancestor, style, host);
    }
    style = SvgText.styled(element, style, host);

    const origin = {
      x: SvgText.coordinates(element, 'x', style, host),
      y: SvgText.coordinates(element, 'y', style, host),
    };
    const chunks: Chunk[] = [{ x: origin.x[0] ?? 0, y: origin.y[0] ?? 0, runs: [] }];
    const state = { issue: style.issue, space: true };
    if (origin.x.length > 1 || origin.y.length > 1 || SvgText.shifts(element, style, host, chunks, false)) {
      state.issue = state.issue ?? 'glyphs';
    }
    SvgText.walk(element, style, host, chunks, state);

    // In the letters' own frame Y runs up; the element's runs down.
    const upright = Affine.compose({ a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 }, m);
    const frame = ImportedTexts.frameUnder(upright, 0);
    const texts: ImportedText[] = [];
    SvgText.trimEnd(chunks);
    for (const chunk of chunks) {
      const text = chunk.runs.map((run) => run.text).join('');
      if (text.trim() === '') {
        continue;
      }
      const drawn = chunk.runs.filter((run) => run.text.trim() !== '');
      const first = drawn[0].style;
      let issue = state.issue ?? drawn.map((run) => run.style.issue).find((found) => found !== null) ?? null;
      if (issue === null && drawn.some((run) => !SvgText.sameLetters(run.style, first))) {
        issue = 'format';
      }
      if (issue === null && !frame) {
        issue = 'shape';
      }
      const scale = frame?.scale ?? 1;
      texts.push({
        layer,
        lines: [text],
        at: Affine.point(m, { x: chunk.x, y: chunk.y }),
        angle: frame?.angle ?? 0,
        align: first.anchor,
        rise: 0,
        size: { em: first.size * scale },
        letterSpacing: first.letterSpacing * scale,
        // A text that names no font takes any: a sketch's own is a sans-serif.
        font: { families: first.families.length > 0 ? first.families : ['sans-serif'], bold: first.bold, italic: first.italic },
        ...(issue ? { issue } : {}),
      });
    }
    return texts;
  }

  // ─── Content ────────────────────────────────────────────────────────────

  /** The characters and spans of `element`, in order, into `chunks`. */
  private static walk(
    element: XmlElement,
    style: Style,
    host: SvgTextHost,
    chunks: Chunk[],
    state: { issue: TextIssue | null; space: boolean },
  ): void {
    for (const part of element.content) {
      if (typeof part === 'string') {
        const text = SvgText.spaced(part, style.preserve, state);
        if (text !== '') {
          chunks[chunks.length - 1].runs.push({ text, style });
        }
        continue;
      }
      if (part.namespace !== host.namespace) {
        continue;
      }
      if (part.local === 'textPath') {
        state.issue = state.issue ?? 'path';
        continue;
      }
      if (part.local !== 'tspan' && part.local !== 'a') {
        // A title or a description is not drawn; a reference to other text (`tref`) is not followed.
        if (part.local === 'tref' || part.local === 'altGlyph') {
          state.issue = state.issue ?? 'format';
        }
        continue;
      }
      const declared = host.declared(part);
      if (declared.get('display')?.toLowerCase() === 'none') {
        continue;
      }
      const inner = SvgText.styled(part, style, host);
      if (part.local === 'tspan' && SvgText.shifts(part, inner, host, chunks, true)) {
        state.issue = state.issue ?? 'glyphs';
      }
      SvgText.walk(part, inner, host, chunks, state);
    }
  }

  /**
   * What an element's `x`, `y`, `dx`, `dy` and `rotate` do to where its
   * characters go. One number in `x` starts a new chunk there; a shift
   * that takes knowing where the characters before it ended is `format`,
   * set on the element's style. True when letters are placed one by one.
   */
  private static shifts(element: XmlElement, style: Style, host: SvgTextHost, chunks: Chunk[], span: boolean): boolean {
    const x = SvgText.coordinates(element, 'x', style, host);
    const y = SvgText.coordinates(element, 'y', style, host);
    const dx = SvgText.coordinates(element, 'dx', style, host);
    const dy = SvgText.coordinates(element, 'dy', style, host);
    const rotate = SvgValues.numbers(SvgText.attribute(element, 'rotate'));
    if (x.length > 1 || y.length > 1 || dx.length > 1 || dy.length > 1 || rotate.some((angle) => angle !== 0)) {
      return true;
    }
    let chunk = chunks[chunks.length - 1];
    const started = chunk.runs.some((run) => run.text.trim() !== '');
    if (span && x.length === 1) {
      // Where the line is: the baseline carries on at the same height unless the span moves it.
      chunk = { x: x[0], y: y[0] ?? chunk.y, runs: [] };
      chunks.push(chunk);
    } else if (span && y.length === 1) {
      if (started) {
        style.issue = style.issue ?? 'format';
      } else {
        chunk.y = y[0];
      }
    }
    const moved = (dx[0] ?? 0) !== 0 || (dy[0] ?? 0) !== 0;
    if (moved) {
      if (chunk.runs.some((run) => run.text.trim() !== '')) {
        style.issue = style.issue ?? 'format';
      } else {
        chunk.x += dx[0] ?? 0;
        chunk.y += dy[0] ?? 0;
      }
    }
    return false;
  }

  /** A list of lengths (`x="10 20"`, `dy="1.2em"`) in user units. */
  private static coordinates(element: XmlElement, name: string, style: Style, host: SvgTextHost): number[] {
    const text = SvgText.attribute(element, name);
    if (text === undefined) {
      return [];
    }
    const values: number[] = [];
    for (const part of text.trim().split(/[\s,]+/)) {
      const length = SvgText.length(part, style.size, host);
      if (length !== null) {
        values.push(length);
      }
    }
    return values;
  }

  /**
   * Character data as it is drawn: a line break or a tab is a space, and
   * runs of spaces are one — the spaces a text starts with dropped — the
   * way browsers lay text out. With white space preserved every space
   * stays.
   */
  private static spaced(text: string, preserve: boolean, state: { space: boolean }): string {
    if (preserve) {
      state.space = false;
      return text.replace(/[\t\r\n]/g, ' ');
    }
    let out = '';
    for (const char of text.replace(/[\t\r\n]/g, ' ')) {
      if (char === ' ') {
        if (!state.space) {
          out += ' ';
        }
        state.space = true;
      } else {
        out += char;
        state.space = false;
      }
    }
    return out;
  }

  /** The one space collapsing leaves at the very end of a text is not drawn either. */
  private static trimEnd(chunks: Chunk[]): void {
    for (let c = chunks.length - 1; c >= 0; c--) {
      for (let r = chunks[c].runs.length - 1; r >= 0; r--) {
        const run = chunks[c].runs[r];
        if (run.style.preserve) {
          return;
        }
        run.text = run.text.replace(/ +$/, '');
        if (run.text !== '') {
          return;
        }
      }
    }
  }

  // ─── Properties ─────────────────────────────────────────────────────────

  /** The style of `element`, from its parent's and what it declares for itself. */
  private static styled(element: XmlElement, parent: Style, host: SvgTextHost): Style {
    const declared = host.declared(element);
    const own = (name: string): string | undefined => {
      const value = declared.get(name)?.trim();
      return value === undefined || value.toLowerCase() === 'inherit' ? undefined : value;
    };
    // Not inherited: a baseline moved for this element is undone for the next.
    const style: Style = { ...parent };

    const shorthand = own('font');
    if (shorthand !== undefined) {
      SvgText.applyShorthand(shorthand, style, parent, host);
    }
    const family = own('font-family');
    if (family !== undefined) {
      style.families = SvgText.families(family);
    }
    const size = own('font-size');
    if (size !== undefined) {
      style.size = SvgText.fontSize(size, parent.size, host) ?? style.size;
    }
    const weight = own('font-weight');
    if (weight !== undefined) {
      style.bold = SvgText.isBold(weight, parent.bold);
    }
    const slant = own('font-style');
    if (slant !== undefined) {
      style.italic = /^(italic|oblique)/i.test(slant);
    }
    const anchor = own('text-anchor')?.toLowerCase();
    if (anchor !== undefined) {
      style.anchor = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
    }
    const letterSpacing = own('letter-spacing');
    if (letterSpacing !== undefined) {
      style.letterSpacing = letterSpacing.toLowerCase() === 'normal' ? 0 : SvgText.length(letterSpacing, style.size, host) ?? 0;
    }
    const space = element.attributes.find((attribute) => attribute.local === 'space' && attribute.namespace === XML_NAMESPACE)?.value;
    if (space !== undefined) {
      style.preserve = space.trim() === 'preserve';
    }
    const whiteSpace = own('white-space')?.toLowerCase();
    if (whiteSpace !== undefined) {
      style.preserve = whiteSpace.startsWith('pre') && whiteSpace !== 'pre-line';
    }

    // What a sketch text has no word for.
    const unsaid = (name: string, plain: RegExp): boolean => {
      const value = own(name);
      return value !== undefined && !plain.test(value);
    };
    const zero = (name: string): boolean => {
      const value = own(name);
      return value === undefined || /^(normal|baseline|auto)$/i.test(value) || SvgValues.length(value)?.value === 0;
    };
    if (
      unsaid('writing-mode', /^(lr|lr-tb|rl|rl-tb|horizontal-tb)$/i)
      || unsaid('direction', /^ltr$/i)
      || unsaid('font-variant', /^normal$/i)
      || unsaid('font-variant-caps', /^normal$/i)
      || unsaid('font-stretch', /^(normal|100%)$/i)
      || unsaid('dominant-baseline', /^(auto|alphabetic|baseline)$/i)
      || unsaid('alignment-baseline', /^(auto|alphabetic|baseline)$/i)
      || !zero('baseline-shift')
      || !zero('word-spacing')
      || SvgText.attribute(element, 'textLength') !== undefined
    ) {
      style.issue = style.issue ?? 'format';
    }
    return style;
  }

  /** `font: italic bold 12px/14px "Open Sans", sans-serif` — the properties it sets, into `style`. */
  private static applyShorthand(text: string, style: Style, parent: Style, host: SvgTextHost): void {
    const match = /^(.*?)((?:\d*\.)?\d+(?:[a-z%]+)?|xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)(?:\s*\/\s*\S+)?\s+(\S.*)$/i.exec(text);
    if (!match) {
      // A system font (`caption`, `menu`): no family to look for.
      return;
    }
    style.bold = false;
    style.italic = false;
    for (const word of match[1].trim().split(/\s+/)) {
      if (/^(italic|oblique)$/i.test(word)) {
        style.italic = true;
      } else if (/^(bold|bolder|lighter|[1-9]00)$/i.test(word)) {
        style.bold = SvgText.isBold(word, parent.bold);
      } else if (/^small-caps$/i.test(word)) {
        style.issue = style.issue ?? 'format';
      }
    }
    style.size = SvgText.fontSize(match[2], parent.size, host) ?? style.size;
    style.families = SvgText.families(match[3]);
  }

  /** A `font-family` list: its names without their quotes, in order. */
  private static families(text: string): string[] {
    return text.split(',').map((name) => name.trim().replace(/^(["'])(.*)\1$/, '$2').trim()).filter((name) => name !== '');
  }

  private static isBold(weight: string, parent: boolean): boolean {
    const word = weight.trim().toLowerCase();
    if (word === 'bold' || word === 'bolder') {
      return true;
    }
    if (word === 'normal') {
      return false;
    }
    if (word === 'lighter') {
      return false;
    }
    const number = Number(word);
    // A weight between regular and bold is nearer the face it was drawn in: bold from 600 up.
    return Number.isFinite(number) ? number >= 600 : parent;
  }

  /** A `font-size` in user units; null when it is not one. */
  private static fontSize(text: string, parent: number, host: SvgTextHost): number | null {
    const word = text.trim().toLowerCase();
    if (SIZE_KEYWORDS[word] !== undefined) {
      return MEDIUM * SIZE_KEYWORDS[word] * (host.units.px ?? 1);
    }
    if (word === 'larger') {
      return parent * 1.2;
    }
    if (word === 'smaller') {
      return parent / 1.2;
    }
    const size = SvgText.length(word, parent, host);
    return size !== null && size > 0 ? size : null;
  }

  /** A length in user units, with `em`, `ex` and `%` of the font size `em`; null when the text is not one. */
  private static length(text: string, em: number, host: SvgTextHost): number | null {
    const length = SvgValues.length(text);
    if (!length) {
      return null;
    }
    if (length.unit === 'em') {
      return length.value * em;
    }
    if (length.unit === 'ex') {
      return length.value * em * 0.5;
    }
    if (length.unit === '%') {
      return (length.value / 100) * em;
    }
    const factor = host.units[length.unit];
    return factor === undefined ? null : length.value * factor;
  }

  /** Whether two runs are written with the same letters: one statement can say both. */
  private static sameLetters(a: Style, b: Style): boolean {
    return a.size === b.size && a.bold === b.bold && a.italic === b.italic && a.letterSpacing === b.letterSpacing
      && a.families.join('\n').toLowerCase() === b.families.join('\n').toLowerCase();
  }

  private static attribute(element: XmlElement, name: string): string | undefined {
    return element.attributes.find((attribute) => attribute.local === name && attribute.namespace === '')?.value;
  }
}
