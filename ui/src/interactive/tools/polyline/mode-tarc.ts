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
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';

export class TArcMode implements SegmentMode {
  readonly id = 'tArc' as const;
  readonly label = 'T-Arc';
  readonly requiresTangent = true;

  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';

  enter(_ctx: ModeContext): void {
    this.mousePoint = null;
    this.lastSnapType = 'none';
  }

  exit(_ctx: ModeContext): void {
    this.mousePoint = null;
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (!ctx.tangent) {
      return { kind: 'ignored' };
    }

    const tangent = ctx.tangent.direction;
    // The solved radius is written out explicitly — the radius + endpoint
    // overload keeps the drawn shape while making the radius editable as a
    // plain dimension. A collinear endpoint has no tangent arc: ignore.
    const solved = this.computeArcPreview(ctx.startPoint, point, tangent);
    if (!solved) {
      return { kind: 'ignored' };
    }
    const radius = Math.round(solved.radius * 100) / 100;
    if (radius === 0) {
      return { kind: 'ignored' };
    }

    // The written endpoint must lie on the rounded-radius circle, and the
    // chain must continue from the exact end the kernel will build (the
    // written endpoint re-projected onto that circle) — otherwise the
    // tool's position drifts off the rendered geometry a little per arc.
    const aimed = computeFixedRadiusArc(ctx.startPoint, point, radius, tangent);
    if (!aimed) {
      return { kind: 'ignored' };
    }
    const written = roundPoint(aimed.end);
    const built = computeFixedRadiusArc(ctx.startPoint, written, radius, tangent);
    if (!built) {
      return { kind: 'ignored' };
    }
    ctx.insertGeometry(`tArc(${radius}, ${ctx.formatPoint(written)})`);

    const endpoint = built.end;
    let exitTangent = null;
    const dx = endpoint[0] - built.center[0];
    const dy = endpoint[1] - built.center[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-10) {
      const tx = built.ccw ? -dy / len : dy / len;
      const ty = built.ccw ? dx / len : -dx / len;
      exitTangent = { direction: [tx, ty] as Point2D, point: endpoint };
    }

    return { kind: 'committed', result: { endpoint, exitTangent } };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, _clientX: number, _clientY: number, _ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;
  }

  handleEscape(_ctx: ModeContext): boolean {
    return false;
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
