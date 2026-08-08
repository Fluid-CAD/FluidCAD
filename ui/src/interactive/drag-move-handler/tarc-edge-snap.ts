import { computeFixedRadiusArc } from './constraint-math';
import { closestPointOnSegment, TarcTargetEntry } from '../sketch-edge-utils';

/** An edge this close to the arc's start is the segment the arc leaves from. */
const TOUCH_EPSILON = 1e-3;
/** Intersections under this sweep (radians) are the start point itself. */
const MIN_SWEEP = 1e-6;

export type TarcEdgeSnap = {
  shapeId: string;
  /** The on-circle intersection the kernel's to-target solve will land on. */
  point: [number, number];
  /** The to-target overload's radius sign for the solved sweep (+1 = CCW). */
  sign: 1 | -1;
  segments: TarcTargetEntry['segments'];
};

/**
 * The edge snap for a `tArc(radius, endPoint)` end drag: with the radius and
 * tangency fixed, the reachable snap positions are the intersections of the
 * drag's tangent circle with a candidate edge — and of those, only the FIRST
 * along the arc's sweep matches what the kernel's to-target overload will
 * build. Returns the nearest such intersection within `threshold` of the
 * glued cursor position, or null when nothing qualifies.
 */
export function solveTarcEdgeSnap(
  start: [number, number],
  leaveDir: [number, number],
  radius: number,
  aim: [number, number],
  targets: TarcTargetEntry[],
  threshold: number,
  /**
   * Targets at or after this source line are the arc itself or later
   * statements — their variable would be read before its declaration.
   */
  excludeFromLine: number,
): TarcEdgeSnap | null {
  const arc = computeFixedRadiusArc(start, aim, radius, leaveDir);
  if (!arc) {
    return null;
  }

  let best: { target: TarcTargetEntry; point: [number, number]; dist: number } | null = null;
  for (const target of targets) {
    if (target.ownerLine >= excludeFromLine) {
      continue;
    }
    // The edge the arc leaves from (it touches the start) is never a target.
    let touchesStart = false;
    for (const seg of target.segments) {
      if (closestPointOnSegment(start[0], start[1], seg.ax, seg.ay, seg.bx, seg.by).dist <= TOUCH_EPSILON) {
        touchesStart = true;
        break;
      }
    }
    if (touchesStart) {
      continue;
    }

    const hit = firstIntersectionAlongSweep(arc, target.segments);
    if (!hit) {
      continue;
    }
    const dist = Math.hypot(hit[0] - arc.end[0], hit[1] - arc.end[1]);
    if (dist <= threshold && (!best || dist < best.dist)) {
      best = { target, point: hit, dist };
    }
  }

  if (!best) {
    return null;
  }
  return {
    shapeId: best.target.shapeId,
    point: best.point,
    sign: arc.ccw ? 1 : -1,
    segments: best.target.segments,
  };
}

/**
 * The circle∩segments intersection with the smallest sweep from the arc's
 * start in its sweep direction — the endpoint the kernel's solver picks.
 */
function firstIntersectionAlongSweep(
  arc: { center: [number, number]; radius: number; startAngle: number; ccw: boolean },
  segments: TarcTargetEntry['segments'],
): [number, number] | null {
  const TWO_PI = Math.PI * 2;
  let bestSweep = Infinity;
  let bestPoint: [number, number] | null = null;
  for (const seg of segments) {
    for (const p of circleSegmentIntersections(arc.center, arc.radius, seg)) {
      const ang = Math.atan2(p[1] - arc.center[1], p[0] - arc.center[0]);
      let sweep = arc.ccw ? ang - arc.startAngle : arc.startAngle - ang;
      sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI;
      if (sweep < MIN_SWEEP) {
        continue;
      }
      if (sweep < bestSweep) {
        bestSweep = sweep;
        bestPoint = p;
      }
    }
  }
  return bestPoint;
}

function circleSegmentIntersections(
  center: [number, number],
  radius: number,
  seg: { ax: number; ay: number; bx: number; by: number },
): [number, number][] {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const fx = seg.ax - center[0];
  const fy = seg.ay - center[1];
  const a = dx * dx + dy * dy;
  if (a < 1e-20) {
    return [];
  }
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return [];
  }
  const sq = Math.sqrt(disc);
  const out: [number, number][] = [];
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t >= 0 && t <= 1) {
      out.push([seg.ax + t * dx, seg.ay + t * dy]);
    }
  }
  // A tangential (disc≈0) contact yields the same point twice — harmless,
  // both resolve to the same sweep.
  return out;
}
