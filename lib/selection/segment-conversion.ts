import { SceneObject, SourceLocation } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { Point2D } from "../math/point.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { Sketch } from "../features/2d/sketch.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
import { Move } from "../features/2d/move.js";
import { checkSketchBindable } from "./sketch-apply.js";
import { SelectionScene } from "./types.js";

export type ConversionTarget = 'hLine' | 'vLine' | 'tLine' | 'aLine' | 'tArc' | 'free';

export type ConversionOption = {
  target: ConversionTarget;
  enabled: boolean;
  /** Human-readable, for disabled-button tooltips. */
  reason?: string;
  /** Fully rendered call chain, e.g. `aLine(45, 141.42)`. */
  newStatement?: string;
  /** |new end − old end|, for the UI to warn on snap size. */
  endpointDelta?: number;
  /**
   * Start-tangent deviation (degrees) an arc→tArc conversion re-bulges away.
   * Only present beyond the snap tolerance — the endpoints stay put, but the
   * arc visibly reshapes, so the UI warns.
   */
  reshapeAngle?: number;
};

export type SegmentConversionsResult = {
  ok: boolean;
  reason?: string;
  sourceLocation?: SourceLocation;
  /** uniqueType of the owning feature, e.g. `line-two-points`. */
  currentKind?: string;
  options?: ConversionOption[];
};

/**
 * Enablement tolerance for the snap conversions, matching draw-time
 * auto-ortho (AUTO_ORTHO_ANGLE_DEG in the UI's line tool). Converting snaps
 * the geometry exactly.
 */
export const CONVERSION_TOLERANCE_DEG = 5;

/** All emitted parameters round to drawing precision. */
function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function fmt(value: number): string {
  return String(round2(value));
}

function fmtPoint(point: Point2D): string {
  return `[${fmt(point.x)}, ${fmt(point.y)}]`;
}

function fmtAngle(deg: number): string {
  const rounded = Math.round(deg * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}°`;
}

/** Unsigned angle between two directions, degrees in [0, 180]. */
function angleBetweenDeg(a: Point2D, b: Point2D): number {
  const dot = a.x * b.x + a.y * b.y;
  const cross = a.x * b.y - a.y * b.x;
  return Math.abs(Math.atan2(cross, dot)) * 180 / Math.PI;
}

/** Signed CCW angle from `from` to `to`, degrees in (-180, 180]. */
function signedAngleDeg(from: Point2D, to: Point2D): number {
  const dot = from.x * to.x + from.y * to.y;
  const cross = from.x * to.y - from.y * to.x;
  return Math.atan2(cross, dot) * 180 / Math.PI;
}

function perp(v: Point2D): Point2D {
  return new Point2D(-v.y, v.x);
}

const CHAIN_EPSILON = 1e-6;

type ResolvedSegment = {
  sketch: Sketch;
  owner: GeometrySceneObject;
  edge: Edge;
};

/** Resolve `{shapeId}` to its edge and owning feature across all sketches. */
function resolveSegment(scene: SelectionScene, shapeId: string): ResolvedSegment | null {
  const sketches = scene.getAllSceneObjects()
    .filter((o): o is Sketch => o instanceof Sketch);

  for (const sketch of sketches) {
    for (const [edge, owner] of sketch.getEdgesWithOwner()) {
      if (edge.id === shapeId && owner instanceof GeometrySceneObject) {
        return { sketch, owner, edge };
      }
    }
  }
  return null;
}

/**
 * A second feature call on the owner's source line breaks line-granular
 * statement addressing — the same limitation as every edit dialog.
 */
function sharesSourceLine(sketch: Sketch, owner: SceneObject, loc: SourceLocation): boolean {
  for (const child of sketch.getChildren()) {
    if (child === owner || child.isLazy() || child.isSelection()) {
      continue;
    }
    // An explicit-start statement (`line([a], [b])`, `aLine([a], …)`) is one
    // statement but TWO children — a cursor Move plus the segment. The Move
    // shares the statement's line by construction and is never itself a
    // conversion target, so it must not read as a conflicting statement.
    if (child instanceof Move) {
      continue;
    }
    const childLoc = child.getSourceLocation();
    if (childLoc && childLoc.filePath === loc.filePath && childLoc.line === loc.line) {
      return true;
    }
  }
  return false;
}

/** Serialized explicit-start signal per feature form. */
function hasExplicitStart(owner: GeometrySceneObject): boolean {
  const payload = owner.serialize() as Record<string, unknown>;
  if (owner.getUniqueType() === 'arc') {
    return payload.startPoint !== undefined;
  }
  return payload.hasExplicitStart === true;
}

/**
 * Orientation of a circular segment: +1 for CCW (in sketch-local coords),
 * -1 for CW — recovered from the built end tangent, which is the CCW
 * tangent `perp(end − center)` negated for CW arcs.
 */
function arcOrientation(endTangent: Point2D, end: Point2D, center: Point2D): number {
  const ccwTangent = perp(end.subtract(center)).normalize();
  const dot = endTangent.x * ccwTangent.x + endTangent.y * ccwTangent.y;
  return dot >= 0 ? 1 : -1;
}

export function listSegmentConversions(
  scene: SelectionScene,
  ref: { shapeId: string },
): SegmentConversionsResult {
  const resolved = resolveSegment(scene, ref.shapeId);
  if (!resolved) {
    return { ok: false, reason: 'the pick does not resolve to a sketch segment in the current scene' };
  }
  const { sketch, owner } = resolved;

  const bindFailure = checkSketchBindable(scene, owner);
  if (bindFailure) {
    return { ok: false, reason: bindFailure };
  }

  const sourceLocation = owner.getSourceLocation()!;
  if (sharesSourceLine(sketch, owner, sourceLocation)) {
    return { ok: false, reason: 'another statement shares this segment\'s source line — put each segment on its own line to convert it' };
  }

  const currentKind = owner.getUniqueType();
  const startVertex = owner.getState('start') as Vertex | undefined;
  const endVertex = owner.getState('end') as Vertex | undefined;
  if (!startVertex || !endVertex) {
    return { ok: false, reason: 'the segment did not record its endpoints — re-render and try again' };
  }
  const start = startVertex.toPoint2D();
  const end = endVertex.toPoint2D();

  const incomingTangent = sketch.getTangentAt(owner).normalize();
  const incomingPos = sketch.getPositionAt(owner);

  // An explicit-start segment converts with its start preserved (the [start]
  // overloads); a chained one must actually continue the chain.
  const explicitStart = hasExplicitStart(owner);
  if (!explicitStart && !start.equals(incomingPos, CHAIN_EPSILON)) {
    return { ok: false, reason: 'only segments that continue the chain can be converted' };
  }
  // Line forms have [start] overloads to preserve a detached start; the arc
  // targets (tArc) do not, so explicit-start arcs stay unconvertible.
  if (explicitStart && currentKind !== 'line-two-points'
    && currentKind !== 'hline' && currentKind !== 'vline' && currentKind !== 'aline') {
    return { ok: false, reason: 'only segments that continue the chain can be converted' };
  }

  switch (currentKind) {
    case 'line-two-points':
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: lineConversions(start, end, incomingTangent, explicitStart),
      };
    case 'hline':
    case 'vline':
    case 'tline':
    case 'aline': {
      // A constrained line converts to every other line form — same
      // geometry, different parameterization — plus the free door back.
      const self: Record<string, ConversionTarget> = {
        hline: 'hLine', vline: 'vLine', tline: 'tLine', aline: 'aLine',
      };
      const startArg = explicitStart ? `${fmtPoint(start)}, ` : '';
      const options = lineConversions(start, end, incomingTangent, explicitStart)
        .filter(option => option.target !== self[currentKind]);
      options.push({
        target: 'free',
        enabled: true,
        newStatement: `line(${startArg}${fmtPoint(end)})`,
      });
      return { ok: true, sourceLocation, currentKind, options };
    }
    case 'arc':
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: [arcToTangentArc(resolved, start, end, incomingTangent)],
      };
    case 'tarc-to-point':
    case 'tarc-radius-to-point':
    case 'tarc-radius-to-object':
      // Already a tangent arc — the only way out is dropping the tangency
      // constraint entirely (the free arc form). The to-object form also
      // drops its target reference: the emitted arc carries the built
      // geometry verbatim, no longer following the referenced edge.
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: [tangentArcToFree(resolved, end)],
      };
    default:
      return { ok: false, reason: `no conversions are available for ${currentKind} segments` };
  }
}

/**
 * The constrained-line targets for a line segment. With `explicitStart`, the
 * emissions carry the start point via the `[start]` overloads and the aLine
 * angle is absolute (+X reference — a detached segment has no incoming
 * direction); tLine has no start form, so it stays chain-only.
 */
function lineConversions(
  start: Point2D,
  end: Point2D,
  incomingTangent: Point2D,
  explicitStart: boolean,
): ConversionOption[] {
  const d = end.subtract(start);
  const length = d.length();
  if (length < 1e-9) {
    const reason = 'the segment has zero length';
    return (['aLine', 'hLine', 'vLine', 'tLine'] as const)
      .map(target => ({ target, enabled: false, reason }));
  }

  const startArg = explicitStart ? `${fmtPoint(start)}, ` : '';
  const angleReference = explicitStart ? new Point2D(1, 0) : incomingTangent;

  const options: ConversionOption[] = [];

  // aLine: lossless reparameterization (up to 2dp rounding) — always legal.
  options.push({
    target: 'aLine',
    enabled: true,
    newStatement: `aLine(${startArg}${fmt(signedAngleDeg(angleReference, d))}, ${fmt(length)})`,
  });

  options.push(axisConversion('hLine', d, start, end,
    delta => new Point2D(round2(delta.x), 0), () => `${startArg}${fmt(d.x)}`, 'horizontal'));
  options.push(axisConversion('vLine', d, start, end,
    delta => new Point2D(0, round2(delta.y)), () => `${startArg}${fmt(d.y)}`, 'vertical'));

  if (explicitStart) {
    options.push({
      target: 'tLine',
      enabled: false,
      reason: 'tLine always continues the chain — this segment has its own start point',
    });
    return options;
  }

  // tLine: sign-aware — the anti-parallel case converts with negative length.
  const tangentAngle = angleBetweenDeg(d, incomingTangent);
  const antiParallel = 180 - tangentAngle <= CONVERSION_TOLERANCE_DEG;
  if (tangentAngle <= CONVERSION_TOLERANCE_DEG || antiParallel) {
    const signedLength = round2(antiParallel ? -length : length);
    const newEnd = start.add(incomingTangent.multiplyScalar(signedLength));
    options.push({
      target: 'tLine',
      enabled: true,
      newStatement: `tLine(${fmt(signedLength)})`,
      endpointDelta: newEnd.distanceTo(end),
    });
  } else {
    const offAngle = Math.min(tangentAngle, 180 - tangentAngle);
    options.push({
      target: 'tLine',
      enabled: false,
      reason: `line is ${fmtAngle(offAngle)} off the incoming tangent — more than the ${CONVERSION_TOLERANCE_DEG}° snap tolerance`,
    });
  }

  return options;
}

function axisConversion(
  target: 'hLine' | 'vLine',
  d: Point2D,
  start: Point2D,
  end: Point2D,
  snappedDelta: (d: Point2D) => Point2D,
  renderArg: () => string,
  axisName: string,
): ConversionOption {
  // Any angle converts — the endpoint snaps onto the axis (endpointDelta
  // carries the move size for the UI to warn about). Only a line with no
  // extent along the axis refuses: it would collapse to a zero-length line.
  const snapped = snappedDelta(d);
  if (snapped.length() < 1e-9) {
    return {
      target,
      enabled: false,
      reason: `the line has no ${axisName} extent`,
    };
  }
  const newEnd = start.add(snapped);
  return {
    target,
    enabled: true,
    newStatement: `${target}(${renderArg()})`,
    endpointDelta: newEnd.distanceTo(end),
  };
}

/**
 * `arc(...).center(...)` → `tArc(radius, [ex, ey])` — converts at any start
 * angle: both endpoints are preserved (the tangent-solved radius through the
 * endpoint is written out, so the radius lands as an editable dimension) and
 * the arc re-bulges to start tangent to the chain. Beyond the snap tolerance
 * the reshape is visible, so the option carries `reshapeAngle` for the UI to
 * warn (the axis-snap philosophy — convert anyway, warn about the move).
 */
function arcToTangentArc(
  resolved: ResolvedSegment,
  start: Point2D,
  end: Point2D,
  incomingTangent: Point2D,
): ConversionOption {
  // tArc solves the center from tangency; a chord along the tangent has no
  // solution (the radius diverges).
  const chord = end.subtract(start);
  const offChord = Math.abs(chord.x * incomingTangent.y - chord.y * incomingTangent.x);
  if (offChord < 1e-9) {
    return { target: 'tArc', enabled: false, reason: 'the arc\'s endpoint lies along the incoming tangent — a tangent arc cannot reach it' };
  }

  const radius = (chord.x * chord.x + chord.y * chord.y) / (2 * offChord);
  const option: ConversionOption = { target: 'tArc', enabled: true, newStatement: `tArc(${fmt(radius)}, ${fmtPoint(end)})` };

  // The start-tangent deviation is only a warning now — if the arc's built
  // geometry can't be read the conversion still stands, just unannotated.
  const plane = resolved.sketch.getPlane();
  let center: Point2D;
  try {
    center = plane.worldToLocal(EdgeQuery.getCircleDataFromEdge(resolved.edge).center);
  } catch {
    return option;
  }
  const endTangent = resolved.owner.getTangent();
  if (!endTangent) {
    return option;
  }

  const orientation = arcOrientation(endTangent, end, center);
  const startTangent = perp(start.subtract(center)).normalize().multiplyScalar(orientation);
  const offAngle = angleBetweenDeg(startTangent, incomingTangent);
  if (offAngle > CONVERSION_TOLERANCE_DEG) {
    option.reshapeAngle = offAngle;
  }
  return option;
}

/** A tangent arc (`tArc([e])`, `tArc(r, [e])`, `tArc(r, target)`) →
 * `arc([ex, ey]).center([cx, cy])` (+ `.cw()`) — always legal. */
function tangentArcToFree(resolved: ResolvedSegment, end: Point2D): ConversionOption {
  const plane = resolved.sketch.getPlane();
  let center: Point2D;
  try {
    center = plane.worldToLocal(EdgeQuery.getCircleDataFromEdge(resolved.edge).center);
  } catch {
    return { target: 'free', enabled: false, reason: 'the arc\'s circle geometry could not be read' };
  }

  const endTangent = resolved.owner.getTangent();
  const cw = endTangent ? arcOrientation(endTangent, end, center) < 0 : false;
  const cwSuffix = cw ? '.cw()' : '';

  return {
    target: 'free',
    enabled: true,
    newStatement: `arc(${fmtPoint(end)}).center(${fmtPoint(center)})${cwSuffix}`,
  };
}
