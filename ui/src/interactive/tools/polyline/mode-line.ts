import { roundPoint } from '../../sketch-plane-utils';
import { SketchTool } from '../../sketch-tool';
import { classifyDelta, orthoEffectiveEnd, LineDirection } from '../ortho-snap';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';
import type { CommitResult } from '../../../ui/expression-input';

export class LineMode implements SegmentMode {
  readonly id = 'line' as const;
  readonly label = 'Line';
  readonly requiresTangent = false;

  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';
  private direction: LineDirection = 'free';

  enter(_ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.direction = 'free';
  }

  exit(ctx: ModeContext): void {
    this.mousePoint = null;
    this.direction = 'free';
    ctx.hideExpressionInput();
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (ctx.isExpressionVisible()) {
      ctx.commitExpressionValue();
      return { kind: 'ignored' };
    }

    const roundedStart = roundPoint(ctx.startPoint);
    const roundedEnd = roundPoint(point);
    const dx = roundedEnd[0] - roundedStart[0];
    const dy = roundedEnd[1] - roundedStart[1];
    const dir = classifyDelta(dx, dy, ctx.isOrthoOverride());
    const pendingStart = ctx.pendingStartText();
    const atCurrent = pendingStart === null && ctx.isAtCurrentPosition(roundedStart);
    const startText = pendingStart ?? ctx.formatPoint(roundedStart);

    if (dir === 'horizontal' || dir === 'vertical') {
      const isHorizontal = dir === 'horizontal';
      const rounded = Math.round((isHorizontal ? dx : dy) * 100) / 100;
      if (rounded === 0) {
        return { kind: 'ignored' };
      }

      const fn = isHorizontal ? 'hLine' : 'vLine';
      const statement = atCurrent
        ? `${fn}(${rounded})`
        : `${fn}(${startText}, ${rounded})`;
      ctx.insertGeometry(statement);
      ctx.hideExpressionInput();

      const endPoint: Point2D = isHorizontal
        ? [roundedStart[0] + rounded, roundedStart[1]]
        : [roundedStart[0], roundedStart[1] + rounded];
      const snappedEnd = roundPoint(endPoint);
      const exitDir: Point2D = isHorizontal
        ? [Math.sign(rounded) || 1, 0]
        : [0, Math.sign(rounded) || 1];

      return {
        kind: 'committed',
        result: {
          endpoint: snappedEnd,
          exitTangent: { direction: exitDir, point: snappedEnd },
        },
      };
    }

    const statement = atCurrent
      ? `line(${ctx.formatPoint(roundedEnd)})`
      : `line(${startText}, ${ctx.formatPoint(roundedEnd)})`;
    ctx.insertGeometry(statement);

    const len = Math.sqrt(dx * dx + dy * dy);
    const exitTangent = len > 1e-10
      ? { direction: [dx / len, dy / len] as Point2D, point: roundedEnd }
      : null;

    return { kind: 'committed', result: { endpoint: roundedEnd, exitTangent } };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;

    const dx = point[0] - ctx.startPoint[0];
    const dy = point[1] - ctx.startPoint[1];
    this.direction = classifyDelta(dx, dy, ctx.isOrthoOverride());

    if (this.direction === 'free') {
      ctx.hideExpressionInput();
      return;
    }

    const isHorizontal = this.direction === 'horizontal';
    const distance = Math.abs(isHorizontal ? dx : dy);

    if (!ctx.isExpressionVisible()) {
      ctx.showExpressionInput({
        label: isHorizontal ? 'H:' : 'V:',
        value: String(Math.round(distance * 100) / 100),
        clientX,
        clientY,
        onCommit: (result) => this.commitWithDimension(result, ctx),
      });
    } else {
      ctx.updateExpressionValue(distance);
      ctx.updateExpressionPosition(clientX, clientY);
    }
  }

  handleEscape(ctx: ModeContext): boolean {
    if (ctx.isExpressionVisible()) {
      ctx.hideExpressionInput();
      return true;
    }
    return false;
  }

  private commitWithDimension(result: CommitResult, ctx: ModeContext): void {
    const roundedStart = roundPoint(ctx.startPoint);
    if (!this.mousePoint) {
      return;
    }

    const { expression, newVariable } = result;
    const dx = this.mousePoint[0] - roundedStart[0];
    const dy = this.mousePoint[1] - roundedStart[1];
    const isHorizontal = Math.abs(dx) >= Math.abs(dy);
    const rawDistance = isHorizontal ? dx : dy;
    const sign = Math.sign(rawDistance);
    const dimExpr = SketchTool.applySignedDimension(expression, sign);

    const pendingStart = ctx.pendingStartText();
    const atCurrent = pendingStart === null && ctx.isAtCurrentPosition(roundedStart);
    const fn = isHorizontal ? 'hLine' : 'vLine';
    const statement = atCurrent
      ? `${fn}(${dimExpr})`
      : `${fn}(${pendingStart ?? ctx.formatPoint(roundedStart)}, ${dimExpr})`;
    ctx.insertGeometry(statement, newVariable);
    ctx.hideExpressionInput();

    const committedDist = parseFloat(dimExpr);
    const resolvedDist = isNaN(committedDist) ? Math.round(sign * Math.abs(rawDistance) * 100) / 100 : committedDist;
    const endPoint: Point2D = isHorizontal
      ? [roundedStart[0] + resolvedDist, roundedStart[1]]
      : [roundedStart[0], roundedStart[1] + resolvedDist];
    const roundedEnd = roundPoint(endPoint);
    const exitDir: Point2D = isHorizontal
      ? [Math.sign(resolvedDist) || 1, 0]
      : [0, Math.sign(resolvedDist) || 1];
    ctx.onSegmentCommitted({
      endpoint: roundedEnd,
      exitTangent: { direction: exitDir, point: roundedEnd },
    });
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.mousePoint) {
      const effectiveEnd = orthoEffectiveEnd(ctx.startPoint, this.mousePoint, this.direction);
      addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);

      if (this.lastSnapType !== 'none') {
        const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(ctx.previewGroup, effectiveEnd, snapColor, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
      }
    }
  }
}
