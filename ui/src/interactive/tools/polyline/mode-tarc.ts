import { roundPoint } from '../../sketch-plane-utils';
import { computeFixedRadiusArc } from '../../drag-move-handler/constraint-math';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedArc,
  angleFromCenter,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D, SegmentCommitResult, TangentInfo } from './types';
import type { SnapResult } from '../../../snapping/types';

export class TArcMode implements SegmentMode {
  readonly id = 'tArc' as const;
  readonly label = 'T-Arc';
  readonly requiresTangent = true;

  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';

  enter(ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnapType = 'none';
    ctx.setSnapHint(null);
  }

  exit(ctx: ModeContext): void {
    this.mousePoint = null;
    ctx.setSnapHint(null);
  }

  handleClick(point: Point2D, snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (!ctx.tangent) {
      return { kind: 'ignored' };
    }

    const result = this.commitRadiusToPoint(point, ctx, snapResult);
    if (!result) {
      return { kind: 'ignored' };
    }
    return { kind: 'committed', result };
  }

  /**
   * The tangent-arc commit at `point`, or null when the point solves no
   * tangent arc. The solved radius is baked into the emitted arc's center —
   * the drawn shape is kept exactly, and the chain continues from the end
   * the kernel will build (the written endpoint re-projected onto the
   * rounded-radius circle) so the tool's position can't drift off the
   * rendered geometry a little per arc.
   */
  private commitRadiusToPoint(point: Point2D, ctx: ModeContext, snapResult?: SnapResult): SegmentCommitResult | null {
    if (!ctx.tangent || !ctx.solved) {
      return null;
    }
    const tangent = ctx.tangent.direction;
    const solved = this.computeArcPreview(ctx.startPoint, point, tangent);
    if (!solved) {
      return null;
    }
    const radius = Math.round(solved.radius * 100) / 100;
    if (radius === 0) {
      return null;
    }

    const aimed = computeFixedRadiusArc(ctx.startPoint, point, radius, tangent);
    if (!aimed) {
      return null;
    }
    const written = roundPoint(aimed.end);
    const built = computeFixedRadiusArc(ctx.startPoint, written, radius, tangent);
    if (!built) {
      return null;
    }

    const prev = ctx.solved.prevEntity();
    const roundedStart = roundPoint(ctx.startPoint);
    ctx.solved.emitSegment({
      kind: 'arc',
      text: `arc(${ctx.pendingStartText() ?? ctx.formatPoint(roundedStart)}, ${ctx.formatPoint(written)}, ${ctx.formatPoint(roundPoint(built.center))})${built.ccw ? '' : '.cw()'}`,
      constraints: prev
        ? [{ kind: 'tangent', targets: [prev, { newIndex: 0 }] }]
        : [],
      // The snapped vertex is ~half a rounding step off the written end —
      // the coincident is exactly how the solver closes that gap.
      endSnap: snapResult ?? null,
      newVariable: undefined,
    });

    return {
      endpoint: built.end,
      exitTangent: this.exitTangentAt(built.center, built.ccw, built.end),
    };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, _clientX: number, _clientY: number, _ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;
  }

  handleEscape(_ctx: ModeContext): boolean {
    return false;
  }

  /** The chain's exit tangent at `endpoint` on the arc's circle, or null when degenerate. */
  private exitTangentAt(center: Point2D, ccw: boolean, endpoint: Point2D): TangentInfo | null {
    const dx = endpoint[0] - center[0];
    const dy = endpoint[1] - center[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len <= 1e-10) {
      return null;
    }
    const tx = ccw ? -dy / len : dy / len;
    const ty = ccw ? dx / len : -dx / len;
    return { direction: [tx, ty], point: endpoint };
  }

  private computeArcPreview(
    start: Point2D,
    end: Point2D,
    tangent: Point2D,
  ): { center: Point2D; radius: number; startAngle: number; endAngle: number; ccw: boolean } | null {
    const perpX = -tangent[1];
    const perpY = tangent[0];

    const dx = start[0] - end[0];
    const dy = start[1] - end[1];
    const distSq = dx * dx + dy * dy;
    const dDotN = dx * perpX + dy * perpY;

    if (Math.abs(dDotN) < 1e-10) {
      return null;
    }

    const t = -distSq / (2 * dDotN);
    const radius = Math.abs(t);
    const center: Point2D = [start[0] + perpX * t, start[1] + perpY * t];
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);

    return { center, radius, startAngle, endAngle, ccw: t >= 0 };
  }

  rebuildPreview(ctx: ModeContext): void {
    if (!ctx.tangent) {
      return;
    }

    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.mousePoint) {
      const arc = this.computeArcPreview(ctx.startPoint, this.mousePoint, ctx.tangent.direction);
      if (arc) {
        addDashedArc(ctx.previewGroup, arc.center, arc.radius, arc.startAngle, arc.endAngle, arc.ccw, ctx.plane);
      }

      if (this.lastSnapType !== 'none') {
        const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(ctx.previewGroup, this.mousePoint, color, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
      }
    }
  }
}
