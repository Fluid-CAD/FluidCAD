import { roundPoint } from '../sketch-plane-utils';
import {
  setLinePosition,
  updatePosition,
  setChainPositions,
  updateDimensionExpression,
  setRectDimensions,
} from '../../api';
import { computeArcCenter, computeFixedRadiusArc } from './constraint-math';
import { DragHitResult, GetSketchSourceLineFn } from './types';

export function commitPositionMove(
  currentPoint: [number, number],
  hitResult: DragHitResult,
  getSketchSourceLine: GetSketchSourceLineFn,
): void {
  const newPos = roundPoint(currentPoint);
  const { sourceLocation, uniqueType, hitZone, anchorPoint, fixedVertex } = hitResult;

  if (uniqueType === 'line-two-points' && hitZone === 'body' && anchorPoint && fixedVertex) {
    const dx = fixedVertex[0] - anchorPoint[0];
    const dy = fixedVertex[1] - anchorPoint[1];
    const newStart = newPos;
    const newEnd = roundPoint([newPos[0] + dx, newPos[1] + dy]);
    setLinePosition(newStart, newEnd, sourceLocation);
    return;
  }

  if (uniqueType === 'line-two-points') {
    const pointIndex = hitZone === 'start' ? 0 : -1;
    updatePosition(newPos, sourceLocation, pointIndex);
  } else if (uniqueType === 'arc' && anchorPoint && fixedVertex) {
    const isOnePoint = hitResult.arcArgCount === 2;
    const endIdx = isOnePoint ? 0 : 1;
    const centerIdx = isOnePoint ? 1 : 2;
    if (hitZone === 'center') {
      const startV = fixedVertex;
      const endV = hitResult.fixedVertex2!;
      const radius = Math.sqrt(
        (startV[0] - newPos[0]) ** 2 + (startV[1] - newPos[1]) ** 2,
      );
      const endAngle = Math.atan2(endV[1] - newPos[1], endV[0] - newPos[0]);
      const projectedEnd = roundPoint([
        newPos[0] + radius * Math.cos(endAngle),
        newPos[1] + radius * Math.sin(endAngle),
      ]);
      setChainPositions(
        [
          { pointIndex: endIdx, position: projectedEnd },
          { pointIndex: centerIdx, position: newPos },
        ],
        sourceLocation,
      );
    } else {
      const newCenter = roundPoint(computeArcCenter(anchorPoint, fixedVertex, newPos));
      const pointIndex = hitZone === 'start' ? 0 : endIdx;
      setChainPositions(
        [
          { pointIndex, position: newPos },
          { pointIndex: centerIdx, position: newCenter },
        ],
        sourceLocation,
      );
    }
  } else if ((uniqueType === 'hline' || uniqueType === 'vline') && (hitZone === 'start' || hitZone === 'body')) {
    updatePosition(newPos, sourceLocation, 0);
  } else if (uniqueType === 'tline' && hitZone === 'end' && anchorPoint && hitResult.tangentDir) {
    const t = hitResult.tangentDir;
    const dx = newPos[0] - anchorPoint[0];
    const dy = newPos[1] - anchorPoint[1];
    const distance = Math.round((dx * t[0] + dy * t[1]) * 100) / 100;
    const sketchSourceLine = getSketchSourceLine();
    updateDimensionExpression(String(distance), sourceLocation, sketchSourceLine);
  } else if (uniqueType === 'aline') {
    // The angle is a constraint — an end drag only rewrites the length (the
    // call's last arg), which also preserves an expression angle argument
    // verbatim. A start drag (explicit-start form) translates the segment by
    // rewriting the start point. Any other hit falls through to nothing —
    // the generic point rewrite below would corrupt the scalar argument list.
    if (hitZone === 'end' && anchorPoint && hitResult.tangentDir) {
      const t = hitResult.tangentDir;
      const dx = newPos[0] - anchorPoint[0];
      const dy = newPos[1] - anchorPoint[1];
      const length = Math.round((dx * t[0] + dy * t[1]) * 100) / 100;
      const sketchSourceLine = getSketchSourceLine();
      updateDimensionExpression(String(length), sourceLocation, sketchSourceLine);
    } else if (hitZone === 'start') {
      updatePosition(newPos, sourceLocation, 0);
    }
  } else if (uniqueType === 'polygon' && anchorPoint && hitResult.originalDistance && hitResult.initialValue) {
    const ddx = newPos[0] - anchorPoint[0];
    const ddy = newPos[1] - anchorPoint[1];
    const newCircumscribedRadius = Math.sqrt(ddx * ddx + ddy * ddy);
    const newDiameter = Math.round(hitResult.initialValue * newCircumscribedRadius / hitResult.originalDistance * 100) / 100;
    const sketchSourceLine = getSketchSourceLine();
    updateDimensionExpression(String(newDiameter), sourceLocation, sketchSourceLine);
  } else if (uniqueType === 'rect' && anchorPoint) {
    if (hitResult.rectCentered) {
      const newWidth = Math.round(Math.abs(newPos[0] - anchorPoint[0]) * 2 * 100) / 100;
      const newHeight = Math.round(Math.abs(newPos[1] - anchorPoint[1]) * 2 * 100) / 100;
      setRectDimensions(newWidth, newHeight, sourceLocation);
    } else {
      // Keep the statement's own frame: the dimensions keep their signs and
      // the start stays the corner the source counts from, so a rect drawn
      // top-left → bottom-right doesn't flip when a corner is dragged.
      const signW = (hitResult.rectSignW ?? 1) < 0 ? -1 : 1;
      const signH = (hitResult.rectSignH ?? 1) < 0 ? -1 : 1;
      const minX = Math.min(anchorPoint[0], newPos[0]);
      const maxX = Math.max(anchorPoint[0], newPos[0]);
      const minY = Math.min(anchorPoint[1], newPos[1]);
      const maxY = Math.max(anchorPoint[1], newPos[1]);
      const newWidth = Math.round(signW * (maxX - minX) * 100) / 100;
      const newHeight = Math.round(signH * (maxY - minY) * 100) / 100;
      const newStart = roundPoint([signW > 0 ? minX : maxX, signH > 0 ? minY : maxY]);
      const oldStart = hitResult.rectStart ? roundPoint(hitResult.rectStart) : undefined;
      setRectDimensions(newWidth, newHeight, sourceLocation, newStart, oldStart);
    }
  } else if (uniqueType === 'tarc-radius-to-point') {
    if (hitZone === 'center' && fixedVertex) {
      // The center drag resizes the radius arg (keeping the statement's
      // sign, i.e. the leave side) and re-aims the endpoint argument at the
      // position the resized tangent circle can reach.
      const magnitude = Math.round(Math.hypot(newPos[0] - fixedVertex[0], newPos[1] - fixedVertex[1]) * 100) / 100;
      const sign = (hitResult.initialValue ?? 0) < 0 ? -1 : 1;
      let point: [number, number] | null = null;
      if (hitResult.fixedVertex2 && hitResult.tangentDir && magnitude > 0) {
        const arc = computeFixedRadiusArc(fixedVertex, hitResult.fixedVertex2, magnitude, hitResult.tangentDir);
        if (arc) {
          point = roundPoint(arc.end);
        }
      }
      const sketchSourceLine = getSketchSourceLine();
      updateDimensionExpression(String(sign * magnitude), sourceLocation, sketchSourceLine, undefined, 0, 'tArc', true, point);
    } else if (hitZone === 'end') {
      updatePosition(newPos, sourceLocation, 0);
    }
  } else if (uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') {
    const endIdx = uniqueType === 'tarc-to-point' ? 0 : 1;
    if (hitZone === 'center' && fixedVertex && hitResult.fixedVertex2) {
      const startV = fixedVertex;
      const oldEnd = hitResult.fixedVertex2;
      const radius = Math.sqrt(
        (startV[0] - newPos[0]) ** 2 + (startV[1] - newPos[1]) ** 2,
      );
      const endAngle = Math.atan2(oldEnd[1] - newPos[1], oldEnd[0] - newPos[0]);
      const projectedEnd = roundPoint([
        newPos[0] + radius * Math.cos(endAngle),
        newPos[1] + radius * Math.sin(endAngle),
      ]);
      updatePosition(projectedEnd, sourceLocation, endIdx);
    } else {
      updatePosition(newPos, sourceLocation, endIdx);
    }
  } else if (uniqueType === 'slot') {
    if (hitZone === 'body') {
      const lc = hitResult.anchorPoint!;
      const ax = hitResult.slotAxisDir?.[0] ?? 1;
      const ay = hitResult.slotAxisDir?.[1] ?? 0;
      const ddx = newPos[0] - lc[0];
      const ddy = newPos[1] - lc[1];
      const newRadius = Math.round(Math.abs(-ay * ddx + ax * ddy) * 100) / 100;
      const sketchSourceLine = getSketchSourceLine();
      updateDimensionExpression(String(newRadius), sourceLocation, sketchSourceLine);
    } else if (hitResult.slotHasTwoPoints) {
      updatePosition(newPos, sourceLocation, hitResult.slotPointIndex ?? 0);
    } else if (hitZone === 'start') {
      updatePosition(newPos, sourceLocation, 0);
    } else if (hitResult.slotOtherCenter && hitResult.slotAxisDir) {
      const other = hitResult.slotOtherCenter;
      const ax = hitResult.slotAxisDir;
      const ddx = newPos[0] - other[0];
      const ddy = newPos[1] - other[1];
      const newDistance = Math.round((ddx * ax[0] + ddy * ax[1]) * 100) / 100;
      const sketchSourceLine = getSketchSourceLine();
      updateDimensionExpression(String(newDistance), sourceLocation, sketchSourceLine, undefined, 1);
    }
  } else if (uniqueType.startsWith('bezier-') && hitResult.bezierPoleIndex !== undefined) {
    updatePosition(newPos, sourceLocation, hitResult.bezierPoleIndex);
  } else {
    const grabbed = hitResult.draggedVertices?.[0];
    updatePosition(newPos, sourceLocation, undefined, grabbed ? roundPoint(grabbed) : undefined);
  }
}
