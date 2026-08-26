import * as monaco from 'monaco-editor/editor/editor.api.js';
import { onThemeChange } from '../scene/theme-colors';

/**
 * Monaco's colors, derived from the active daisyUI theme rather than hardcoded.
 * The server string-replaces `data-theme` in `index.html` before the page ever
 * loads (see the theme pre-apply invariant), so the variables are already
 * correct at first paint and the editor never flashes the wrong palette.
 *
 * One theme is defined and *re*defined on each change rather than two
 * registered up front: CSS custom properties only expose the theme that is
 * currently applied, so the inactive one's values simply aren't readable.
 */

export const MONACO_THEME_NAME = 'fluidcad';

/**
 * daisyUI 5 emits `oklch(...)`, which Monaco can't parse — it wants
 * `#rrggbb`. Round-tripping through a 1×1 canvas converts whatever the
 * browser computed, in whatever color space, without a color library.
 */
const probe = document.createElement('canvas');
probe.width = 1;
probe.height = 1;

function toHex(cssColor: string, fallback: string): string {
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return fallback;
  }
  ctx.clearRect(0, 0, 1, 1);
  // An unparseable assignment is ignored by the canvas, leaving the fallback
  // in place — so a theme missing a variable degrades instead of throwing.
  ctx.fillStyle = fallback;
  ctx.fillStyle = cssColor || fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function themeColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toHex(raw, fallback);
}

/** Monaco token rules want a bare hex, no leading `#`. */
function token(hex: string): string {
  return hex.replace('#', '');
}

/** Mix `hex` toward `toward` — used for the muted greys a palette doesn't name. */
function mix(hex: string, toward: string, amount: number): string {
  const parse = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(toward);
  const blend = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `#${[blend(r1, r2), blend(g1, g2), blend(b1, b2)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildTheme(): monaco.editor.IStandaloneThemeData {
  const background = themeColor('--color-base-100', '#1e1e1e');
  const surface = themeColor('--color-base-200', '#252525');
  const border = themeColor('--color-base-300', '#2d2d2d');
  const foreground = themeColor('--color-base-content', '#d4d4d4');
  const primary = themeColor('--color-primary', '#4a9eff');
  const secondary = themeColor('--color-secondary', '#7b92b2');
  const accent = themeColor('--color-accent', '#67cba0');
  const info = themeColor('--color-info', '#3abff8');
  const error = themeColor('--color-error', '#f87272');

  // Light or dark is a property of the palette, not of the theme's name — a
  // custom theme must not have to be added to a list here to look right.
  const isDark = relativeLuminance(background) < 0.5;
  const muted = mix(foreground, background, 0.55);

  return {
    base: isDark ? 'vs-dark' : 'vs',
    // Inherit the base theme's token colors: the ones below are the accents
    // worth tying to the palette, not a full syntax theme worth maintaining.
    inherit: true,
    rules: [
      { token: 'comment', foreground: token(muted), fontStyle: 'italic' },
      { token: 'keyword', foreground: token(primary) },
      { token: 'string', foreground: token(accent) },
      { token: 'number', foreground: token(secondary) },
      { token: 'type', foreground: token(info) },
      { token: 'type.identifier', foreground: token(info) },
      { token: 'delimiter', foreground: token(muted) },
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': foreground,
      'editorGutter.background': background,
      'editorLineNumber.foreground': mix(foreground, background, 0.65),
      'editorLineNumber.activeForeground': foreground,
      'editor.lineHighlightBackground': surface,
      'editorCursor.foreground': primary,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': mix(border, foreground, 0.3),
      'editorWidget.background': surface,
      'editorWidget.border': border,
      'editorSuggestWidget.background': surface,
      'editorSuggestWidget.border': border,
      'editorSuggestWidget.selectedBackground': mix(surface, primary, 0.3),
      'editorHoverWidget.background': surface,
      'editorHoverWidget.border': border,
      'editorError.foreground': error,
      'editorWarning.foreground': themeColor('--color-warning', '#fbbd23'),
      'scrollbarSlider.background': `${mix(background, foreground, 0.2)}80`,
      'scrollbarSlider.hoverBackground': `${mix(background, foreground, 0.3)}b0`,
      'scrollbarSlider.activeBackground': `${mix(background, foreground, 0.4)}d0`,
      'input.background': background,
      'input.border': border,
      'focusBorder': primary,
    },
  };
}

let installed = false;

/**
 * Define the Monaco theme from the live palette and keep it in step with
 * `data-theme` afterwards. Idempotent — safe to call from every entry point
 * that might be the first to need an editor.
 */
export function installMonacoTheme(): void {
  monaco.editor.defineTheme(MONACO_THEME_NAME, buildTheme());
  if (installed) {
    return;
  }
  installed = true;
  onThemeChange(() => {
    monaco.editor.defineTheme(MONACO_THEME_NAME, buildTheme());
    monaco.editor.setTheme(MONACO_THEME_NAME);
  });
}
