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
  /** Loop-instance targeting: the owning object's 0-based execution index
   * when its statement produced multiple objects (looped statements share a
   * line — the occurrence tells the instances apart). */
  occurrence?: number;
  /** Point accessor rendered as `.role()`; absent = the entity IS a point. */
  role?: 'start' | 'end' | 'center';
  /** Anchor-point statements (P8) name their own callee — the server
   * renders `.center()` / `.anchor()` / `.point(i)` instead of a role.
   * Reference snaps (P6) name their producer ('project' | 'intersect') and
   * copy-duplicate snaps name 'copy' — the statement at `line` is NOT an
   * entity call, and the server refuses a plain entity target on it. */
  featureType?: 'line' | 'arc' | 'circle' | 'point' | 'ellipse' | 'text' | 'bezier'
    | 'project' | 'intersect' | 'copy';
  /** Reference snaps (P6): the `.ref(i)` edge index on the project()/
   * intersect() statement at `line`; null = the terse single-entity form.
   * Presence marks the snap as landing on fixed reference geometry. */
  refIndex?: number | null;
  /** Copy-duplicate snaps: the picked duplicate's `instance()` slot on the
   * 2D copy() statement at `line` — rides `featureType: 'copy'`. */
  instanceIndex?: number;
  /** Bezier anchor snaps: the snapped control point's 0-based index —
   * rides `featureType: 'bezier'` only. */
  pointIndex?: number;
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
