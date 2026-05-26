import { roundPoint } from '../../sketch-plane-utils';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedLine,
} from '../tool-preview-utils';
import type { SegmentMode, ModeContext, ClickResult, Point2D } from './types';
import type { SnapResult } from '../../../snapping/types';

export class LineMode implements SegmentMode {
  readonly id = 'line' as const;
  readonly label = 'Line';
  readonly requiresTangent = false;

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
    const roundedStart = roundPoint(ctx.startPoint);
    const roundedEnd = roundPoint(point);
    const atCurrent = ctx.isAtCurrentPosition(roundedStart);

    const statement = atCurrent
      ? `line(${ctx.formatPoint(roundedEnd)})`
      : `line(${ctx.formatPoint(roundedStart)}, ${ctx.formatPoint(roundedEnd)})`;
    ctx.insertGeometry(statement);

    const dx = roundedEnd[0] - roundedStart[0];
    const dy = roundedEnd[1] - roundedStart[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    const exitTangent = len > 1e-10
      ? { direction: [dx / len, dy / len] as Point2D, point: roundedEnd }
      : null;

    return { kind: 'committed', result: { endpoint: roundedEnd, exitTangent } };
  }

  handleMouseMove(point: Point2D, snapResult: SnapResult, _clientX: number, _clientY: number, _ctx: ModeContext): void {
    this.mousePoint = point;
    this.lastSnapType = snapResult.snapType;
  }

  handleEscape(_ctx: ModeContext): boolean {
    return false;
  }

  rebuildPreview(ctx: ModeContext): void {
    addDot(ctx.previewGroup, ctx.startPoint, START_POINT_COLOR, ctx.camera, ctx.planeNormal, ctx.plane);

    if (this.mousePoint) {
      addDashedLine(ctx.previewGroup, ctx.startPoint, this.mousePoint, ctx.plane);

      if (this.lastSnapType !== 'none') {
        const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
        addDot(ctx.previewGroup, this.mousePoint, snapColor, ctx.camera, ctx.planeNormal, ctx.plane, 0.6);
      }
    }
  }
}
