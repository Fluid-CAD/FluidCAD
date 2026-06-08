import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ModeId, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';

export class ConstrainedLineMode implements SegmentMode {
  readonly id: ModeId;
  readonly label: string;
  readonly requiresTangent = false;

  private axis: 'h' | 'v';
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';

  constructor(axis: 'h' | 'v') {
    this.axis = axis;
    this.id = axis === 'h' ? 'hLine' : 'vLine';
    this.label = axis === 'h' ? 'H-Line' : 'V-Line';
  }

  enter(_ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnapType = 'none';
  }

  exit(ctx: ModeContext): void {
    this.mousePoint = null;
    ctx.hideExpressionInput();
  }

  private getEffectiveEnd(start: Point2D, mouse: Point2D): Point2D {
    if (this.axis === 'h') {
      return [mouse[0], start[1]];
    }
    return [start[0], mouse[1]];
  }

  private getDistance(start: Point2D, mouse: Point2D): number {
    if (this.axis === 'h') {
      return mouse[0] - start[0];
    }
    return mouse[1] - start[1];
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (ctx.isExpressionVisible()) {
      ctx.commitExpressionValue();
      return { kind: 'ignored' };
    }

    const roundedStart = roundPoint(ctx.startPoint);
    const distance = this.getDistance(roundedStart, point);
    const rounded = Math.round(distance * 100) / 100;
    if (rounded === 0) {
      return { kind: 'ignored' };
    }

    const atCurrent = ctx.isAtCurrentPosition(roundedStart);
    const fn = this.axis === 'h' ? 'hLine' : 'vLine';
    const statement = atCurrent
      ? `${fn}(${rounded})`
      : `${fn}(${ctx.formatPoint(roundedStart)}, ${rounded})`;
    ctx.insertGeometry(statement);
    ctx.hideExpressionInput();

    const endPoint: Point2D = this.axis === 'h'
      ? [roundedStart[0] + rounded, roundedStart[1]]
      : [roundedStart[0], roundedStart[1] + rounded];
    const roundedEnd = roundPoint(endPoint);
    const exitDir: Point2D = this.axis === 'h'
      ? [Math.sign(rounded) || 1, 0]
      : [0, Math.sign(rounded) || 1];

    return {
      kind: 'committed',
      result: {
        endpoint: roundedEnd,
        exitTangent: { direction: exitDir, point: roundedEnd },
      },
    };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;

    const distance = Math.abs(this.getDistance(ctx.startPoint, point));
    const label = this.axis === 'h' ? 'H:' : 'V:';

    if (!ctx.isExpressionVisible()) {
      ctx.showExpressionInput({
        label,
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

  private commitWithDimension(result: { expression: string; newVariable?: { name: string; initializer: string } }, ctx: ModeContext): void {
    const roundedStart = roundPoint(ctx.startPoint);
    if (!this.mousePoint) {
      return;
    }

    const { expression, newVariable } = result;
    const rawDistance = this.getDistance(roundedStart, this.mousePoint);
    const sign = Math.sign(rawDistance);

    const num = parseFloat(expression);
    const dimExpr = !isNaN(num) && String(num) === expression
      ? String(Math.round(sign * num * 100) / 100)
      : expression;

    const atCurrent = ctx.isAtCurrentPosition(roundedStart);
    const fn = this.axis === 'h' ? 'hLine' : 'vLine';
    const statement = atCurrent
      ? `${fn}(${dimExpr})`
      : `${fn}(${ctx.formatPoint(roundedStart)}, ${dimExpr})`;
    ctx.insertGeometry(statement, newVariable);
    ctx.hideExpressionInput();

    const committedDist = parseFloat(dimExpr);
    const resolvedDist = isNaN(committedDist) ? Math.round(sign * Math.abs(this.getDistance(roundedStart, this.mousePoint)) * 100) / 100 : committedDist;
    const roundedEnd: Point2D = this.axis === 'h'
      ? [roundedStart[0] + resolvedDist, roundedStart[1]]
      : [roundedStart[0], roundedStart[1] + resolvedDist];
    const exitDir: Point2D = this.axis === 'h'
      ? [Math.sign(resolvedDist) || 1, 0]
      : [0, Math.sign(resolvedDist) || 1];
    ctx.onSegmentCommitted({
      endpoint: roundPoint(roundedEnd),
      exitTangent: { direction: exitDir, point: roundPoint(roundedEnd) },
    });
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.mousePoint) {
      const effectiveEnd = this.getEffectiveEnd(ctx.startPoint, this.mousePoint);
      addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);

      if (this.lastSnapType !== 'none') {
        const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(ctx.previewGroup, effectiveEnd, snapColor, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
      }
    }
  }
}
