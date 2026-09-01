import { roundPoint } from '../../sketch-plane-utils';
import { SketchTool } from '../../sketch-tool';
import {
  START_POINT_COLOR,
  addDot,
  addDashedLine,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import { dimMagnitude } from '../solved-emission';
import type { SnapResult } from '../../../snapping/types';

export class TLineMode implements SegmentMode {
  readonly id = 'tLine' as const;
  readonly label = 'T-Line';
  readonly requiresTangent = true;

  private mousePoint: Point2D | null = null;
  /** The cursor's latest snap — the T: pill claims the commit click, so the
   * emission takes the endpoint's snap provenance from here (the tool drops
   * it unless the on-tangent projection still sits on the vertex). */
  private lastSnap: SnapResult | null = null;

  enter(_ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnap = null;
  }

  exit(ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnap = null;
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

  handleClick(_point: Point2D, snapResult: SnapResult, ctx: ModeContext): ClickResult {
    this.lastSnap = snapResult;
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

    const endPoint = roundPoint([
      ctx.startPoint[0] + ctx.tangent.direction[0] * distance,
      ctx.startPoint[1] + ctx.tangent.direction[1] * distance,
    ]);

    if (ctx.solved) {
      this.emitSolved(endPoint, undefined, undefined, ctx);
    }
    ctx.hideExpressionInput();

    return {
      kind: 'committed',
      result: {
        endpoint: endPoint,
        exitTangent: { direction: ctx.tangent.direction, point: endPoint },
      },
    };
  }

  /**
   * Solved emission: a fully-specified line, related to the previous segment
   * by what "tangent continuation" means for it — `tangent` off an arc,
   * `collinear` off a line (locked §0.1 — never a pen `tLine`).
   */
  private emitSolved(
    endPoint: Point2D,
    lengthExpr: string | undefined,
    newVariable: { name: string; initializer: string } | undefined,
    ctx: ModeContext,
  ): void {
    const solved = ctx.solved!;
    const prev = solved.prevEntity();
    const constraints = [];
    if (prev) {
      constraints.push({
        kind: solved.prevKind() === 'arc' ? 'tangent' : 'collinear',
        targets: [prev, { newIndex: 0 }],
      });
    }
    if (lengthExpr !== undefined) {
      constraints.push({
        kind: 'distance',
        targets: [{ newIndex: 0, role: 'start' as const }, { newIndex: 0, role: 'end' as const }],
        valueExpr: lengthExpr,
      });
    }
    solved.emitSegment({
      kind: 'line',
      text: `line(${ctx.pendingStartText() ?? ctx.formatPoint(roundPoint(ctx.startPoint))}, ${ctx.formatPoint(endPoint)})`,
      constraints,
      endSnap: this.lastSnap,
      endPoint,
      newVariable,
    });
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnap = snapResult;

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
    const dimExpr = SketchTool.applySignedDimension(expression, sign);

    const committedDist = parseFloat(dimExpr);
    const resolvedDist = isNaN(committedDist) ? distance : committedDist;
    const endPoint = roundPoint([
      ctx.startPoint[0] + ctx.tangent.direction[0] * resolvedDist,
      ctx.startPoint[1] + ctx.tangent.direction[1] * resolvedDist,
    ]);

    if (ctx.solved) {
      // Only a TYPED value becomes a dimension; a click-committed one stays
      // a guess.
      this.emitSolved(
        endPoint,
        ctx.isExpressionTyping() ? dimMagnitude(expression) : undefined,
        newVariable,
        ctx,
      );
    }
    ctx.hideExpressionInput();
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
