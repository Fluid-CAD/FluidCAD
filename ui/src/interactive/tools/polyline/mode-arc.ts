import { roundPoint, dist2D } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
  addDashedArc,
  circumcenter,
  angleFromCenter,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';

const enum ArcSubState {
  AWAITING_END,
  AWAITING_THROUGH,
}

export class ArcMode implements SegmentMode {
  readonly id = 'arc' as const;
  readonly label = 'Arc';
  readonly requiresTangent = false;

  private subState: ArcSubState = ArcSubState.AWAITING_END;
  private endPoint: Point2D | null = null;
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapResult['snapType'] = 'none';

  enter(_ctx: ModeContext): void {
    this.subState = ArcSubState.AWAITING_END;
    this.endPoint = null;
    this.mousePoint = null;
    this.lastSnapType = 'none';
  }

  exit(_ctx: ModeContext): void {
    this.subState = ArcSubState.AWAITING_END;
    this.endPoint = null;
    this.mousePoint = null;
  }

  handleClick(point: Point2D, _snapResult: SnapResult, ctx: ModeContext): ClickResult {
    if (this.subState === ArcSubState.AWAITING_END) {
      if (dist2D(ctx.startPoint, point) < 1e-6) {
        return { kind: 'ignored' };
      }
      this.endPoint = point;
      this.subState = ArcSubState.AWAITING_THROUGH;
      return { kind: 'consumed' };
    }

    if (!this.endPoint) {
      return { kind: 'ignored' };
    }

    const center = circumcenter(ctx.startPoint, this.endPoint, point);
    if (!center) {
      return { kind: 'ignored' };
    }

    const ccw = this.isMouseCCW(ctx.startPoint, this.endPoint, point, center);
    const roundedStart = roundPoint(ctx.startPoint);
    const roundedEnd = roundPoint(this.endPoint);
    const roundedCenter = roundPoint(center);
    const cwSuffix = ccw ? '' : '.cw()';
    const atCurrent = ctx.isAtCurrentPosition(roundedStart);

    const statement = atCurrent
      ? `arc(${ctx.formatPoint(roundedEnd)}).center(${ctx.formatPoint(roundedCenter)})${cwSuffix}`
      : `arc(${ctx.formatPoint(roundedStart)}, ${ctx.formatPoint(roundedEnd)}).center(${ctx.formatPoint(roundedCenter)})${cwSuffix}`;
    ctx.insertGeometry(statement);

    const exitTangent = this.computeExitTangent(roundedEnd, roundedCenter, ccw);

    return {
      kind: 'committed',
      result: { endpoint: roundedEnd, exitTangent },
    };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, _clientX: number, _clientY: number, _ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;
  }

  handleEscape(_ctx: ModeContext): boolean {
    if (this.subState === ArcSubState.AWAITING_THROUGH) {
      this.endPoint = null;
      this.subState = ArcSubState.AWAITING_END;
      return true;
    }
    return false;
  }

  private isMouseCCW(start: Point2D, end: Point2D, through: Point2D, center: Point2D): boolean {
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);
    const mouseAngle = angleFromCenter(center, through);
    let startToMouse = mouseAngle - startAngle;
    if (startToMouse < 0) {
      startToMouse += Math.PI * 2;
    }
    let startToEnd = endAngle - startAngle;
    if (startToEnd < 0) {
      startToEnd += Math.PI * 2;
    }
    return startToMouse < startToEnd;
  }

  private semicirclePreview(
    start: Point2D,
    end: Point2D,
  ): { center: Point2D; radius: number; startAngle: number; endAngle: number } | null {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const chordLen = Math.sqrt(dx * dx + dy * dy);
    if (chordLen < 1e-6) {
      return null;
    }
    const center: Point2D = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    const radius = chordLen / 2;
    const startAngle = angleFromCenter(center, start);
    const endAngle = angleFromCenter(center, end);
    return { center, radius, startAngle, endAngle };
  }

  private computeExitTangent(endpoint: Point2D, center: Point2D, ccw: boolean) {
    const dx = endpoint[0] - center[0];
    const dy = endpoint[1] - center[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-10) {
      return null;
    }
    const tx = ccw ? -dy / len : dy / len;
    const ty = ccw ? dx / len : -dx / len;
    return { direction: [tx, ty] as Point2D, point: endpoint };
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.subState === ArcSubState.AWAITING_END) {
      if (this.mousePoint) {
        const semi = this.semicirclePreview(ctx.startPoint, this.mousePoint);
        if (semi) {
          addDashedArc(ctx.previewGroup, semi.center, semi.radius, semi.startAngle, semi.endAngle, true, ctx.plane);
        }

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(ctx.previewGroup, this.mousePoint, color, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
        }
      }
    } else if (this.endPoint) {
      addDot(ctx.previewGroup, this.endPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);
      addDashedLine(ctx.previewGroup, ctx.startPoint, this.endPoint, ctx.plane);

      if (this.mousePoint) {
        const center = circumcenter(ctx.startPoint, this.endPoint, this.mousePoint);
        if (center) {
          const radius = dist2D(center, ctx.startPoint);
          const startAngle = angleFromCenter(center, ctx.startPoint);
          const endAngle = angleFromCenter(center, this.endPoint);
          const ccw = this.isMouseCCW(ctx.startPoint, this.endPoint, this.mousePoint, center);
          addDashedArc(ctx.previewGroup, center, radius, startAngle, endAngle, ccw, ctx.plane);
        }

        if (this.lastSnapType !== 'none') {
          const color = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
          addDot(ctx.previewGroup, this.mousePoint, color, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
        }
      }
    }
  }
}
