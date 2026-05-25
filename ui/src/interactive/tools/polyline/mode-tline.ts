import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  addDot,
  addDashedLine,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';

export class TLineMode implements SegmentMode {
  readonly id = 'tLine' as const;
  readonly label = 'T-Line';
  readonly requiresTangent = true;

  private mousePoint: Point2D | null = null;

  enter(_ctx: ModeContext): void {
    this.mousePoint = null;
  }

  exit(ctx: ModeContext): void {
    this.mousePoint = null;
    ctx.hideExpressionInput();
  }

  private projectOnTangent(start: Point2D, mouse: Point2D, tangent: Point2D): { projected: Point2D; distance: number } {
    const dx = mouse[0] - start[0];
    const dy = mouse[1] - start[1];
    const projection = dx * tangent[0] + dy * tangent[1];
    const projected: Point2D = [
      start[0] + tangent[0] * projection,
      start[1] + tangent[1] * projection,
    ];
    return { projected, distance: projection };
  }

  handleClick(_point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (!ctx.tangent) {
      return { kind: 'ignored' };
    }

    if (ctx.isExpressionVisible()) {
      ctx.commitExpressionValue();
      return { kind: 'ignored' };
    }

    if (!this.mousePoint) {
      return { kind: 'ignored' };
    }

    const { distance } = this.projectOnTangent(ctx.startPoint, this.mousePoint, ctx.tangent.direction);
    const rounded = Math.round(distance * 100) / 100;
    if (rounded === 0) {
      return { kind: 'ignored' };
    }

    ctx.insertGeometry(`tLine(${rounded})`);
    ctx.hideExpressionInput();

    const endPoint = roundPoint([
      ctx.startPoint[0] + ctx.tangent.direction[0] * distance,
      ctx.startPoint[1] + ctx.tangent.direction[1] * distance,
    ]);

    return {
      kind: 'committed',
      result: {
        endpoint: endPoint,
        exitTangent: { direction: ctx.tangent.direction, point: endPoint },
      },
    };
  }

  handleMouseMove(point: Point2D, _snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;

    if (!ctx.tangent) {
      return;
    }

    const { distance } = this.projectOnTangent(ctx.startPoint, point, ctx.tangent.direction);
    const absDist = Math.abs(distance);

    if (!ctx.isExpressionVisible()) {
      ctx.showExpressionInput({
        label: 'T:',
        value: String(Math.round(absDist * 100) / 100),
        clientX,
        clientY,
        onCommit: (result) => this.commitWithDimension(result, ctx),
      });
    } else {
      ctx.updateExpressionValue(absDist);
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
    if (!ctx.tangent || !this.mousePoint) {
      return;
    }

    const { expression, newVariable } = result;
    const { distance } = this.projectOnTangent(ctx.startPoint, this.mousePoint, ctx.tangent.direction);
    const sign = Math.sign(distance);

    const num = parseFloat(expression);
    const dimExpr = !isNaN(num) && String(num) === expression
      ? String(Math.round(sign * num * 100) / 100)
      : expression;

    ctx.insertGeometry(`tLine(${dimExpr})`, newVariable);
    ctx.hideExpressionInput();

    const endPoint = roundPoint([
      ctx.startPoint[0] + ctx.tangent.direction[0] * distance,
      ctx.startPoint[1] + ctx.tangent.direction[1] * distance,
    ]);
    ctx.onSegmentCommitted({
      endpoint: endPoint,
      exitTangent: { direction: ctx.tangent.direction, point: endPoint },
    });
  }

  rebuildPreview(ctx: ModeContext): void {
    if (!ctx.tangent) {
      return;
    }

    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.mousePoint) {
      const { projected } = this.projectOnTangent(ctx.startPoint, this.mousePoint, ctx.tangent.direction);
      addDashedLine(ctx.previewGroup, ctx.startPoint, projected, ctx.plane);
    }
  }
}
