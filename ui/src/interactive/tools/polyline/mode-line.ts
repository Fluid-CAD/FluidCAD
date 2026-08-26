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
import { dimMagnitude, type SolvedConstraintParam } from '../solved-emission';

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

  handleClick(point: Point2D, snapResult: SnapResult, ctx: ModeContext): ClickResult {
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
    const startText = pendingStart ?? ctx.formatPoint(roundedStart);

    if (dir === 'horizontal' || dir === 'vertical') {
      const isHorizontal = dir === 'horizontal';
      const rounded = Math.round((isHorizontal ? dx : dy) * 100) / 100;
      if (rounded === 0) {
        return { kind: 'ignored' };
      }

      const endPoint: Point2D = isHorizontal
        ? [roundedStart[0] + rounded, roundedStart[1]]
        : [roundedStart[0], roundedStart[1] + rounded];
      const snappedEnd = roundPoint(endPoint);

      if (ctx.solved) {
        // Auto-constraints off: the ortho quantization still applies (a
        // drafting aid) but the H/V stays unwritten.
        ctx.solved.emitSegment({
          kind: 'line',
          text: `line(${startText}, ${ctx.formatPoint(snappedEnd)})`,
          constraints: ctx.solved.autoConstraints()
            ? [{ kind: isHorizontal ? 'horizontal' : 'vertical', targets: [{ newIndex: 0 }] }]
            : [],
          endSnap: snapResult,
          endPoint: snappedEnd,
        });
      }
      ctx.hideExpressionInput();

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

    ctx.solved?.emitSegment({
      kind: 'line',
      text: `line(${startText}, ${ctx.formatPoint(roundedEnd)})`,
      endSnap: snapResult,
      endPoint: roundedEnd,
    });

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
    const committedDist = parseFloat(dimExpr);
    const resolvedDist = isNaN(committedDist) ? Math.round(sign * Math.abs(rawDistance) * 100) / 100 : committedDist;
    const endPoint: Point2D = isHorizontal
      ? [roundedStart[0] + resolvedDist, roundedStart[1]]
      : [roundedStart[0], roundedStart[1] + resolvedDist];
    const roundedEnd = roundPoint(endPoint);

    if (ctx.solved) {
      // A TYPED magnitude becomes an explicit length dimension (the sign
      // only picks which side the guess endpoint lands on); a click-committed
      // pill value stays a guess. The H/V is inference — the Auto-constraints
      // toggle gates it; the typed dimension is explicit and always lands.
      const constraints: SolvedConstraintParam[] = ctx.solved.autoConstraints()
        ? [{ kind: isHorizontal ? 'horizontal' : 'vertical', targets: [{ newIndex: 0 }] }]
        : [];
      if (ctx.isExpressionTyping()) {
        constraints.push({
          kind: 'distance',
          targets: [{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }],
          valueExpr: dimMagnitude(expression),
        });
      }
      ctx.solved.emitSegment({
        kind: 'line',
        text: `line(${pendingStart ?? ctx.formatPoint(roundedStart)}, ${ctx.formatPoint(roundedEnd)})`,
        constraints,
        endPoint: roundedEnd,
        newVariable,
      });
    }
    ctx.hideExpressionInput();
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
