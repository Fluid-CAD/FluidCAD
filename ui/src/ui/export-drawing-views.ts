import { NAMED_VIEW_DIRECTIONS } from '../screenshot-view';
import type { ExportDrawingView } from '../api';

/** A direction in model space; only where it points matters, not its length. */
export type ViewDirection = { x: number; y: number; z: number };

/**
 * Where a drawing export's default view comes from. Injected rather than
 * imported so the dialog never reaches into the viewer: only the host holds
 * the camera.
 */
export interface ExportViewProvider {
  /**
   * The direction from the model to the camera — the side the user is
   * looking from; null while there is no camera to ask.
   */
  eyeDirection(): ViewDirection | null;
}

/** One view of the dialog's View select: the plane the server draws on, and how the select names it. */
export type DrawingViewOption = { view: ExportDrawingView; label: string };

/**
 * How squarely the camera must face a standard view for a drawing to open
 * on it, as the cosine of the angle between them: within 30°. A camera
 * further off every view — the isometric the viewport opens on, any orbit in
 * between — is on no side in particular, and the drawing opens on Top.
 */
const FACING_COS = Math.cos(Math.PI / 6);

/**
 * The six standard views a drawing export (DXF, SVG) offers, kept free of the
 * DOM: the select's options and the one a drawing opens on.
 * The view names are the server's standard plane names (`top` is the XY
 * plane seen from +Z), and the same six the camera's named views use, so
 * "Front" here is the Front the viewport shows.
 */
export class DrawingViews {
  /** The select's options, in the order it lists them. Top leads: the plan view is the default. */
  static readonly OPTIONS: readonly DrawingViewOption[] = [
    { view: 'top', label: 'Top (XY)' },
    { view: 'bottom', label: 'Bottom (−XY)' },
    { view: 'front', label: 'Front (XZ)' },
    { view: 'back', label: 'Back (−XZ)' },
    { view: 'right', label: 'Right (YZ)' },
    { view: 'left', label: 'Left (−YZ)' },
  ];

  static readonly DEFAULT: ExportDrawingView = 'top';

  static isView(value: unknown): value is ExportDrawingView {
    return DrawingViews.OPTIONS.some((option) => option.view === value);
  }

  /**
   * The view a drawing opens on: Top, unless the camera clearly looks from
   * another side — within 30° of that standard view's own eye direction, as
   * after snapping to Front on the view gizmo. A camera with no direction to
   * read (none given, zero length, not finite) is Top as well.
   */
  static facing(eye: ViewDirection | null | undefined): ExportDrawingView {
    if (!eye) {
      return DrawingViews.DEFAULT;
    }
    const length = Math.hypot(eye.x, eye.y, eye.z);
    if (!Number.isFinite(length) || length === 0) {
      return DrawingViews.DEFAULT;
    }
    // The six directions are 90° apart or more, so at most one is within 30°.
    for (const { view } of DrawingViews.OPTIONS) {
      const direction = NAMED_VIEW_DIRECTIONS[view];
      const cos = (eye.x * direction.x + eye.y * direction.y + eye.z * direction.z) / length;
      if (cos >= FACING_COS) {
        return view;
      }
    }
    return DrawingViews.DEFAULT;
  }
}
