// Placed dimension labels: the math behind `.labelAt(u, v)`.
//
// A dimension dragged in the sketcher stops being laid out automatically and
// sits where it was dropped. Where that is, is stored in the dimension's OWN
// frame rather than in sketch coordinates, so the placement follows the
// geometry it measures when a parameter moves, stretches or turns it — and
// one statement inside a loop places every instance it makes alike.
//
// The three frames:
//   * span    — distance, offsetFrom, an ellipse's semi-radius: `u` along
//               the measured span from its middle, `v` off it. The dimension
//               line is the span shifted by `v`; the value hangs off it at
//               `u`, lying along it.
//   * radial  — radius and diameter of a circle or arc: `(u, v)` from the
//               center along the sketch axes. The leader turns to pass
//               through the point.
//   * angular — angle: `u` out along the bisector of the measured sector
//               from its corner, `v` to the side. The arc is drawn through
//               the point.
//
// In every frame the stored point is where the value ATTACHES to its
// dimension — a point on the dimension line, the leader or the arc. The
// drawn text sits one clearance off that point (`push`), like the automatic
// layout's "one gap clear of the line", so a value never lies on the line it
// belongs to. That clearance is a pixel amount, so only the sprite layer and
// the drag know it; everything here takes it as an argument and stays pure:
// no camera, no Three, testable from plain numbers.

import { angleWithinSweep } from './tessellate';
import { Vec2, add, mid, norm, normalize, perp, scale, sub } from './resolve';

/** A label position in its dimension's own frame — the `.labelAt()` pair. */
export type LabelCoords = [number, number];

/** Which ends of a dimension line carry an arrowhead (see glyphs.ts). */
type Arrows = 'both' | 'end';

/** A circular stretch: from angle `a0`, sweeping `sweep` (signed radians,
 * positive counterclockwise) around `center`. */
export type ArcStretch = { center: Vec2; radius: number; a0: number; sweep: number };

export type SpanFrame = {
  type: 'span';
  /** The two ends of what is measured. */
  from: Vec2;
  to: Vec2;
  /** The real point behind `to` when `to` is a synthetic corner — an
   * axis-locked distance measures one component, so its span ends level with
   * the second point rather than on it. Witness lines start here. */
  toAnchor: Vec2;
  arrows: Arrows;
};

export type RadialFrame = {
  type: 'radial';
  center: Vec2;
  radius: number;
  /** A diameter's leader crosses the whole circle; a radius' starts at the
   * center. */
  diameter: boolean;
  /** The drawn sweep of an arc; absent for a full circle. */
  arc?: { a0: number; sweep: number };
};

export type AngularFrame = {
  type: 'angular';
  /** The corner: where the two lines meet. */
  at: Vec2;
  /** Ray angle of the first line, and the counterclockwise sweep to the
   * second (radians, positive). */
  startAngle: number;
  sweep: number;
};

/** What a dimension measures, reduced to the frame its label is placed in. */
export type DimensionFrame = SpanFrame | RadialFrame | AngularFrame;

/** The drawable geometry of a placed dimension, in sketch-local 2D. */
export type PlacedDimension = {
  /** Where the value attaches to its dimension. */
  attach: Vec2;
  /** Unit direction the drawn text is pushed off `attach`. */
  push: Vec2;
  /** Unit direction of the dimension at `attach` — the line's own direction,
   * or the arc's tangent. An aligned value rolls to it. */
  along: Vec2;
  /** Span and radial dimensions: the dimension line. */
  line?: {
    from: Vec2;
    to: Vec2;
    arrows: Arrows;
    /** Continuation from the line's end out to a value parked beyond it. */
    tail?: [Vec2, Vec2];
    /** Dashed witness lines from the measured points to a dimension line
     * that stands off them. */
    witnesses: [Vec2, Vec2][];
    /** Dashed continuations of an arc to where its leader lands off it. */
    witnessArcs: ArcStretch[];
  };
  /** Angle dimensions: the arc, plus a dashed continuation when the value
   * sits outside the measured sector. */
  arc?: { radius: number; witness?: ArcStretch };
};

/**
 * Whether a placed value lies ALONG its dimension — rolled to the line it
 * hangs off, the way a drawing letters a dimension — rather than upright.
 * Every dimension with a straight line to lie along does: a distance along
 * its dimension line, a radius or diameter along its leader. An angle's
 * value rides an arc, which has no one direction to take, and stays upright.
 */
export function labelLiesAlong(frame: DimensionFrame): boolean {
  return frame.type !== 'angular';
}

/** Below this a length is treated as zero — far under anything drawable. */
const EPS = 1e-9;
/** Where a radius leader points when its label sits exactly on the center:
 * the automatic layout's own 45°. */
const DEFAULT_RADIAL_ANGLE = Math.PI / 4;

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function unit(angle: number): Vec2 {
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * The side of a line its value reads from: +1 when `n` already points there,
 * -1 when the value belongs on the other side. Drafting puts a value ABOVE
 * its dimension line, and to the LEFT of a vertical one (read from the right
 * of the sheet) — whichever way the line itself happens to run.
 */
export function readingSide(n: Vec2): 1 | -1 {
  if (n[1] > EPS) {
    return 1;
  }
  if (n[1] < -EPS) {
    return -1;
  }
  return n[0] < 0 ? 1 : -1;
}

/** Unit normal of direction `d`, on the side a value reads from. */
function readingNormal(d: Vec2): Vec2 {
  const n = perp(d);
  return scale(n, readingSide(n));
}

function spanAxes(frame: SpanFrame): { origin: Vec2; dir: Vec2; n: Vec2; half: number } {
  const dir = normalize(sub(frame.to, frame.from));
  return { origin: mid(frame.from, frame.to), dir, n: perp(dir), half: norm(sub(frame.to, frame.from)) / 2 };
}

function angularAxes(frame: AngularFrame): { bisector: Vec2; side: Vec2 } {
  const bisector = unit(frame.startAngle + frame.sweep / 2);
  return { bisector, side: perp(bisector) };
}

/** The sketch point a label position names: where the value attaches. */
export function labelAttach(frame: DimensionFrame, coords: LabelCoords): Vec2 {
  switch (frame.type) {
    case 'span': {
      const { origin, dir, n } = spanAxes(frame);
      return add(origin, add(scale(dir, coords[0]), scale(n, coords[1])));
    }
    case 'radial':
      return add(frame.center, coords);
    case 'angular': {
      const { bisector, side } = angularAxes(frame);
      return add(frame.at, add(scale(bisector, coords[0]), scale(side, coords[1])));
    }
  }
}

/** Inverse of {@link labelAttach}: a sketch point as a label position. */
export function labelCoordsOf(frame: DimensionFrame, attach: Vec2): LabelCoords {
  switch (frame.type) {
    case 'span': {
      const { origin, dir, n } = spanAxes(frame);
      const rel = sub(attach, origin);
      return [dot(rel, dir), dot(rel, n)];
    }
    case 'radial':
      return sub(attach, frame.center);
    case 'angular': {
      const { bisector, side } = angularAxes(frame);
      const rel = sub(attach, frame.at);
      return [dot(rel, bisector), dot(rel, side)];
    }
  }
}

/**
 * The continuation an arc needs to reach `angle`: from whichever of its ends
 * is nearer, by the shorter way round. Null when the arc already covers the
 * angle.
 */
function arcReach(center: Vec2, radius: number, a0: number, sweep: number, angle: number): ArcStretch | null {
  if (angleWithinSweep(a0, sweep, angle, 1e-6)) {
    return null;
  }
  const tau = 2 * Math.PI;
  const turn = sweep >= 0 ? 1 : -1;
  // How far past the START the angle lies, going the arc's own way round.
  let fromStart = ((angle - a0) * turn) % tau;
  if (fromStart < 0) {
    fromStart += tau;
  }
  const pastEnd = fromStart - Math.abs(sweep);
  const beforeStart = tau - fromStart;
  return pastEnd <= beforeStart
    ? { center, radius, a0: a0 + sweep, sweep: turn * pastEnd }
    : { center, radius, a0, sweep: -turn * beforeStart };
}

/**
 * Everything a placed dimension draws. Null when the placement cannot be
 * drawn — an angle's value sitting exactly on its corner has no arc to ride —
 * and the caller falls back to the automatic layout.
 */
export function placedDimension(frame: DimensionFrame, coords: LabelCoords): PlacedDimension | null {
  switch (frame.type) {
    case 'span': {
      const { dir, n, half } = spanAxes(frame);
      if (half < EPS) {
        return null;
      }
      const [u, v] = coords;
      const lift = scale(n, v);
      const from = add(frame.from, lift);
      const to = add(frame.to, lift);
      const attach = labelAttach(frame, coords);
      const stands = Math.abs(v) > EPS;
      const witnesses: [Vec2, Vec2][] = stands
        ? [[frame.from, from], [frame.toAnchor, to]]
        // On the span itself only a synthetic corner still needs tying back
        // to the point it stands for.
        : norm(sub(frame.toAnchor, frame.to)) > EPS ? [[frame.to, frame.toAnchor]] : [];
      const tail: [Vec2, Vec2] | undefined = u > half + EPS ? [to, attach]
        : u < -half - EPS ? [from, attach] : undefined;
      return {
        attach,
        push: readingNormal(dir),
        along: dir,
        line: { from, to, arrows: frame.arrows, ...(tail ? { tail } : {}), witnesses, witnessArcs: [] },
      };
    }

    case 'radial': {
      if (!(frame.radius > EPS)) {
        return null;
      }
      const reach = norm(coords);
      const angle = reach > EPS ? Math.atan2(coords[1], coords[0]) : DEFAULT_RADIAL_ANGLE;
      const dir = unit(angle);
      const attach = add(frame.center, coords);
      const rim = add(frame.center, scale(dir, frame.radius));
      const from = frame.diameter ? add(frame.center, scale(dir, -frame.radius)) : frame.center;
      const witnessArcs: ArcStretch[] = [];
      if (frame.arc) {
        // Every rim the leader lands on has to be ON something: off the
        // drawn arc, the arc is continued (dashed) to meet it.
        for (const landing of frame.diameter ? [angle, angle + Math.PI] : [angle]) {
          const witness = arcReach(frame.center, frame.radius, frame.arc.a0, frame.arc.sweep, landing);
          if (witness) {
            witnessArcs.push(witness);
          }
        }
      }
      return {
        attach,
        // Always the leader's counterclockwise side. A side that flipped to
        // keep the value "above" its leader would open a wedge under the
        // center where no bearing draws the text beneath the cursor; one
        // fixed side keeps the drag exact all the way round.
        push: perp(dir),
        along: dir,
        line: {
          from,
          to: rim,
          arrows: frame.diameter ? 'both' : 'end',
          ...(reach > frame.radius + EPS ? { tail: [rim, attach] as [Vec2, Vec2] } : {}),
          witnesses: [],
          witnessArcs,
        },
      };
    }

    case 'angular': {
      const attach = labelAttach(frame, coords);
      const rel = sub(attach, frame.at);
      const radius = norm(rel);
      if (radius < EPS) {
        return null;
      }
      const out = scale(rel, 1 / radius);
      const witness = arcReach(frame.at, radius, frame.startAngle, frame.sweep, Math.atan2(out[1], out[0]));
      return {
        attach,
        push: out,
        along: perp(out),
        arc: { radius, ...(witness ? { witness } : {}) },
      };
    }
  }
}

export type LabelDragOptions = {
  /**
   * How far the drawn text's center sits off its attach point when pushed
   * along `push`, in SKETCH units — the sprite layer's pixel clearance at
   * the current zoom.
   */
  clearance: (push: Vec2) => number;
  /** Smallest radius an angle's arc may be dragged down to, sketch units. */
  minArcRadius?: number;
};

/**
 * The label position that draws the value's text centered on `center` — what
 * a drag asks for: the text follows the cursor, the dimension line trails one
 * clearance behind it. Exact wherever the dimension can be drawn at all; the
 * two spots it cannot — a radial value pulled closer to the center than its
 * own clearance, an angle's arc pulled tighter than its minimum radius —
 * return the nearest placement that can.
 */
export function labelCoordsForCenter(
  frame: DimensionFrame,
  center: Vec2,
  options: LabelDragOptions,
): LabelCoords {
  switch (frame.type) {
    case 'span': {
      const { origin, dir, n } = spanAxes(frame);
      const push = readingNormal(dir);
      const rel = sub(center, origin);
      // The text rides `clearance` off the line on its reading side, so the
      // line sits that much back from where the text is asked to be.
      return [dot(rel, dir), dot(rel, n) - readingSide(n) * options.clearance(push)];
    }

    case 'radial': {
      const rel = sub(center, frame.center);
      const length = norm(rel);
      if (length < EPS) {
        return [0, 0];
      }
      const bearing = Math.atan2(rel[1], rel[0]);
      // The text sits `k` off the leader on its counterclockwise side, so
      // the leader points that much clockwise of the text: by atan(k / reach),
      // with the attach point where the right angle between them falls.
      const k = options.clearance(perp(unit(bearing)));
      const reach = Math.sqrt(Math.max(length * length - k * k, 0));
      if (reach < EPS) {
        // Closer to the center than the text can be drawn: the value parks
        // on the center itself (and the leader keeps its automatic bearing).
        return [0, 0];
      }
      return scale(unit(bearing - Math.atan2(k, reach)), reach);
    }

    case 'angular': {
      const rel = sub(center, frame.at);
      const length = norm(rel);
      const { bisector } = angularAxes(frame);
      const out = length > EPS ? scale(rel, 1 / length) : bisector;
      const radius = Math.max(length - options.clearance(out), options.minArcRadius ?? 0, EPS * 10);
      return labelCoordsOf(frame, add(frame.at, scale(out, radius)));
    }
  }
}

/** Where the drawn text's center lands for a placement — the inverse of
 * {@link labelCoordsForCenter}, and what the sprite layer draws. */
export function labelCenter(placed: PlacedDimension, clearance: (push: Vec2) => number): Vec2 {
  return add(placed.attach, scale(placed.push, clearance(placed.push)));
}
