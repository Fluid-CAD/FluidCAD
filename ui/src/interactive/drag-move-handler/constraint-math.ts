import { angleFromCenter } from '../tools/tool-preview-utils';

/**
 * The arc a fixed-radius tangent gesture builds — UI mirror of the kernel's
 * tangent-arc-radius-to-point math. Tangency is always preserved: the
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
