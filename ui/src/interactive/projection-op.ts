import type { ProjectionOp } from '../api';

/**
 * What tells the projection dialog's two statements apart in the UI. Both
 * ride one dialog, one pick set, one apply rail (`feature: 'project'` with
 * the callee under `op`); this is everything the user sees that differs.
 */
export interface ProjectionOpSpec {
  /** Dialog title while armed. */
  title: string;
  /** Dialog title over an existing statement (timeline double-click). */
  editTitle: string;
  /** The header icon (the toolbar button's artwork). */
  icon: string;
  /** The pick slot's standing invitation. */
  pickPrompt: string;
  /** The slot prompt while an edit's own sources stand as the keep chip. */
  repickPrompt: string;
  /** Apply with nothing picked. */
  emptyMessage: string;
  /** A refused apply. */
  failMessage: string;
  /** The cross-part notice's go-ahead button. */
  confirmLabel: string;
  /** How the cross-part notice names the action. */
  foreign: { verb: string; gerund: string };
  /**
   * Which viewport picks the statement takes. Flattening projects edges and
   * faces alike; sectioning wants faces — a plane cuts an edge in a point,
   * which is no sketch geometry.
   */
  picks: readonly ('edge' | 'face')[];
  /** The viewer's pick filter while armed, matching `picks`. */
  pickFilter: 'all' | 'face';
  /**
   * Whether a click on a previous sketch's geometry takes that whole sketch
   * as a source (`project(s1)`). Flattening does; sectioning a sketch with
   * a plane yields points, never sketch geometry, so intersect leaves the
   * sketch-wire channel off.
   */
  pickSketches: boolean;
}

export const PROJECTION_OP_SPECS: Record<ProjectionOp, ProjectionOpSpec> = {
  project: {
    title: 'Project',
    editTitle: 'Edit projection',
    icon: '/icons/projection.png',
    pickPrompt: 'Pick edges, faces or sketches',
    repickPrompt: 'Pick edges, faces or sketches to re-source',
    emptyMessage: 'Pick the edges, faces or sketches to project.',
    failMessage: 'Could not apply the projection.',
    confirmLabel: 'Expose and project',
    foreign: { verb: 'projects', gerund: 'Projecting' },
    picks: ['edge', 'face'],
    pickFilter: 'all',
    pickSketches: true,
  },
  intersect: {
    title: 'Intersect',
    editTitle: 'Edit intersection',
    icon: '/icons/intersect.png',
    pickPrompt: 'Pick faces',
    repickPrompt: 'Pick faces to re-source',
    emptyMessage: 'Pick the faces to intersect with the sketch plane.',
    failMessage: 'Could not apply the intersection.',
    confirmLabel: 'Expose and intersect',
    foreign: { verb: 'intersects', gerund: 'Intersecting' },
    picks: ['face'],
    pickFilter: 'face',
    pickSketches: false,
  },
};
