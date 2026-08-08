import { Color, LineSegments, Object3D } from 'three';
import { SceneContext } from '../../scene/scene-context';
import { themeColors } from '../../scene/theme-colors';

/**
 * Tints a picked path geometry's scene lines in the selection color — the
 * text dialogs' "this curve is the path" highlight. Same mechanics as the
 * sketch hover/select handler's tint (mutate the live material color, stash
 * the original on the line's userData), under its own key so the two never
 * fight over restore values — not that they run together: the hover handler
 * is inactive while a drawing tool or an edit session owns the viewport.
 *
 * Scene re-renders replace the line meshes (and their shape ids), so the
 * owner must call {@link set} again with the re-resolved ids after every
 * render — there is nothing to restore on the replaced meshes.
 */
export class PathHighlight {
  private shapeIds: string[] = [];

  constructor(private readonly ctx: SceneContext) {}

  /** Highlight exactly these shapes (clears the previous set first). */
  set(shapeIds: string[]): void {
    this.clear();
    this.shapeIds = [...shapeIds];
    const wanted = new Set(this.shapeIds);
    this.traverseLines((line, shapeId) => {
      if (!wanted.has(shapeId)) {
        return;
      }
      const color = PathHighlight.lineColor(line);
      if (color && line.userData.pathOriginalColor === undefined) {
        line.userData.pathOriginalColor = color.getHex();
        color.set(themeColors.highlightColor);
      }
    });
    this.ctx.requestRender();
  }

  clear(): void {
    if (this.shapeIds.length === 0) {
      return;
    }
    this.shapeIds = [];
    this.traverseLines((line) => {
      if (line.userData.pathOriginalColor !== undefined) {
        PathHighlight.lineColor(line)?.setHex(line.userData.pathOriginalColor);
        delete line.userData.pathOriginalColor;
      }
    });
    this.ctx.requestRender();
  }

  private traverseLines(fn: (line: LineSegments, shapeId: string) => void): void {
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isMetaShape && !obj.userData.isGuideShape) {
        return;
      }
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      const shapeId = PathHighlight.findShapeId(obj);
      if (shapeId) {
        fn(obj as LineSegments, shapeId);
      }
    });
  }

  /** The shapeId a line belongs to, walked up through its shape group. */
  private static findShapeId(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      // Guide groups carry isMetaShape (they share the dash-dot meta
      // rendering) but are pickable paths — their shapeId counts.
      if (cur.userData.shapeId && (!cur.userData.isMetaShape || cur.userData.isGuideShape)) {
        return cur.userData.shapeId as string;
      }
      cur = cur.parent;
    }
    return null;
  }

  /** The line's color wherever the material keeps it: plain line materials
   * expose `.color`, the guide dash-dot ShaderMaterial carries it as the
   * `color` uniform. Returns the live Color object, so mutating it recolors
   * the line. */
  private static lineColor(line: LineSegments): Color | null {
    const mat = (line as any).material;
    if (!mat) {
      return null;
    }
    if (mat.color instanceof Color) {
      return mat.color;
    }
    const uniform = mat.uniforms?.color?.value;
    return uniform instanceof Color ? uniform : null;
  }
}
