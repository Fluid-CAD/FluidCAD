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
