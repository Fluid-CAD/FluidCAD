import { Camera, Group, Vector3 } from 'three';
import { PlaneData } from '../../types';
import {
  addDot,
  addDashedLine,
  addDashedCircle,
  addDashedArc,
  angleFromCenter,
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
} from '../tools/tool-preview-utils';
import { computeTangentArc, computeArcCenter } from './constraint-math';
import { DragHitResult, DRAG_RENDER_ORDER } from './types';

const RO = DRAG_RENDER_ORDER;

export function rebuildDragPreview(
  previewGroup: Group,
  currentPoint: [number, number],
  startPoint: [number, number] | null,
  hitResult: DragHitResult,
  camera: Camera,
  plane: PlaneData,
): void {
  const planeNormal = new Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
  const { uniqueType, hitZone, anchorPoint, fixedVertex } = hitResult;

  if (uniqueType === 'circle' && anchorPoint) {
    const center = anchorPoint;
    const ddx = currentPoint[0] - center[0];
    const ddy = currentPoint[1] - center[1];
    const radius = Math.sqrt(ddx * ddx + ddy * ddy);
    addDot(previewGroup, center, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDashedCircle(previewGroup, center, radius, plane, RO);
  } else if (uniqueType === 'tline' && anchorPoint && hitResult.tangentDir) {
    const start = anchorPoint;
    const t = hitResult.tangentDir;
    const dx = currentPoint[0] - start[0];
    const dy = currentPoint[1] - start[1];
    const proj = dx * t[0] + dy * t[1];
    const constrainedEnd: [number, number] = [start[0] + t[0] * proj, start[1] + t[1] * proj];
    addDot(previewGroup, start, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDashedLine(previewGroup, start, constrainedEnd, plane, RO);
    addDot(previewGroup, constrainedEnd, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
  } else if (uniqueType === 'hline' || uniqueType === 'vline') {
    if (hitZone === 'end') {
      const start = anchorPoint!;
      const constrainedEnd: [number, number] = uniqueType === 'hline'
        ? [currentPoint[0], start[1]]
        : [start[0], currentPoint[1]];
      addDot(previewGroup, start, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, start, constrainedEnd, plane, RO);
      addDot(previewGroup, constrainedEnd, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    } else {
      const d = hitResult.originalDistance ?? 0;
      const newEnd: [number, number] = uniqueType === 'hline'
        ? [currentPoint[0] + d, currentPoint[1]]
        : [currentPoint[0], currentPoint[1] + d];
      addDot(previewGroup, currentPoint, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, currentPoint, newEnd, plane, RO);
      addDot(previewGroup, newEnd, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    }
  } else if (uniqueType === 'line-two-points' && fixedVertex && anchorPoint) {
    if (hitZone === 'body') {
      const dx = fixedVertex[0] - anchorPoint[0];
      const dy = fixedVertex[1] - anchorPoint[1];
      const newEnd: [number, number] = [currentPoint[0] + dx, currentPoint[1] + dy];
      addDot(previewGroup, currentPoint, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, currentPoint, newEnd, plane, RO);
      addDot(previewGroup, newEnd, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    } else if (hitZone === 'start') {
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, currentPoint, fixedVertex, plane, RO);
      addDot(previewGroup, fixedVertex, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    } else {
      addDot(previewGroup, fixedVertex, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, fixedVertex, currentPoint, plane, RO);
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    }
  } else if (uniqueType === 'arc' && anchorPoint && fixedVertex) {
    rebuildArcPreview(previewGroup, currentPoint, hitResult, camera, planeNormal, plane);
  } else if ((uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') && fixedVertex && hitResult.tangentDir) {
    rebuildTangentArcPreview(previewGroup, currentPoint, hitResult, camera, planeNormal, plane);
  } else {
    addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    if (startPoint) {
      addDashedLine(previewGroup, startPoint, currentPoint, plane, RO);
    }
  }
}

function rebuildArcPreview(
  previewGroup: Group,
  currentPoint: [number, number],
  hitResult: DragHitResult,
  camera: Camera,
  planeNormal: Vector3,
  plane: PlaneData,
): void {
  const { hitZone, anchorPoint, fixedVertex } = hitResult;
  const ccw = hitResult.arcCCW !== false;

  if (hitZone === 'center') {
    const startV = fixedVertex!;
    const endV = hitResult.fixedVertex2!;
    const center = currentPoint;
    const radius = Math.sqrt(
      (startV[0] - center[0]) ** 2 + (startV[1] - center[1]) ** 2,
    );
    const startAngle = angleFromCenter(center, startV);
    const endAngle = angleFromCenter(center, endV);
    const projectedEnd: [number, number] = [
      center[0] + radius * Math.cos(endAngle),
      center[1] + radius * Math.sin(endAngle),
    ];
    addDot(previewGroup, startV, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDashedArc(previewGroup, center, radius, startAngle, endAngle, ccw, plane, RO);
    addDot(previewGroup, projectedEnd, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDot(previewGroup, center, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
  } else {
    const newCenter = computeArcCenter(anchorPoint!, fixedVertex!, currentPoint);
    const radius = Math.sqrt(
      (currentPoint[0] - newCenter[0]) ** 2 + (currentPoint[1] - newCenter[1]) ** 2,
    );
    if (hitZone === 'start') {
      const startAngle = angleFromCenter(newCenter, currentPoint);
      const endAngle = angleFromCenter(newCenter, fixedVertex!);
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedArc(previewGroup, newCenter, radius, startAngle, endAngle, ccw, plane, RO);
      addDot(previewGroup, fixedVertex!, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    } else {
      const startAngle = angleFromCenter(newCenter, fixedVertex!);
      const endAngle = angleFromCenter(newCenter, currentPoint);
      addDot(previewGroup, fixedVertex!, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedArc(previewGroup, newCenter, radius, startAngle, endAngle, ccw, plane, RO);
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    }
  }
}

function rebuildTangentArcPreview(
  previewGroup: Group,
  currentPoint: [number, number],
  hitResult: DragHitResult,
  camera: Camera,
  planeNormal: Vector3,
  plane: PlaneData,
): void {
  const { hitZone, fixedVertex, tangentDir } = hitResult;
  const startV = fixedVertex!;
  const tangent = tangentDir!;

  if (hitZone === 'center') {
    const center = currentPoint;
    const endV = hitResult.fixedVertex2!;
    const radius = Math.sqrt(
      (startV[0] - center[0]) ** 2 + (startV[1] - center[1]) ** 2,
    );
    const startAngle = angleFromCenter(center, startV);
    const endAngle = angleFromCenter(center, endV);
    const ccw = hitResult.arcCCW !== false;
    const projectedEnd: [number, number] = [
      center[0] + radius * Math.cos(endAngle),
      center[1] + radius * Math.sin(endAngle),
    ];
    addDot(previewGroup, startV, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDashedArc(previewGroup, center, radius, startAngle, endAngle, ccw, plane, RO);
    addDot(previewGroup, projectedEnd, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
    addDot(previewGroup, center, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
  } else {
    const arc = computeTangentArc(startV, currentPoint, tangent);
    if (arc) {
      addDot(previewGroup, startV, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedArc(previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, plane, RO);
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    } else {
      addDot(previewGroup, startV, START_POINT_COLOR, camera, planeNormal, plane, 1, RO);
      addDashedLine(previewGroup, startV, currentPoint, plane, RO);
      addDot(previewGroup, currentPoint, SNAP_VERTEX_COLOR, camera, planeNormal, plane, 1, RO);
    }
  }
}

export function disposePreviewGroup(previewGroup: Group): void {
  while (previewGroup.children.length > 0) {
    const child = previewGroup.children[0];
    previewGroup.remove(child);
    const obj = child as any;
    if (obj.geometry) {
      obj.geometry.dispose();
    }
    if (obj.material) {
      obj.material.dispose();
    }
  }
}
