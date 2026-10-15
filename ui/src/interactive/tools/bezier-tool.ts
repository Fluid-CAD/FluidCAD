import { ICON_BEZIER } from '../../ui/icons';
import { ControlPointCurveTool } from './control-point-curve-tool';
import { addDashedBezier, addDashedLine } from './tool-preview-utils';

/**
 * The Bezier tool: click the poles in order — start, control points, end.
 * The preview shows the control polygon (dashed, pole to pole) and the
 * curve it pulls into shape.
 */
export class BezierTool extends ControlPointCurveTool {
  readonly id = 'bezier' as const;
  readonly label = 'Bezier';
  readonly icon = ICON_BEZIER;
  protected readonly kind = 'bezier' as const;

  protected drawPreviewCurve(points: [number, number][]): void {
    for (let i = 1; i < points.length; i++) {
      addDashedLine(this.previewGroup, points[i - 1], points[i], this.plane);
    }
    addDashedBezier(this.previewGroup, points, this.plane);
  }
}
