/**
 * Artwork for the 16 solved-sketch constraint kinds, keyed by the kind itself
 * (`SOLVED_CONSTRAINT_KINDS`) rather than by the `constraint-<kind>` unique
 * type, so the constraint toolbar — whose button ids ARE the kinds — and the
 * timeline read one set of names. Most map straight through; the exceptions:
 * `collinear` borrows the artwork's own one-l spelling, and radius/diameter
 * borrow the distance dimension until they have art of their own.
 */
export const CONSTRAINT_KIND_ICONS: Record<string, string> = {
  'angle': 'constraint-angle',
  'coincident': 'constraint-coincident',
  'collinear': 'constraint-colinear',
  'concentric': 'constraint-concentric',
  'diameter': 'constraint-distance',
  'distance': 'constraint-distance',
  'equal': 'constraint-equal',
  'fix': 'constraint-fix',
  'horizontal': 'constraint-horizontal',
  'midpoint': 'constraint-midpoint',
  'parallel': 'constraint-parallel',
  'perpendicular': 'constraint-perpendicular',
  'radius': 'constraint-distance',
  'symmetric': 'constraint-symmetric',
  'tangent': 'constraint-tangent',
  'vertical': 'constraint-vertical',
};

/** Undoing a constraint: the toolbar's delete button and nothing else. */
export const CONSTRAINT_REMOVE_ICON = 'constraint-remove';

export const UNIQUE_TYPE_ICONS: Record<string, string> = {
  'aline': 'aline',
  'axis-from-edge': 'axis',
  'connector': 'mate-connector',
  ...Object.fromEntries(
    Object.entries(CONSTRAINT_KIND_ICONS).map(([kind, icon]) => [`constraint-${kind}`, icon]),
  ),
  'axis-middle': 'axis',
  'copy-circular-2d': 'copy-circular2d',
  'copy-linear-2d': 'copy-linear2d',
  'cut': 'cut',
  'cut-symmetric': 'cut',
  'exposed': 'select',
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
  'repeat-circular': 'repeat-circular',
  'repeat-linear': 'repeat-linear',
  'repeat-matrix': 'repeat-linear',
  'rotate-shape': 'rotate',
  'rotate-shape-2d': 'rotate2d',
  'slot-from-edge': 'slot',
  'tarc-radius-to-point': 'tarc',
  'tarc-to-point': 'tarc',
  'tarc-to-point-tangent': 'tarc',
  'tarc-with-tangent': 'tarc',
  'tline': 'tline',
  'trim2d': 'trim',
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
