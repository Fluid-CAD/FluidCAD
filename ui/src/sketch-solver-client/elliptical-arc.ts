// The elliptical arc as the read model holds it, turned into the span the
// shared geometry helpers work on. One home for the join, so tessellation,
// hit testing, intersections and the tools all read an arc's ellipse, its
// ends and its drawn side the same way.

import {
  ellipseArcSpan,
  type EllipseArcSpan,
  type EllipseFrame,
} from '../../../lib/sketch-solver/earc-geometry.js';
import type { SolvedEntityView } from './model';

/** What the span is read from: a model view, or live geometry mid-drag
 * (which carries no sweep side of its own). */
type EllipseShaped = Pick<SolvedEntityView, 'center' | 'radii' | 'theta' | 'start' | 'end' | 'cw'>;

/** The ellipse of an ellipse view or of an elliptical arc view; null while
 * the view is incomplete or a radius has collapsed. */
export function ellipseFrameOf(e: EllipseShaped): EllipseFrame | null {
  if (!e.center || !e.radii || !(e.radii[0] > 0) || !(e.radii[1] > 0)) {
    return null;
  }
  return { cx: e.center[0], cy: e.center[1], rx: e.radii[0], ry: e.radii[1], theta: e.theta ?? 0 };
}

/** The span an elliptical arc view draws: its ellipse, from its start to
 * its end on its own side. Null while the view is incomplete. */
export function ellipticalArcSpanOf(e: EllipseShaped): EllipseArcSpan | null {
  const frame = ellipseFrameOf(e);
  if (!frame || !e.start || !e.end) {
    return null;
  }
  return ellipseArcSpan(frame, e.start, e.end, e.cw === true);
}
