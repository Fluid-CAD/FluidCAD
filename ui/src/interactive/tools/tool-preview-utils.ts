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
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
} from 'three';
import { localToWorld } from '../sketch-plane-utils';
import { PlaneData } from '../../types';
import { SnapType } from '../../snapping/types';

export const START_POINT_COLOR = 0x22cc66;
export const GUIDE_COLOR = 0xb0b0b0;
export const SNAP_VERTEX_COLOR = 0xffc578;
export const SNAP_GRID_COLOR = 0x888888;
export const DOT_RADIUS = 2.5;
export const DOT_SEGMENTS = 16;
export const SCALE_FACTOR = 0.003;
export const MAX_SCALE = 1.5;
export const CIRCLE_SEGMENTS = 64;
export const ARC_SEGMENTS = 64;

export function computeViewScale(camera: Camera, position: Vector3, factor: number): number {
  if (camera instanceof OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight * factor;
  } else if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = camera.fov * Math.PI / 180;
    const viewHeight = 2 * dist * Math.tan(vFov / 2);
    return viewHeight * factor;
  }
  return 1;
}

export function snapDotColor(snapType: SnapType): number {
  return snapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
}

export function addDot(
  previewGroup: Group,
  point2d: [number, number],
  color: number,
  camera: Camera,
  planeNormal: Vector3,
  plane: PlaneData,
  opacity = 1,
): void {
  const geo = new CircleGeometry(DOT_RADIUS, DOT_SEGMENTS);
  const mat = new MeshBasicMaterial({
    color,
    side: DoubleSide,
    depthTest: false,
    transparent: opacity < 1,
    opacity,
  });
  const dot = new Mesh(geo, mat);
  dot.renderOrder = 4;

  const group = new Group();
  group.renderOrder = 4;
  const pos = localToWorld(point2d, plane);
  group.position.copy(pos);
  group.lookAt(pos.clone().add(planeNormal));
  group.scale.setScalar(Math.min(computeViewScale(camera, pos, SCALE_FACTOR), MAX_SCALE));

  dot.onBeforeRender = (_r, _s, cam) => {
    group.scale.setScalar(Math.min(computeViewScale(cam, pos, SCALE_FACTOR), MAX_SCALE));
    group.updateMatrixWorld(true);
  };

  group.add(dot);
  previewGroup.add(group);
}

export function addDashedLine(
  previewGroup: Group,
  from: [number, number],
  to: [number, number],
  plane: PlaneData,
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
  line.renderOrder = 3;
  previewGroup.add(line);
}

export function addDashedCircle(
  previewGroup: Group,
  center: [number, number],
  radius: number,
  plane: PlaneData,
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
  line.renderOrder = 3;
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
  line.renderOrder = 3;
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
