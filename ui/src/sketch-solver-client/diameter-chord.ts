// Where a diameter dimension lays its chord (sketch-rewrite P5.6).
//
// A diameter only READS as a diameter when its leader crosses the whole
// circle — rim to rim through the center — with the value riding that line
// rather than floating off the rim the way a radius does. Which way the
// chord points is the single choice to make, and it has to be made here, in
// sketch space: the screen-space declutterer slides the label ALONG the
// line but never moves the line itself, so a chord laid down the middle of
// a spoke stays there at every zoom.
//
// The answer is a pure function of the read model, which is what lets the
// toolbar's placement preview draw exactly the chord the committed glyph
// will (legality.ts's dimensionPreviewLayout).

import type { SolvedEntityView, SolvedSketchModel } from './model';
import { Vec2, add, arcMidPoint, dist, entityFor, normalize, scale, sub } from './resolve';
import { tessellateSolvedEntity } from './tessellate';

/** 45°, where a radius leader already points (resolve.ts's entityAnchor):
 * a lone diameter then reads like every other radial dim around it. */
const BASE_ANGLE = Math.PI / 4;
/** Angle between candidate chords — six of them cover the 180° of
 * genuinely distinct directions a chord through a center has. */
const FAN_STEP = Math.PI / 6;
/** Search order around the circle's own slot: its angle first, then
 * alternating outward. */
const FAN_ORDER = [0, 1, -1, 2, -2, 3];
/** Cost of running the chord through another entity's curve. */
const CROSS_COST = 1;
/** Tie-break toward the earlier — i.e. the more conventional — candidate. */
const ORDER_COST = 0.1;
/** Crossing-probe resolution: ~2% of the radius in chord error, far below
 * anything a dimension line placement could tell apart. */
const PROBE_SEGMENTS = 16;
/** Centers within this fraction of the smaller radius draw their chords on
 * top of each other — near enough to count as concentric and fan apart. */
const CONCENTRIC_FRACTION = 0.05;

/**
 * The chord a diameter dimension on `e` draws: rim to rim through the
 * center, pointed away from whatever else the circle contains. Null when
 * the view carries no usable circle.
 */
export function diameterChord(
  model: SolvedSketchModel,
  e: SolvedEntityView,
): [Vec2, Vec2] | null {
  const center = e.center;
  const radius = e.radius;
  if (!center || radius === undefined || !(radius > 0)) {
    return null;
  }
  const dir = chordDir(model, e, center, radius);
  return [add(center, scale(dir, -radius)), add(center, scale(dir, radius))];
}

function angleDir(angle: number): Vec2 {
  return [Math.cos(angle), Math.sin(angle)];
}

function chordDir(
  model: SolvedSketchModel,
  e: SolvedEntityView,
  center: Vec2,
  radius: number,
): Vec2 {
  // An arc draws only part of its circle: aim the chord through the drawn
  // side so at least one end lands on geometry the user can actually see.
  if (e.kind === 'arc') {
    const at = arcMidPoint(e);
    return at ? normalize(sub(at, center)) : angleDir(BASE_ANGLE);
  }
  // One tessellation pass, reused by every candidate.
  const probes: Vec2[][] = [];
  for (const other of model.entities.values()) {
    if (other.entityId === e.entityId) {
      continue;
    }
    const points = tessellateSolvedEntity(other, other.kind === 'line' ? 1 : PROBE_SEGMENTS);
    if (points && points.length > 1) {
      probes.push(points);
    }
  }

  const slot = concentricSlot(model, e, center, radius);
  let best = angleDir(BASE_ANGLE + slot * FAN_STEP);
  let bestCost = Infinity;
  FAN_ORDER.forEach((offset, i) => {
    const dir = angleDir(BASE_ANGLE + (slot + offset) * FAN_STEP);
    const from = add(center, scale(dir, -radius));
    const to = add(center, scale(dir, radius));
    const cost = crossings(probes, from, to) * CROSS_COST + i * ORDER_COST;
    if (cost < bestCost) {
      bestCost = cost;
      best = dir;
    }
  });
  return best;
}

/**
 * Which fan slot this circle's chord starts from.
 *
 * Concentric dimensions are the one case a fixed direction visibly fails:
 * every chord runs through the shared center, so they would all draw the
 * same line. A radius leader cannot move — it always runs out at
 * BASE_ANGLE — so radii collectively claim slot 0 and the concentric
 * diameters take the slots after them, ordered by entity id so the fan
 * survives a re-solve unchanged.
 */
function concentricSlot(
  model: SolvedSketchModel,
  e: SolvedEntityView,
  center: Vec2,
  radius: number,
): number {
  const pinned = new Set<number>();
  const fanned = new Set<number>();
  for (const c of model.constraints) {
    if (c.spec.kind !== 'radius' && c.spec.kind !== 'diameter') {
      continue;
    }
    const peer = entityFor(model, c.spec.a);
    // Self counts as its own peer for a RADIUS: a circle carrying both dims
    // must still keep the two leaders apart.
    if (!peer || !isConcentric(peer, center, radius)) {
      continue;
    }
    if (c.spec.kind === 'radius') {
      pinned.add(peer.entityId);
    } else if (peer.entityId !== e.entityId) {
      fanned.add(peer.entityId);
    }
  }
  let slot = pinned.size > 0 ? 1 : 0;
  for (const id of fanned) {
    if (id < e.entityId && !pinned.has(id)) {
      slot += 1;
    }
  }
  return slot;
}

function isConcentric(peer: SolvedEntityView, center: Vec2, radius: number): boolean {
  if (!peer.center || peer.radius === undefined) {
    return false;
  }
  return dist(peer.center, center) <= CONCENTRIC_FRACTION * Math.min(peer.radius, radius);
}

/** How many other entities the chord runs through — the tie-break that
 * keeps a diameter line off the spokes and ribs inside its circle. Counted
 * per entity, not per segment: one curve crossed twice is still one
 * collision to the eye. */
function crossings(probes: Vec2[][], from: Vec2, to: Vec2): number {
  let count = 0;
  for (const points of probes) {
    for (let i = 1; i < points.length; i++) {
      if (segmentsCross(from, to, points[i - 1], points[i])) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function turn(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Proper segment crossing — a shared endpoint does not count. The chord's
 * own ends sit ON the rim, and a line that merely meets the circle there is
 * touching the dimension, not running through it. */
function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = turn(a1, a2, b1);
  const d2 = turn(a1, a2, b2);
  const d3 = turn(b1, b2, a1);
  const d4 = turn(b1, b2, a2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
