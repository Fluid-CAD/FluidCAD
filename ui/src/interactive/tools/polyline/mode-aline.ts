import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
} from '../tool-preview-utils';
import { chainAngleConstraint, dimMagnitude, type SolvedConstraintParam } from '../solved-emission';
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
 * locks the length. Emits a fully-specified `line(start, end)` whose angle
 * intent becomes an `angle(prev, new, deg)` constraint and whose typed length
 * becomes a `distance` dimension.
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

  enter(ctx: ModeContext): void {
    this.reset();
    ctx.setSnapHint(null);
  }

  exit(ctx: ModeContext): void {
    this.reset();
    ctx.hideExpressionInput();
    ctx.setSnapHint(null);
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

  /** Signed angle in degrees from `from` to `to`; positive = CCW, matching
   * the solver's rotation convention. */
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
      this.lockAngle(String(Math.round(snapped * 100) / 100), snapped, true, null);
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
    return { kind: 'committed', result: this.emit(String(rounded), rounded, null, ctx, false) };
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
      ctx.setSnapHint(null);
      ctx.hideExpressionInput();
      return true;
    }
    if (ctx.isExpressionVisible()) {
      ctx.hideExpressionInput();
      return true;
    }
    return false;
  }

  private lockAngle(expr: string, numeric: number, resolved: boolean, variable: NewVariable | null): void {
    this.angleExpr = expr;
    this.angleVariable = variable;
    this.lockedAngle = resolved ? numeric : Math.round(numeric * 100) / 100;
    this.subState = ALineSubState.AWAITING_LENGTH;
  }

  private commitAngle(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    // The expression's actual value (a variable declaration, parentheses,
    // arithmetic) — parseFloat alone reads none of those, and a preview
    // direction that disagrees with what the kernel will draw corrupts the
    // endpoint math. Only a statically unresolvable expression falls back to
    // the mouse angle.
    const value = ctx.resolveCommittedValue(result);
    this.lockAngle(expression, value ?? this.previewAngle, value !== null, newVariable ?? null);
    ctx.hideExpressionInput();
    ctx.requestRender();
  }

  private commitLength(result: CommitResult, ctx: ModeContext): void {
    const { expression, newVariable } = result;
    const value = ctx.resolveCommittedValue(result);
    const numericLength = value ?? Math.round(this.previewLength * 100) / 100;
    // Only a TYPED length becomes a dimension; a click merely commits the
    // pill's mouse-tracked value.
    ctx.onSegmentCommitted(this.emit(expression, numericLength, newVariable ?? null, ctx, ctx.isExpressionTyping()));
  }

  private emit(lengthExpr: string, numericLength: number, lengthVariable: NewVariable | null, ctx: ModeContext, typedLength: boolean): SegmentCommitResult {
    const dir = this.lockedDir(ctx);
    const endpoint = roundPoint([
      ctx.startPoint[0] + dir[0] * numericLength,
      ctx.startPoint[1] + dir[1] * numericLength,
    ]);
    // A typed negative length draws the segment backwards; the chain's exit
    // tangent follows the drawn direction, matching the kernel's end tangent.
    const sign = numericLength < 0 ? -1 : 1;
    const exitDir: Point2D = [dir[0] * sign, dir[1] * sign];

    this.emitSolvedLine(endpoint, exitDir, typedLength ? lengthExpr : null, lengthVariable, ctx);
    ctx.hideExpressionInput();

    return { endpoint, exitTangent: { direction: exitDir, point: endpoint } };
  }

  /**
   * Solved emission (locked §0.1): a fully-specified line whose angle intent
   * becomes an `angle(prev, new, deg)` statement per the CCW ≤ 180° rule —
   * only expressible against a previous LINE (angle is line–line; off an arc
   * or a free chain start the geometry keeps its drawn guesses). A typed
   * length becomes a `distance` dimension.
   */
  private emitSolvedLine(
    endpoint: Point2D,
    exitDir: Point2D,
    lengthExpr: string | null,
    lengthVariable: NewVariable | null,
    ctx: ModeContext,
  ): void {
    const solved = ctx.solved!;
    const constraints: SolvedConstraintParam[] = [];
    const prev = solved.prevEntity();
    const prevDir = solved.prevOrientedDir();
    if (prev && prevDir && solved.prevKind() === 'line') {
      const angle = chainAngleConstraint(prev, { newIndex: 0 }, prevDir, exitDir);
      if (angle) {
        constraints.push(angle);
      }
    }
    if (lengthExpr !== null) {
      constraints.push({
        kind: 'distance',
        targets: [{ newIndex: 0, role: 'start' }, { newIndex: 0, role: 'end' }],
        valueExpr: dimMagnitude(lengthExpr),
      });
    }
    solved.emitSegment({
      kind: 'line',
      text: `line(${ctx.pendingStartText() ?? ctx.formatPoint(roundPoint(ctx.startPoint))}, ${ctx.formatPoint(endpoint)})`,
      constraints,
      endPoint: endpoint,
      newVariable: lengthVariable ?? undefined,
    });
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
