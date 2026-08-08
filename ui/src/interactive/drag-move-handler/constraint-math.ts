import { angleFromCenter } from '../tools/tool-preview-utils';

export function constrainToPerpBisector(
  point: [number, number],
  fixedVertex: [number, number],
  fixedVertex2: [number, number],
): [number, number] {
  const mx = (fixedVertex[0] + fixedVertex2[0]) / 2;
  const my = (fixedVertex[1] + fixedVertex2[1]) / 2;
  const dx = fixedVertex2[0] - fixedVertex[0];
  const dy = fixedVertex2[1] - fixedVertex[1];
  const px = -dy;
  const py = dx;
  const lenSq = px * px + py * py;
  if (lenSq < 1e-10) {
    return point;
  }
  const t = ((point[0] - mx) * px + (point[1] - my) * py) / lenSq;
  return [mx + t * px, my + t * py];
}

export function constrainToTangentPerp(
  point: [number, number],
  startV: [number, number],
  tangent: [number, number],
): [number, number] {
  const px = -tangent[1];
  const py = tangent[0];
  const t = (point[0] - startV[0]) * px + (point[1] - startV[1]) * py;
  return [startV[0] + t * px, startV[1] + t * py];
}

export function computeTangentArc(
  start: [number, number],
  end: [number, number],
  tangent: [number, number],
): { center: [number, number]; radius: number; startAngle: number; endAngle: number; ccw: boolean } | null {
  const perpX = -tangent[1];
  const perpY = tangent[0];
  const dx = start[0] - end[0];
  const dy = start[1] - end[1];
  const distSq = dx * dx + dy * dy;
  const dDotN = dx * perpX + dy * perpY;
  if (Math.abs(dDotN) < 1e-10) {
    return null;
  }
  const t = -distSq / (2 * dDotN);
  const radius = Math.abs(t);
  const center: [number, number] = [start[0] + perpX * t, start[1] + perpY * t];
  const startAngle = angleFromCenter(center, start);
  const endAngle = angleFromCenter(center, end);
  return { center, radius, startAngle, endAngle, ccw: t >= 0 };
}

/**
 * The arc a `tArc(radius, endPoint)` statement builds — UI mirror of the
 * kernel's TangentArcRadiusToPoint. Tangency is always preserved: the
 * radius fixes the circle tangent to `tangent` at `start` (the aim point
 * picks the nearer of the two sides), and the arc ends at the point on that
 * circle closest to `aim`. Null only for degenerate input (zero radius, aim
 * on the center, aim projecting onto the start).
 */
export function computeFixedRadiusArc(
  start: [number, number],
  aim: [number, number],
  radius: number,
  tangent: [number, number],
): { center: [number, number]; radius: number; startAngle: number; endAngle: number; ccw: boolean; end: [number, number] } | null {
  const absR = Math.abs(radius);
  if (absR <= 0) {
    return null;
  }
  const lx = radius >= 0 ? tangent[0] : -tangent[0];
  const ly = radius >= 0 ? tangent[1] : -tangent[1];
  // Circle centers sit on the perpendicular to the leave direction at start.
  const px = -ly;
  const py = lx;
  const left: [number, number] = [start[0] + px * absR, start[1] + py * absR];
  const right: [number, number] = [start[0] - px * absR, start[1] - py * absR];
  const dLeft = Math.hypot(aim[0] - left[0], aim[1] - left[1]);
  const dRight = Math.hypot(aim[0] - right[0], aim[1] - right[1]);
  const ccw = dRight >= dLeft;
  const center = ccw ? left : right;

  const toAimX = aim[0] - center[0];
  const toAimY = aim[1] - center[1];
  const aimDist = Math.hypot(toAimX, toAimY);
  if (aimDist < 1e-9) {
    return null;
  }
  const end: [number, number] = [
    center[0] + (toAimX / aimDist) * absR,
    center[1] + (toAimY / aimDist) * absR,
  ];
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 1e-9) {
    return null;
  }

  return {
    center,
    radius: absR,
    startAngle: angleFromCenter(center, start),
    endAngle: angleFromCenter(center, end),
    ccw,
    end,
  };
}

/**
 * Where a `tArc(radius, endPoint)` end drag actually lands: the dragged
 * point projected onto the tangent circle nearer to it, so the committed
 * endpoint is always on the arc's circle.
 */
export function projectToTangentArcEnd(
  start: [number, number],
  tangent: [number, number],
  radius: number,
  point: [number, number],
): [number, number] | null {
  return computeFixedRadiusArc(start, point, radius, tangent)?.end ?? null;
}

export function computeArcCenter(
  oldCenter: [number, number],
  pointA: [number, number],
  pointB: [number, number],
): [number, number] {
  const mx = (pointA[0] + pointB[0]) / 2;
  const my = (pointA[1] + pointB[1]) / 2;
  const dx = pointB[0] - pointA[0];
  const dy = pointB[1] - pointA[1];
  const px = -dy;
  const py = dx;
  const lenSq = px * px + py * py;
  if (lenSq < 1e-10) {
    return oldCenter;
  }
  const cx = oldCenter[0] - mx;
  const cy = oldCenter[1] - my;
  const t = (cx * px + cy * py) / lenSq;
  return [mx + t * px, my + t * py];
}
