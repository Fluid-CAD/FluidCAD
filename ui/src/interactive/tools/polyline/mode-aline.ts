import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D, SegmentCommitResult } from './types';
import type { SnapResult } from '../../../snapping/types';
import type { CommitResult } from '../../../ui/expression-input';
import type { NewVariable } from '../../sketch-tool';

const enum ALineSubState {
  AWAITING_ANGLE,
  AWAITING_LENGTH,
}

const ANGLE_SNAP_STEP_DEG = 15;
const ANGLE_SNAP_TOL_DEG = 2.5;

// Fraction of the preview line's length at which the angle-reference arc is drawn.
const ANGLE_ARC_RADIUS_FRACTION = 0.35;

/**
 * Two-stage angled-line mode: the first click locks the angle (degrees,
 * measured from the previous segment's end tangent, CCW positive), the second
 * locks the length. Emits the kernel's `aLine(angle, length)`.
 */
export class ALineMode implements SegmentMode {
  readonly id = 'aLine' as const;
  readonly label = 'A-Line';
  readonly requiresTangent = false;

  private subState: ALineSubState = ALineSubState.AWAITING_ANGLE;
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';
  /** Live mouse-derived angle in degrees, snapped to 15° multiples. */
  private previewAngle = 0;
  /** Numeric angle locked by the first stage (preview/endpoint math). */
  private lockedAngle: number | null = null;
  /** Source text for the angle argument — a typed expression or the number. */
  private angleExpr: string | null = null;
  private angleVariable: NewVariable | null = null;
  /** Live mouse-derived length while in AWAITING_LENGTH. */
  private previewLength = 0;

  // aLine has no explicit-start overload: it always draws from the sketch's
  // current position, so the mode is only offered when the chain is there.
  isAvailable(ctx: ModeContext): boolean {
    return ctx.isAtCurrentPosition(ctx.startPoint);
  }

  enter(_ctx: ModeContext): void {
    this.reset();
  }

  exit(ctx: ModeContext): void {
    this.reset();
    ctx.hideExpressionInput();
  }

  private reset(): void {
    this.subState = ALineSubState.AWAITING_ANGLE;
    this.mousePoint = null;
    this.lastSnapType = 'none';
    this.previewAngle = 0;
    this.lockedAngle = null;
    this.angleExpr = null;
    this.angleVariable = null;
    this.previewLength = 0;
  }

  private referenceDir(ctx: ModeContext): Point2D {
    return ctx.tangent?.direction ?? [1, 0];
  }

  /** Signed angle in degrees from `from` to `to`; positive = CCW, matching the
   * kernel's rotation in lib/features/2d/aline.ts. */
  private signedAngleDeg(from: Point2D, to: Point2D): number {
    const cross = from[0] * to[1] - from[1] * to[0];
    const dot = from[0] * to[0] + from[1] * to[1];
    return (Math.atan2(cross, dot) * 180) / Math.PI;
  }

  private snapAngle(angleDeg: number): number {
    const nearest = Math.round(angleDeg / ANGLE_SNAP_STEP_DEG) * ANGLE_SNAP_STEP_DEG;
    if (Math.abs(angleDeg - nearest) <= ANGLE_SNAP_TOL_DEG) {
      return nearest;
    }
    return angleDeg;
  }

  private rotate(dir: Point2D, angleDeg: number): Point2D {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [cos * dir[0] - sin * dir[1], sin * dir[0] + cos * dir[1]];
  }

  private lockedDir(ctx: ModeContext): Point2D {
    return this.rotate(this.referenceDir(ctx), this.lockedAngle ?? 0);
  }

  private lengthAlong(dir: Point2D, ctx: ModeContext, point: Point2D): number {
    const dx = point[0] - ctx.startPoint[0];
    const dy = point[1] - ctx.startPoint[1];
    return Math.max(0, dx * dir[0] + dy * dir[1]);
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      if (ctx.isExpressionVisible()) {
        // The field live-tracks the snapped mouse angle, so a plain click and a
        // typed Enter share one commit path.
        ctx.commitExpressionValue();
        return { kind: 'consumed' };
      }
      const dx = point[0] - ctx.startPoint[0];
      const dy = point[1] - ctx.startPoint[1];
      if (dx === 0 && dy === 0) {
        return { kind: 'ignored' };
      }
      const snapped = this.snapAngle(this.signedAngleDeg(this.referenceDir(ctx), [dx, dy]));
      this.lockAngle(String(Math.round(snapped * 100) / 100), snapped, null);
      return { kind: 'consumed' };
    }

    if (ctx.isExpressionVisible()) {
      ctx.commitExpressionValue();
      return { kind: 'ignored' };
    }

    const length = this.lengthAlong(this.lockedDir(ctx), ctx, point);
    const rounded = Math.round(length * 100) / 100;
    if (rounded === 0) {
      return { kind: 'ignored' };
    }
    return { kind: 'committed', result: this.emit(String(rounded), rounded, null, ctx) };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, clientX: number, clientY: number, ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;

    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      const dx = point[0] - ctx.startPoint[0];
      const dy = point[1] - ctx.startPoint[1];
      if (dx !== 0 || dy !== 0) {
        this.previewAngle = this.snapAngle(this.signedAngleDeg(this.referenceDir(ctx), [dx, dy]));
      }

      if (!ctx.isExpressionVisible()) {
        ctx.showExpressionInput({
          label: 'A:',
          value: String(Math.round(this.previewAngle * 100) / 100),
          clientX,
          clientY,
          onCommit: (result) => this.commitAngle(result, ctx),
        });
      } else {
        ctx.updateExpressionValue(this.previewAngle);
        ctx.updateExpressionPosition(clientX, clientY);
      }
      return;
    }

    this.previewLength = this.lengthAlong(this.lockedDir(ctx), ctx, point);

    if (!ctx.isExpressionVisible()) {
      ctx.showExpressionInput({
        label: 'L:',
        value: String(Math.round(this.previewLength * 100) / 100),
        clientX,
        clientY,
        onCommit: (result) => this.commitLength(result, ctx),
      });
    } else {
      ctx.updateExpressionValue(this.previewLength);
      ctx.updateExpressionPosition(clientX, clientY);
    }
  }

  handleEscape(ctx: ModeContext): boolean {
    if (this.subState === ALineSubState.AWAITING_LENGTH) {
      this.subState = ALineSubState.AWAITING_ANGLE;
      this.lockedAngle = null;
      this.angleExpr = null;
      this.angleVariable = null;
      this.previewLength = 0;
      ctx.hideExpressionInput();
      return true;
    }
    if (ctx.isExpressionVisible()) {
      ctx.hideExpressionInput();
      return true;
    }
    return false;
  }

  private lockAngle(expr: string, numericFallback: number, variable: NewVariable | null): void {
    this.angleExpr = expr;
    this.angleVariable = variable;
    const parsed = parseFloat(expr);
    this.lockedAngle = isNaN(parsed) ? Math.round(numericFallback * 100) / 100 : parsed;
    this.subState = ALineSubState.AWAITING_LENGTH;
  }

  private commitAngle(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    this.lockAngle(expression, this.previewAngle, newVariable ?? null);
    ctx.hideExpressionInput();
    ctx.requestRender();
  }

  private commitLength(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    const parsed = parseFloat(expression);
    const numericLength = isNaN(parsed) ? Math.round(this.previewLength * 100) / 100 : parsed;
    ctx.onSegmentCommitted(this.emit(expression, numericLength, newVariable ?? null, ctx));
  }

  private emit(lengthExpr: string, numericLength: number, lengthVariable: NewVariable | null, ctx: ModeContext): SegmentCommitResult {
    const angleArg = this.angleExpr ?? String(this.lockedAngle ?? 0);
    const statement = `aLine(${angleArg}, ${lengthExpr})`;

    const vars: NewVariable[] = [];
    if (this.angleVariable) {
      vars.push(this.angleVariable);
    }
    if (lengthVariable) {
      vars.push(lengthVariable);
    }
    ctx.insertGeometry(statement, vars.length > 0 ? vars : undefined);
    ctx.hideExpressionInput();

    const dir = this.lockedDir(ctx);
    const endpoint = roundPoint([
      ctx.startPoint[0] + dir[0] * numericLength,
      ctx.startPoint[1] + dir[1] * numericLength,
    ]);
    // A typed negative length draws the segment backwards; the chain's exit
    // tangent follows the drawn direction, matching the kernel's end tangent.
    const sign = numericLength < 0 ? -1 : 1;
    const exitDir: Point2D = [dir[0] * sign, dir[1] * sign];

    return { endpoint, exitTangent: { direction: exitDir, point: endpoint } };
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (!this.mousePoint) {
      return;
    }

    let effectiveEnd: Point2D | null = null;

    if (this.subState === ALineSubState.AWAITING_ANGLE) {
      const previewDir = this.rotate(this.referenceDir(ctx), this.previewAngle);
      const length = this.lengthAlong(previewDir, ctx, this.mousePoint);
      if (length > 1e-10) {
        effectiveEnd = [
          ctx.startPoint[0] + previewDir[0] * length,
          ctx.startPoint[1] + previewDir[1] * length,
        ];
        addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);

        if (Math.abs(this.previewAngle) > 1e-6) {
          const ref = this.referenceDir(ctx);
          const startAngle = Math.atan2(ref[1], ref[0]);
          const endAngle = startAngle + (this.previewAngle * Math.PI) / 180;
          addDashedArc(
            ctx.previewGroup,
            ctx.startPoint,
            length * ANGLE_ARC_RADIUS_FRACTION,
            startAngle,
            endAngle,
            this.previewAngle > 0,
            ctx.plane,
          );
        }
      }
    } else {
      const dir = this.lockedDir(ctx);
      if (this.previewLength > 1e-10) {
        effectiveEnd = [
          ctx.startPoint[0] + dir[0] * this.previewLength,
          ctx.startPoint[1] + dir[1] * this.previewLength,
        ];
        addDashedLine(ctx.previewGroup, ctx.startPoint, effectiveEnd, ctx.plane);
      }
    }

    if (effectiveEnd && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(ctx.previewGroup, effectiveEnd, snapColor, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
    }
  }
}
