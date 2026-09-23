// The ghost request body and the vocabularies its fields draw from.

export type GhostBody = {
  feature?: unknown;
  op?: unknown;
  distance?: unknown;
  distance2?: unknown;
  symmetric?: unknown;
  draft?: unknown;
  drill?: unknown;
  thin?: unknown;
  extendStart?: unknown;
  extendEnd?: unknown;
  angle?: unknown;
  offset?: unknown;
  value?: unknown;
  isAngle?: unknown;
  edges?: unknown;
  axis?: { kind?: unknown; axis?: unknown; filePath?: unknown; line?: unknown; shapeId?: unknown; index?: unknown };
  profile?: { filePath?: unknown; line?: unknown };
  thickness?: unknown;
  parallel?: unknown;
  extend?: unknown;
  spine?: { filePath?: unknown; line?: unknown };
  scope?: unknown;
  exclude?: { filePath?: unknown; line?: unknown };
  path?: unknown;
  profiles?: unknown;
  connections?: unknown;
  guides?: unknown;
  startCondition?: unknown;
  endCondition?: unknown;
  source?: unknown;
  radius?: unknown;
  endRadius?: unknown;
  pitch?: unknown;
  turns?: unknown;
  height?: unknown;
  startOffset?: unknown;
  endOffset?: unknown;
  kind?: unknown;
  targets?: unknown;
  axes?: unknown;
  plane?: unknown;
  directions?: unknown;
  centered?: unknown;
  count?: unknown;
  sweep?: unknown;
  type?: unknown;
  bases?: unknown;
  rotateX?: unknown;
  rotateY?: unknown;
  rotateZ?: unknown;
  rotationAxes?: unknown;
  position?: unknown;
  skip?: unknown;
  close?: unknown;
  entities?: unknown;
  center?: unknown;
  regions?: unknown;
};

export const FEATURES = [
  'extrude', 'revolve', 'sweep', 'loft', 'fillet', 'chamfer', 'helix', 'repeat', 'copy', 'mirror',
  'rotate', 'plane', 'rib', 'offset', 'fillet2d', 'copy2d', 'mirror2d',
];

/** The features that modify edges of an existing solid rather than sweep a profile. */
export const BAND_FEATURES = ['fillet', 'chamfer'];

/** The features that sweep one profile — the only ones carrying a profile ref. */
export const PROFILE_FEATURES = ['extrude', 'revolve', 'sweep'];

export const OPS = ['add', 'remove', 'new'];

export const STANDARD_AXES = ['x', 'y', 'z'];

export const STANDARD_PLANES = ['xy', 'xz', 'yz'];

export const CONDITION_TYPES = ['normal', 'tangent'];

export const REPEAT_KINDS = ['linear', 'circular', 'mirror', 'rotate'];

/** The copy's two: it walks an axis or spins around one, and mirrors nothing. */
export const COPY_KINDS = ['linear', 'circular'];

/** The plane dialog's three forms; the base count follows from the type. */
export const PLANE_TYPES = ['offset', 'mid', 'edge'];

/** The circular dialog's two angle forms: the whole sweep, or one step of it. */
export const SWEEP_MODES = ['angle', 'offset'];

/**
 * Two directions is what the repeat and copy dialogs write; more is
 * hand-written code.
 */
export const MAX_GHOST_DIRECTIONS = 2;

/** The ceiling on a copy's skip list — the dialog's own (copy-skip.ts). */
export const MAX_GHOST_SKIP = 256;
