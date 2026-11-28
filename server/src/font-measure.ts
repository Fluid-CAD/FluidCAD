import type { Font } from 'fontkit';
import { FontRegistry } from '../../lib/dist/io/font-registry.js';
import type { FontMeasure, FontMeasureRequest } from '../../lib/dist/io/drawing/imported-text.js';

/**
 * Families made to the letter widths of another: a line set in one is as
 * long as in the other, so one stands in for the other without moving
 * anything.
 */
const SAME_WIDTHS: Record<string, string[]> = {
  'arial': ['helvetica', 'liberation sans', 'arimo'],
  'helvetica': ['arial', 'liberation sans', 'arimo'],
  'times new roman': ['liberation serif', 'tinos'],
  'courier new': ['liberation mono', 'cousine'],
  'calibri': ['carlito'],
  'cambria': ['caladea'],
};

const SANS = ['helvetica', 'arial', 'liberation sans', 'dejavu sans', 'noto sans', 'segoe ui', 'roboto'];
const SERIF = ['times new roman', 'liberation serif', 'dejavu serif', 'noto serif', 'georgia'];
const MONO = ['courier new', 'liberation mono', 'dejavu sans mono', 'noto sans mono', 'menlo', 'consolas'];

/** The names CSS has for "any font of this kind", and the families tried for each, in order. */
const GENERIC: Record<string, string[]> = {
  'sans-serif': SANS,
  'system-ui': SANS,
  'ui-sans-serif': SANS,
  'serif': SERIF,
  'ui-serif': SERIF,
  'monospace': MONO,
  'ui-monospace': MONO,
};

/** The most characters measured in one request: what a drawing's text comes to, many times over. */
const MAX_CHARACTERS = 2_000_000;

function normalized(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * How the fonts installed here measure, for text an import is about to
 * write as `text()` statements: the sketch is built on this machine, so
 * its fonts are the ones that count.
 *
 * A request names families, most wanted first. The first that is
 * installed in the weight and style asked for is the answer — itself, a
 * family made to its letter widths (Liberation Sans for Arial), or for a
 * generic name (`serif`) the first of that kind there is. The font
 * registry's own lookup is more forgiving: it falls back to a look-alike
 * and then to any font at all, which is right for drawing a text and wrong
 * for saying a file's font is here. A family that is installed without
 * the bold or the italic asked for is not installed, for that text.
 */
export class FontMeasures {
  /** One answer per request, in order. `FontRegistry.init()` must have completed. */
  static measure(requests: readonly FontMeasureRequest[]): FontMeasure[] {
    const installed = new Set(FontRegistry.availableFamilies());
    let budget = MAX_CHARACTERS;
    return requests.map((request) => {
      const found = FontMeasures.find(request, installed);
      if (!found) {
        return { family: null, substituted: false, capital: 0, ascent: 0, descent: 0, lineGap: 0, advances: [] };
      }
      const { font } = found;
      const em = font.unitsPerEm;
      const advances = request.lines.map((line) => {
        budget -= line.length;
        if (budget < 0) {
          throw new Error('too much text to measure in one request');
        }
        return font.layout(line).positions.reduce((sum, position) => sum + position.xAdvance, 0) / em;
      });
      return {
        family: font.familyName,
        substituted: found.substituted,
        capital: FontMeasures.capital(font) / em,
        ascent: font.ascent / em,
        descent: -font.descent / em,
        lineGap: font.lineGap / em,
        advances,
      };
    });
  }

  /** The installed font a request comes to; null when none of its families is installed in its weight and style. */
  private static find(request: FontMeasureRequest, installed: ReadonlySet<string>): { font: Font; substituted: boolean } | null {
    for (const [index, asked] of request.families.entries()) {
      const key = normalized(asked);
      for (const candidate of GENERIC[key] ?? [key, ...(SAME_WIDTHS[key] ?? [])]) {
        if (!installed.has(candidate)) {
          continue;
        }
        const font = FontRegistry.resolve({ font: candidate, weight: request.bold ? 700 : 400, italic: request.italic });
        // The registry answers with a look-alike rather than nothing: only this family, as asked for, counts.
        if (normalized(font.familyName) === candidate && FontMeasures.isItalic(font) === request.italic && FontMeasures.isBold(font) === request.bold) {
          return { font, substituted: index > 0 || candidate !== key };
        }
      }
    }
    return null;
  }

  /** The height of a flat capital: the H's own outline, or what the font says when it has no H. */
  private static capital(font: Font): number {
    try {
      const top = font.glyphForCodePoint(72).bbox.maxY;
      if (Number.isFinite(top) && top > 0) {
        return top;
      }
    } catch {
      // A font without an H, or whose outlines do not compute.
    }
    return font.capHeight > 0 ? font.capHeight : 0;
  }

  private static isItalic(font: Font): boolean {
    return Math.abs(font.italicAngle || 0) > 0.01 || /italic|oblique/i.test(font.subfamilyName || '');
  }

  private static isBold(font: Font): boolean {
    const weight = (font as unknown as { 'OS/2'?: { usWeightClass?: number } })['OS/2']?.usWeightClass;
    return typeof weight === 'number' ? weight >= 600 : /bold/i.test(font.subfamilyName || '');
  }
}
