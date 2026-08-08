import { DragHitResult } from './types';

/** Which `[x, y]` argument of the statement a point zone rewrites. */
export type PointTarget = { pointIndex: number };

/**
 * The point a (uniqueType, hitZone) pair addresses, or null when the zone
 * carries a scalar dimension instead — the caller then falls through to the
 * dimension editor. This is the read side of the mapping `commitPositionMove`
 * applies on drag, kept in one place so both paths agree.
 *
 * The convention: a body carries the shape's own dimension; an endpoint,
 * centre, corner or pole carries that point's coordinates.
 *
 * A zone only counts as a point when the source really holds one. The end of
 * an hLine/vLine/tLine/aLine has no point argument — its position *is* the
 * segment's scalar, so there is nothing to type coordinates into and the
 * dimension editor owns it.
 */
export function pointTargetFor(hit: DragHitResult): PointTarget | null {
  const { uniqueType, hitZone } = hit;

  if (uniqueType.startsWith('bezier-')) {
    return hit.bezierPoleIndex !== undefined ? { pointIndex: hit.bezierPoleIndex } : null;
  }

  switch (uniqueType) {
    case 'circle':
    case 'polygon':
      return hitZone === 'center' ? { pointIndex: 0 } : null;

    // A rect resizes through setRectDimensions on drag, but its `start` is a
    // plain point argument, so repositioning it is an ordinary point rewrite.
    case 'rect':
      return hitZone === 'start' ? { pointIndex: 0 } : null;

    case 'line-two-points':
      if (hitZone === 'start') {
        return { pointIndex: 0 };
      }
      return hitZone === 'end' ? { pointIndex: -1 } : null;

    // Only the explicit-start form's start is a real argument, and that is
    // the only zone hit detection reports it for. A chained segment's start
    // is the previous segment's end — promoting it would sever the chain.
    // The end is the segment's scalar, so it belongs to the dimension editor.
    case 'hline':
    case 'vline':
    case 'aline':
      return hitZone === 'start' ? { pointIndex: 0 } : null;

    case 'tarc-radius-to-point':
      return hitZone === 'end' ? { pointIndex: 0 } : null;

    case 'tarc-to-point':
      return hitZone === 'end' ? { pointIndex: 0 } : null;

    case 'tarc-to-point-tangent':
      return hitZone === 'end' ? { pointIndex: 1 } : null;

    case 'slot':
      if (hitZone !== 'start' && hitZone !== 'end') {
        return null;
      }
      if (hit.slotHasTwoPoints) {
        return { pointIndex: hit.slotPointIndex ?? 0 };
      }
      // The one-point form's start is a point; its far cap is the distance,
      // which the dimension editor owns.
      return hitZone === 'start' ? { pointIndex: 0 } : null;

    // `arc` writes its centre and endpoint together, so it does not reduce to
    // a single point argument and stays drag-only for now.
    default:
      return null;
  }
}
