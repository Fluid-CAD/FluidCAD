/**
 * Which monospace fonts this machine has, out of a short list worth offering.
 *
 * Browsers do not enumerate installed fonts (the Local Font Access API is
 * Chromium-only and behind a permission prompt), so the list is a fixed set
 * of well-known coding fonts, each kept only when it is really installed:
 * text set in `'<candidate>', <fallback>` is measured against the same text
 * in the bare fallback, once with a monospace fallback and once with a
 * proportional one. An installed candidate renders the same either way and
 * differs from at least one fallback; a missing one collapses onto whichever
 * fallback is named and so measures identically to it.
 */

/** Coding fonts worth offering, in the order the dialog lists them. */
export const MONOSPACE_FONT_CANDIDATES: readonly string[] = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Noto Sans Mono',
  'Hack',
  'Inconsolata',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Consolas',
  'Courier New',
];

/** The sample: wide and narrow glyphs together, so a substitution shows in the width. */
const SAMPLE = 'mmmmmmmmmmlli1|WWWWiiii0O@';
const SAMPLE_SIZE = '72px';

/** Measures text width for a CSS font string; null when no canvas is available (tests, headless). */
export type TextMeasurer = (font: string) => number | null;

function canvasMeasurer(): TextMeasurer {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext?.('2d') ?? null;
  return (font) => {
    if (!ctx) {
      return null;
    }
    ctx.font = font;
    return ctx.measureText(SAMPLE).width;
  };
}

/** Whether `family` is installed, judged by the width test above. Unknowable (no canvas): false. */
export function isFontInstalled(family: string, measure: TextMeasurer = canvasMeasurer()): boolean {
  const quoted = `'${family.replace(/'/g, "\\'")}'`;
  const monoBase = measure(`${SAMPLE_SIZE} monospace`);
  const sansBase = measure(`${SAMPLE_SIZE} sans-serif`);
  const withMono = measure(`${SAMPLE_SIZE} ${quoted}, monospace`);
  const withSans = measure(`${SAMPLE_SIZE} ${quoted}, sans-serif`);
  if (monoBase === null || sansBase === null || withMono === null || withSans === null) {
    return false;
  }
  // Present: both measurements agree with each other (the candidate drew
  // both times) and at least one differs from its fallback. A candidate
  // that happens to BE the system monospace font agrees with `monospace`
  // and still differs from `sans-serif`, so it is kept too.
  return withMono === withSans && (withMono !== monoBase || withSans !== sansBase);
}

/** The candidates that are installed, in list order. */
export function installedMonospaceFonts(
  candidates: readonly string[] = MONOSPACE_FONT_CANDIDATES,
  measure: TextMeasurer = canvasMeasurer(),
): string[] {
  return candidates.filter((family) => isFontInstalled(family, measure));
}
