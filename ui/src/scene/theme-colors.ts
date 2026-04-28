import { Color } from 'three';

/**
 * Reads CSS custom `--scene-*` properties from the active DaisyUI theme
 * and exposes them as Three.js Color objects. A MutationObserver on
 * `<html data-theme>` keeps values in sync when the user switches themes.
 *
 * Mesh / grid code can import `themeColors` for the current values and
 * call `onThemeChange(fn)` to re-apply materials when the theme changes.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readAll() {
  themeColors.faceColor.set(readCssVar('--scene-face-color', '#969696'));
  themeColors.edgeColor.set(readCssVar('--scene-edge-color', '#000000'));
  themeColors.gridColor.set(readCssVar('--scene-grid-color', '#6f6f6f'));
  themeColors.metaEdgeColor.set(readCssVar('--scene-meta-edge-color', '#b0b0b0'));
  themeColors.highlightColor.set(readCssVar('--scene-highlight-color', '#ffb433'));
  themeColors.backgroundColor.set(readCssVar('--color-base-100', '#1e1e1e'));
}

export const themeColors = {
  faceColor: new Color('#969696'),
  edgeColor: new Color('#000000'),
  gridColor: new Color('#6f6f6f'),
  metaEdgeColor: new Color('#b0b0b0'),
  highlightColor: new Color('#ffb433'),
  backgroundColor: new Color('#1e1e1e'),
};

// Read initial values once the DOM is ready
readAll();

// Watch for theme changes
new MutationObserver(() => {
  readAll();
  for (const fn of listeners) {
    fn();
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/**
 * Register a callback that fires when the theme changes.
 * Returns an unsubscribe function.
 */
export function onThemeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
