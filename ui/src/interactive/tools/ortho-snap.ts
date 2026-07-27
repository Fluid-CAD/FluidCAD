/**
 * A drawn line whose angle falls within this many degrees of an axis is
 * auto-committed as an hLine (near-horizontal) or vLine (near-vertical).
 * Hold Ctrl while drawing to disable this and emit a free line at the exact
 * cursor angle.
 */
export const AUTO_ORTHO_ANGLE_DEG = 5;
const AUTO_ORTHO_ANGLE_RAD = (AUTO_ORTHO_ANGLE_DEG * Math.PI) / 180;

export type LineDirection = 'horizontal' | 'vertical' | 'free';

export function classifyDelta(dx: number, dy: number, forceFree: boolean): LineDirection {
  if (forceFree) {
    return 'free';
  }
  if (dx === 0 && dy === 0) {
    return 'free';
  }
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  if (angle <= AUTO_ORTHO_ANGLE_RAD) {
    return 'horizontal';
  }
  if (angle >= Math.PI / 2 - AUTO_ORTHO_ANGLE_RAD) {
    return 'vertical';
  }
  return 'free';
}

export function orthoEffectiveEnd(
  start: [number, number],
  mouse: [number, number],
  dir: LineDirection,
): [number, number] {
  if (dir === 'horizontal') {
    return [mouse[0], start[1]];
  }
  if (dir === 'vertical') {
    return [start[0], mouse[1]];
  }
  return mouse;
}
