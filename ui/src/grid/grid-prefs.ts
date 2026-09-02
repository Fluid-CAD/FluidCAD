import { viewerSettings } from '../scene/viewer-settings';
import type { GridPrefs } from './grid-spacing';

/**
 * The grid preferences as `resolveGridSpacing` wants them, read from the
 * live settings store. Both grid consumers (the shader grid and the snapper)
 * go through this so they never disagree about the mode.
 */
export function currentGridPrefs(): GridPrefs {
  const s = viewerSettings.current;
  return {
    adaptive: s.gridAdaptive,
    minCellPx: s.gridMinCellPx,
    fixedSpacing: s.gridFixedSpacing,
    majorEvery: s.gridMajorEvery,
  };
}
