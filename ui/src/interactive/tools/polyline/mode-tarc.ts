import { roundPoint } from '../../sketch-plane-utils';
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

    const roundedEnd = roundPoint(point);
    ctx.insertGeometry(`tArc(${ctx.formatPoint(roundedEnd)})`);

    const arc = this.computeArcPreview(ctx.startPoint, point, ctx.tangent.direction);
    let exitTangent = null;
    if (arc) {
      const dx = roundedEnd[0] - arc.center[0];
      const dy = roundedEnd[1] - arc.center[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-10) {
        const tx = arc.ccw ? -dy / len : dy / len;
        const ty = arc.ccw ? dx / len : -dx / len;
        exitTangent = { direction: [tx, ty] as Point2D, point: roundedEnd };
      }
    }

    return { kind: 'committed', result: { endpoint: roundedEnd, exitTangent } };
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
