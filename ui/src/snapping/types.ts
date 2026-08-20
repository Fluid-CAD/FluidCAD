import { Vector3 } from 'three';

export type SnapType = 'vertex' | 'grid' | 'none';

/** Provenance of a vertex snap inside a solved sketch: the entity statement
 * vertex the snap landed on — or the implicit sketch datum (origin/axes) —
 * in the vocabulary of the emission rail's constraint targets. Carried so
 * drawing tools can emit an explicit `coincident(...)` instead of only
 * baking the literal (sketch-rewrite P5). */
export type SolvedVertexRef = {
  /** 1-indexed source line of the owning entity statement; absent for
   * datum refs (datums have no statement). */
  line?: number;
  /** Point accessor rendered as `.role()`; absent = the entity IS a point. */
  role?: 'start' | 'end' | 'center';
  featureType?: 'line' | 'arc' | 'circle' | 'point';
  /** The implicit sketch datum the snap landed on — the origin point, or a
   * point-on-axis snap. Exclusive with line/role/featureType. */
  datum?: 'origin' | 'x-axis' | 'y-axis';
};

export type SnapResult = {
  point2d: [number, number];
  worldPoint: Vector3;
  snapType: SnapType;
  /** Set on vertex snaps that landed on a solved entity's vertex. Cross-part
   * snapVertices, the plane center, and grid snaps carry none — those keep
   * baking literals. */
  ref?: SolvedVertexRef;
};

export interface Snapper {
  snap(point2d: [number, number], threshold: number): SnapResult | null;
}
