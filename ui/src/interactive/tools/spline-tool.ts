import { ICON_SPLINE } from '../../ui/icons';
import { ControlPointCurveTool } from './control-point-curve-tool';
import { addDashedSpline } from './tool-preview-utils';

/**
 * The Spline tool: click the points the curve passes through, in order.
 * The preview shows the interpolating curve through the placed points and
 * the cursor — no control polygon, the points ARE on the curve.
 */
export class SplineTool extends ControlPointCurveTool {
  readonly id = 'spline' as const;
  readonly label = 'Spline';
  readonly icon = ICON_SPLINE;
  protected readonly kind = 'spline' as const;

  protected drawPreviewCurve(points: [number, number][]): void {
    addDashedSpline(this.previewGroup, points, this.plane);
  }
}
