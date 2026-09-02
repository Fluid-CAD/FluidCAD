// Annotation declutterer — screen-space layout for solved-sketch constraint
// badges and dimension labels (sketch-rewrite P5.5). See declutter.ts for the
// priority rules; everything here is pure and camera-free.

export { declutterAnnotations, DEFAULT_DECLUTTER_OPTIONS } from './declutter';
export type {
  BadgeItem,
  BoxSize,
  DeclutterInput,
  DeclutterOptions,
  DeclutterResult,
  DimensionItem,
  DimensionStyle,
  OverflowPill,
} from './declutter';
export { GeometryIndex, NO_OWNER } from './geometry-index';
export { Occupancy } from './occupancy';
export { clusterAnchors } from './cluster';
export type { AnchorGroup, Cluster } from './cluster';
export { rowRects } from './rows';
export { hiddenPlacement, normalize, orientReading, perpPt } from './types';
export type { Placement, Pt, Rect } from './types';
