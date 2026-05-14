import { roundPoint } from '../sketch-plane-utils';
import {
  setLinePosition,
  updatePosition,
  setChainPositions,
  updateDimensionExpression,
} from '../../api';
import { computeArcCenter } from './constraint-math';
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
  } else {
    updatePosition(newPos, sourceLocation);
  }
}
