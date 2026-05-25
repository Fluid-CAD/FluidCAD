import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  LineDashedMaterial,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { localToWorld } from '../sketch-plane-utils';
import { PlaneData } from '../../types';
import { SnapType } from '../../snapping/types';
import { applyConstantPixelSize } from '../../meshes/screen-scale';

export const START_POINT_COLOR = 0x22cc66;
export const GUIDE_COLOR = 0xb0b0b0;
export const SNAP_VERTEX_COLOR = 0xffc578;
export const SNAP_GRID_COLOR = 0x888888;
export const DOT_RADIUS = 2.5;
export const DOT_SEGMENTS = 16;
export const DOT_PX_RADIUS = 7.5;
export const CIRCLE_SEGMENTS = 64;
export const ARC_SEGMENTS = 64;
export const BEZIER_SEGMENTS = 64;

export function snapDotColor(snapType: SnapType): number {
  return snapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
}

export function addDot(
  previewGroup: Group,
  point2d: [number, number],
  color: number | string,
  _camera: Camera,
  planeNormal: Vector3,
  plane: PlaneData,
  opacity = 1,
  renderOrder = 4,
  radius = DOT_RADIUS,
  pxRadius = DOT_PX_RADIUS,
): void {
  const geo = new CircleGeometry(radius, DOT_SEGMENTS);
  const mat = new MeshBasicMaterial({
    color,
    side: DoubleSide,
    depthTest: false,
    transparent: opacity < 1,
    opacity,
  });
  const dot = new Mesh(geo, mat);
  dot.renderOrder = renderOrder;

  const group = new Group();
  group.renderOrder = renderOrder;
  const pos = localToWorld(point2d, plane);
  group.position.copy(pos);
  group.lookAt(pos.clone().add(planeNormal));

  applyConstantPixelSize(dot, group, pos, pxRadius, radius);

  group.add(dot);
  previewGroup.add(group);
}

export function addDashedLine(
  previewGroup: Group,
  from: [number, number],
  to: [number, number],
  plane: PlaneData,
  renderOrder = 3,
): void {
  const worldFrom = localToWorld(from, plane);
  const worldTo = localToWorld(to, plane);

  const verts = new Float32Array(6);
  verts[0] = worldFrom.x; verts[1] = worldFrom.y; verts[2] = worldFrom.z;
  verts[3] = worldTo.x; verts[4] = worldTo.y; verts[5] = worldTo.z;

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

export function addDashedCircle(
  previewGroup: Group,
  center: [number, number],
  radius: number,
  plane: PlaneData,
  renderOrder = 3,
): void {
  const verts = new Float32Array((CIRCLE_SEGMENTS + 1) * 3);
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const angle = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    const pt: [number, number] = [
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    ];
    const w = localToWorld(pt, plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

export function addDashedRect(
  previewGroup: Group,
  corner1: [number, number],
  corner2: [number, number],
  plane: PlaneData,
  renderOrder = 3,
): void {
  const x1 = corner1[0], y1 = corner1[1];
  const x2 = corner2[0], y2 = corner2[1];

  const corners: [number, number][] = [
    [x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1],
  ];

  const verts = new Float32Array(corners.length * 3);
  for (let i = 0; i < corners.length; i++) {
    const w = localToWorld(corners[i], plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

const ROUNDED_RECT_ARC_SEGMENTS = 8;

export function addDashedRoundedRect(
  previewGroup: Group,
  corner1: [number, number],
  corner2: [number, number],
  radius: number,
  plane: PlaneData,
  renderOrder = 3,
): void {
  const minX = Math.min(corner1[0], corner2[0]);
  const maxX = Math.max(corner1[0], corner2[0]);
  const minY = Math.min(corner1[1], corner2[1]);
  const maxY = Math.max(corner1[1], corner2[1]);

  const w = maxX - minX;
  const h = maxY - minY;
  const r = Math.min(radius, w / 2, h / 2);

  if (r <= 0) {
    addDashedRect(previewGroup, corner1, corner2, plane, renderOrder);
    return;
  }

  const pts: [number, number][] = [];

  // bottom edge (left to right)
  pts.push([minX + r, minY]);
  pts.push([maxX - r, minY]);
  // bottom-right arc
  for (let i = 0; i <= ROUNDED_RECT_ARC_SEGMENTS; i++) {
    const a = -Math.PI / 2 + (i / ROUNDED_RECT_ARC_SEGMENTS) * (Math.PI / 2);
    pts.push([maxX - r + r * Math.cos(a), minY + r + r * Math.sin(a)]);
  }
  // right edge (bottom to top)
  pts.push([maxX, minY + r]);
  pts.push([maxX, maxY - r]);
  // top-right arc
  for (let i = 0; i <= ROUNDED_RECT_ARC_SEGMENTS; i++) {
    const a = 0 + (i / ROUNDED_RECT_ARC_SEGMENTS) * (Math.PI / 2);
    pts.push([maxX - r + r * Math.cos(a), maxY - r + r * Math.sin(a)]);
  }
  // top edge (right to left)
  pts.push([maxX - r, maxY]);
  pts.push([minX + r, maxY]);
  // top-left arc
  for (let i = 0; i <= ROUNDED_RECT_ARC_SEGMENTS; i++) {
    const a = Math.PI / 2 + (i / ROUNDED_RECT_ARC_SEGMENTS) * (Math.PI / 2);
    pts.push([minX + r + r * Math.cos(a), maxY - r + r * Math.sin(a)]);
  }
  // left edge (top to bottom)
  pts.push([minX, maxY - r]);
  pts.push([minX, minY + r]);
  // bottom-left arc
  for (let i = 0; i <= ROUNDED_RECT_ARC_SEGMENTS; i++) {
    const a = Math.PI + (i / ROUNDED_RECT_ARC_SEGMENTS) * (Math.PI / 2);
    pts.push([minX + r + r * Math.cos(a), minY + r + r * Math.sin(a)]);
  }
  // close
  pts.push([minX + r, minY]);

  const verts = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    const wpt = localToWorld(pts[i], plane);
    verts[i * 3] = wpt.x;
    verts[i * 3 + 1] = wpt.y;
    verts[i * 3 + 2] = wpt.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

export function addDashedPolygon(
  previewGroup: Group,
  center: [number, number],
  radius: number,
  sides: number,
  plane: PlaneData,
  renderOrder = 3,
): void {
  const verts = new Float32Array((sides + 1) * 3);
  for (let i = 0; i <= sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const pt: [number, number] = [
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    ];
    const w = localToWorld(pt, plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

export function addDashedArc(
  previewGroup: Group,
  center: [number, number],
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
  plane: PlaneData,
  renderOrder = 3,
): void {
  let sweep = endAngle - startAngle;
  if (ccw) {
    if (sweep <= 0) {
      sweep += Math.PI * 2;
    }
  } else {
    if (sweep >= 0) {
      sweep -= Math.PI * 2;
    }
  }

  const steps = Math.max(Math.round(Math.abs(sweep) / (Math.PI * 2) * ARC_SEGMENTS), 2);
  const verts = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = startAngle + sweep * t;
    const pt: [number, number] = [
      center[0] + Math.cos(angle) * radius,
      center[1] + Math.sin(angle) * radius,
    ];
    const w = localToWorld(pt, plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

function deCasteljau(poles: [number, number][], t: number): [number, number] {
  let pts = poles.slice();
  while (pts.length > 1) {
    const next: [number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push([
        (1 - t) * pts[i][0] + t * pts[i + 1][0],
        (1 - t) * pts[i][1] + t * pts[i + 1][1],
      ]);
    }
    pts = next;
  }
  return pts[0];
}

export function addDashedBezier(
  previewGroup: Group,
  poles: [number, number][],
  plane: PlaneData,
  renderOrder = 3,
): void {
  if (poles.length < 2) {
    return;
  }

  const verts = new Float32Array((BEZIER_SEGMENTS + 1) * 3);
  for (let i = 0; i <= BEZIER_SEGMENTS; i++) {
    const t = i / BEZIER_SEGMENTS;
    const pt = deCasteljau(poles, t);
    const w = localToWorld(pt, plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

const SLOT_ARC_SEGMENTS = 16;

export function addDashedSlot(
  previewGroup: Group,
  leftCenter: [number, number],
  rightCenter: [number, number],
  radius: number,
  plane: PlaneData,
  renderOrder = 3,
): void {
  const dx = rightCenter[0] - leftCenter[0];
  const dy = rightCenter[1] - leftCenter[1];
  const dist = Math.sqrt(dx * dx + dy * dy);

  let dirX: number, dirY: number;
  if (dist > 1e-10) {
    dirX = dx / dist;
    dirY = dy / dist;
  } else {
    dirX = 1;
    dirY = 0;
  }
  const perpX = -dirY;
  const perpY = dirX;

  const pts: [number, number][] = [];

  // Left arc: from top-left to bottom-left (CW semicircle around leftCenter)
  const leftStartAngle = Math.atan2(perpY, perpX);
  for (let i = 0; i <= SLOT_ARC_SEGMENTS; i++) {
    const a = leftStartAngle + (i / SLOT_ARC_SEGMENTS) * Math.PI;
    pts.push([
      leftCenter[0] + radius * Math.cos(a),
      leftCenter[1] + radius * Math.sin(a),
    ]);
  }

  // Bottom line: bottom-left to bottom-right
  pts.push([rightCenter[0] - radius * perpX, rightCenter[1] - radius * perpY]);

  // Right arc: from bottom-right to top-right (CW semicircle around rightCenter)
  const rightStartAngle = Math.atan2(-perpY, -perpX);
  for (let i = 0; i <= SLOT_ARC_SEGMENTS; i++) {
    const a = rightStartAngle + (i / SLOT_ARC_SEGMENTS) * Math.PI;
    pts.push([
      rightCenter[0] + radius * Math.cos(a),
      rightCenter[1] + radius * Math.sin(a),
    ]);
  }

  // Top line: top-right back to top-left (close)
  pts.push([leftCenter[0] + radius * perpX, leftCenter[1] + radius * perpY]);

  const verts = new Float32Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    const w = localToWorld(pts[i], plane);
    verts[i * 3] = w.x;
    verts[i * 3 + 1] = w.y;
    verts[i * 3 + 2] = w.z;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(verts, 3));

  const mat = new LineDashedMaterial({
    color: GUIDE_COLOR,
    dashSize: 3,
    gapSize: 2,
    depthTest: false,
  });

  const line = new Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  previewGroup.add(line);
}

// --- Arc math utilities ---

export function angleFromCenter(center: [number, number], point: [number, number]): number {
  return Math.atan2(point[1] - center[1], point[0] - center[0]);
}

export function pointOnCircle(center: [number, number], radius: number, angle: number): [number, number] {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

export function circumcenter(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): [number, number] | null {
  const D = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(D) < 1e-10) {
    return null;
  }
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / D;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / D;
  return [ux, uy];
}

export function isCCW(center: [number, number], start: [number, number], through: [number, number]): boolean {
  const startAngle = angleFromCenter(center, start);
  const throughAngle = angleFromCenter(center, through);
  let diff = throughAngle - startAngle;
  if (diff < 0) {
    diff += Math.PI * 2;
  }
  return diff < Math.PI;
}

export function centerFromChordAndRadius(
  start: [number, number],
  end: [number, number],
  radius: number,
  ccw: boolean,
): [number, number] | null {
  const mx = (start[0] + end[0]) / 2;
  const my = (start[1] + end[1]) / 2;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const halfChord = Math.sqrt(dx * dx + dy * dy) / 2;
  if (Math.abs(radius) < halfChord - 1e-10) {
    return null;
  }
  const h = Math.sqrt(Math.max(radius * radius - halfChord * halfChord, 0));
  const nx = -dy;
  const ny = dx;
  const len = Math.sqrt(nx * nx + ny * ny);
  if (len < 1e-10) {
    return null;
  }
  const sign = ccw ? 1 : -1;
  return [mx + sign * h * nx / len, my + sign * h * ny / len];
}

