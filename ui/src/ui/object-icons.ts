const UNIQUE_TYPE_ICONS: Record<string, string> = {
  'aline': 'aline',
  'axis-from-edge': 'axis',
  'axis-middle': 'axis',
  'copy-circular-2d': 'copy-circular2d',
  'copy-linear-2d': 'copy-linear2d',
  'cut': 'cut',
  'cut-symmetric': 'cut',
  'extrude-by-distance': 'extrude',
  'extrude-by-two-distance': 'extrude',
  'extrude-symmetric': 'extrude',
  'extrude-to-face': 'extrude',
  'hline': 'hline',
  'lazy-select': 'select',
  'line-two-points': 'line',
  'mirror-feature': 'mirror',
  'mirror-shape': 'mirror',
  'mirror-shape-2d': 'mirror2d',
  'one-object-tline': 'tline',
  'plane-from-face': 'plane',
  'repeat-circular': 'copy-circular',
  'repeat-linear': 'copy-linear',
  'repeat-matrix': 'copy-linear',
  'slot-from-edge': 'slot',
  'tarc-to-point': 'tarc',
  'tarc-to-point-tangent': 'tarc',
  'tarc-with-tangent': 'tarc',
  'tline': 'tline',
  'two-objects-tarc': 'tarc',
  'two-objects-tcircle': 'arc',
  'two-objects-tline': 'tline',
  'vline': 'vline',
};

export function resolveIconName(uniqueType: string | undefined, type: string | undefined): string {
  if (uniqueType && UNIQUE_TYPE_ICONS[uniqueType]) {
    return UNIQUE_TYPE_ICONS[uniqueType];
  }
  return type || 'solid';
}

/**
 * Generic icon shown when a feature or shape has no PNG of its own (e.g. a newly
 * added feature/shape type that predates its artwork). `solid` is a neutral grey
 * cube and is already the catch-all returned by resolveIconName.
 */
export const DEFAULT_ICON_SRC = '/icons/solid.png';

/**
 * Inline `onerror` attribute for icon `<img>` tags built via innerHTML. When the
 * resolved PNG is missing (404), swap in the default icon and detach the handler
 * so a missing default can't trigger an infinite loop.
 */
export const ICON_IMG_FALLBACK = `onerror="this.onerror=null;this.src='${DEFAULT_ICON_SRC}'"`;
