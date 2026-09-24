import { describe, expect, it } from 'vitest';
import { installedMonospaceFonts, isFontInstalled, type TextMeasurer } from '../src/ui/settings/monospace-fonts';

// Font presence is judged from text widths: an installed family measures the
// same whichever fallback follows it, and differently from at least one bare
// fallback; a missing family collapses onto the fallback and matches it.

function fakeMeasurer(installed: Record<string, number>): TextMeasurer {
  return (font) => {
    const match = /'([^']+)'/.exec(font);
    const family = match?.[1];
    if (family && family in installed) {
      return installed[family];
    }
    return font.endsWith('monospace') ? 100 : 80;
  };
}

describe('isFontInstalled', () => {
  it('keeps a family that draws itself and drops one that falls back', () => {
    const measure = fakeMeasurer({ 'Fira Code': 120 });
    expect(isFontInstalled('Fira Code', measure)).toBe(true);
    expect(isFontInstalled('Nope Mono', measure)).toBe(false);
  });

  it('keeps a family that happens to be the system monospace font', () => {
    const measure = fakeMeasurer({ 'DejaVu Sans Mono': 100 });
    expect(isFontInstalled('DejaVu Sans Mono', measure)).toBe(true);
  });

  it('reports nothing installed when text cannot be measured', () => {
    expect(isFontInstalled('Fira Code', () => null)).toBe(false);
  });
});

describe('installedMonospaceFonts', () => {
  it('filters the candidate list in order', () => {
    const measure = fakeMeasurer({ Hack: 90, Menlo: 95 });
    expect(installedMonospaceFonts(['JetBrains Mono', 'Hack', 'Menlo'], measure)).toEqual(['Hack', 'Menlo']);
  });
});
