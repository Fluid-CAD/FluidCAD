import { beforeAll, describe, expect, it } from 'vitest';
import { FontMeasures } from '../src/font-measure.ts';
import { FontRegistry } from '../../lib/dist/io/font-registry.js';

// How the fonts installed here measure, for an import's text: a family is
// here only when it is installed itself (or a font made to its letter
// widths is), in the weight and style asked for.

describe('FontMeasures', () => {
  /** The font the machine gives a text without one: whatever is installed here. */
  let family = '';
  let installed = new Set<string>();

  beforeAll(async () => {
    await FontRegistry.init();
    family = FontRegistry.resolve({}).familyName;
    installed = new Set(FontRegistry.availableFamilies());
  });

  const one = (families: string[], lines: string[] = ['H'], style: { bold?: boolean; italic?: boolean } = {}) =>
    FontMeasures.measure([{ families, bold: style.bold ?? false, italic: style.italic ?? false, lines }])[0];

  it('measures an installed family from the font itself: its capital is the height of its H', () => {
    const measure = one([family], ['H', 'HH', '']);
    const font = FontRegistry.resolve({ font: family });
    expect(measure.family).toBe(family);
    expect(measure.substituted).toBe(false);
    expect(measure.capital).toBeCloseTo(font.glyphForCodePoint(72).bbox.maxY / font.unitsPerEm, 12);
    expect(measure.capital).toBeGreaterThan(0.5);
    expect(measure.capital).toBeLessThan(1);
    expect(measure.ascent).toBeCloseTo(font.ascent / font.unitsPerEm, 12);
    // A depth: positive.
    expect(measure.descent).toBeGreaterThan(0);
    const advance = font.glyphForCodePoint(72).advanceWidth / font.unitsPerEm;
    expect(measure.advances[0]).toBeCloseTo(advance, 12);
    expect(measure.advances[1]).toBeCloseTo(2 * advance, 12);
    expect(measure.advances[2]).toBe(0);
  });

  it('finds a family whatever the case and spacing of its name', () => {
    expect(one([`  ${family.toUpperCase()} `]).family).toBe(family);
  });

  it('says a family that is not installed is not: no look-alike, no default', () => {
    const measure = one(['No Such Family 4f2a']);
    expect(measure.family).toBeNull();
    expect(measure.advances).toEqual([]);
    // A pen font has no family at all.
    expect(one([]).family).toBeNull();
  });

  it('takes the first family of the list that is installed, and says it stands in', () => {
    const measure = one(['No Such Family 4f2a', family]);
    expect(measure.family).toBe(family);
    expect(measure.substituted).toBe(true);
  });

  it('answers a generic name with a font of that kind, when the machine has one', () => {
    const sans = ['helvetica', 'arial', 'liberation sans', 'dejavu sans', 'noto sans', 'segoe ui', 'roboto'];
    const measure = one(['sans-serif']);
    if (sans.some((name) => installed.has(name))) {
      expect(sans).toContain(measure.family!.toLowerCase());
      expect(measure.substituted).toBe(true);
    } else {
      expect(measure.family).toBeNull();
    }
  });

  it('lets a font made to the same letter widths stand in: Liberation Sans for Arial', () => {
    if (installed.has('arial') || installed.has('helvetica') || !installed.has('liberation sans')) {
      return;
    }
    const measure = one(['Arial'], ['Plate A']);
    expect(measure.family).toBe('Liberation Sans');
    expect(measure.substituted).toBe(true);
    expect(measure.advances[0]).toBeCloseTo(one(['Liberation Sans'], ['Plate A']).advances[0], 12);
  });

  it('does not take a regular face for a bold or an italic one', () => {
    const font = FontRegistry.resolve({ font: family, weight: 700, italic: true });
    const hasBoldItalic = /bold/i.test(font.subfamilyName) && /italic|oblique/i.test(font.subfamilyName) && font.familyName === family;
    const measure = one([family], ['H'], { bold: true, italic: true });
    if (hasBoldItalic) {
      expect(measure.family).toBe(family);
      // A bold H is wider than a regular one, or at least another letter.
      expect(measure.advances[0]).toBeGreaterThan(0);
    } else {
      expect(measure.family).toBeNull();
    }
  });

  it('answers every request, in order', () => {
    const measures = FontMeasures.measure([
      { families: [family], bold: false, italic: false, lines: ['A'] },
      { families: ['No Such Family 4f2a'], bold: false, italic: false, lines: ['B'] },
      { families: [family], bold: false, italic: false, lines: ['C', 'D'] },
    ]);
    expect(measures.map((measure) => measure.family)).toEqual([family, null, family]);
    expect(measures[2].advances).toHaveLength(2);
  });
});
