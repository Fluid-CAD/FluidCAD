import { SceneObject, SourceLocation } from "../common/scene-object.js";
import { Edge } from "../common/edge.js";
import { Vertex } from "../common/vertex.js";
import { Point2D } from "../math/point.js";
import { EdgeQuery } from "../oc/edge-query.js";
import { Sketch } from "../features/2d/sketch.js";
import { GeometrySceneObject } from "../features/2d/geometry.js";
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

  const chained = !hasExplicitStart(owner) && start.equals(incomingPos, CHAIN_EPSILON);
  if (!chained) {
    return { ok: false, reason: 'only segments that continue the chain can be converted' };
  }

  switch (currentKind) {
    case 'line-two-points':
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: lineConversions(start, end, incomingTangent),
      };
    case 'hline':
    case 'vline':
    case 'tline':
    case 'aline':
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: [{ target: 'free', enabled: true, newStatement: `line(${fmtPoint(end)})` }],
      };
    case 'arc':
      return {
        ok: true,
        sourceLocation,
        currentKind,
        options: [arcToTangentArc(resolved, start, end, incomingTangent)],
      };
    case 'tarc-to-point':
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

/** The constrained-line targets for a chained free line. */
function lineConversions(start: Point2D, end: Point2D, incomingTangent: Point2D): ConversionOption[] {
  const d = end.subtract(start);
  const length = d.length();
  if (length < 1e-9) {
    const reason = 'the segment has zero length';
    return (['aLine', 'hLine', 'vLine', 'tLine'] as const)
      .map(target => ({ target, enabled: false, reason }));
  }

  const options: ConversionOption[] = [];

  // aLine: lossless reparameterization (up to 2dp rounding) — always legal.
  options.push({
    target: 'aLine',
    enabled: true,
    newStatement: `aLine(${fmt(signedAngleDeg(incomingTangent, d))}, ${fmt(length)})`,
  });

  options.push(axisConversion('hLine', d, new Point2D(1, 0), start, end,
    delta => new Point2D(round2(delta.x), 0), () => fmt(d.x), 'horizontal'));
  options.push(axisConversion('vLine', d, new Point2D(0, 1), start, end,
    delta => new Point2D(0, round2(delta.y)), () => fmt(d.y), 'vertical'));

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
  axis: Point2D,
  start: Point2D,
  end: Point2D,
  snappedDelta: (d: Point2D) => Point2D,
  renderArg: () => string,
  axisName: string,
): ConversionOption {
  const angle = angleBetweenDeg(d, axis);
  const offAngle = Math.min(angle, 180 - angle);
  if (offAngle > CONVERSION_TOLERANCE_DEG) {
    return {
      target,
      enabled: false,
      reason: `line is ${fmtAngle(offAngle)} off ${axisName} — more than the ${CONVERSION_TOLERANCE_DEG}° snap tolerance`,
    };
  }
  const newEnd = start.add(snappedDelta(d));
  return {
    target,
    enabled: true,
    newStatement: `${target}(${renderArg()})`,
    endpointDelta: newEnd.distanceTo(end),
  };
}

/** `arc(...).center(...)` → `tArc([ex, ey])`, legal when start tangent ≈ incoming. */
function arcToTangentArc(
  resolved: ResolvedSegment,
  start: Point2D,
  end: Point2D,
  incomingTangent: Point2D,
): ConversionOption {
  const plane = resolved.sketch.getPlane();
  let center: Point2D;
  try {
    center = plane.worldToLocal(EdgeQuery.getCircleDataFromEdge(resolved.edge).center);
  } catch {
    return { target: 'tArc', enabled: false, reason: 'the arc\'s circle geometry could not be read' };
  }

  const endTangent = resolved.owner.getTangent();
  if (!endTangent) {
    return { target: 'tArc', enabled: false, reason: 'the arc did not record its end tangent — re-render and try again' };
  }

  const orientation = arcOrientation(endTangent, end, center);
  const startTangent = perp(start.subtract(center)).normalize().multiplyScalar(orientation);

  const offAngle = angleBetweenDeg(startTangent, incomingTangent);
  if (offAngle > CONVERSION_TOLERANCE_DEG) {
    return {
      target: 'tArc',
      enabled: false,
      reason: `the arc's start is ${fmtAngle(offAngle)} off the incoming tangent — more than the ${CONVERSION_TOLERANCE_DEG}° snap tolerance`,
    };
  }

  // tArc solves the center from tangency; a chord along the tangent has no
  // solution (TangentArcToPoint refuses collinear endpoints).
  const chord = end.subtract(start);
  const offChord = Math.abs(chord.x * incomingTangent.y - chord.y * incomingTangent.x);
  if (offChord < 1e-9) {
    return { target: 'tArc', enabled: false, reason: 'the arc\'s endpoint lies along the incoming tangent — a tangent arc cannot reach it' };
  }

  return { target: 'tArc', enabled: true, newStatement: `tArc(${fmtPoint(end)})` };
}

/** `tArc([ex, ey])` → `arc([ex, ey]).center([cx, cy])` (+ `.cw()`) — always legal. */
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
