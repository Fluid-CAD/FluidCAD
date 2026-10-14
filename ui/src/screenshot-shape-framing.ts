import { Box3, Vector3, type Object3D, type OrthographicCamera, type PerspectiveCamera } from 'three';
import { computeTightFraming, type FitLens } from './scene/camera-fit';
import { geometryPartsOf, unionBox } from './scene/scene-geometry-bounds';
import { orientCameraForView, resolveView, type ScreenshotView } from './screenshot-view';
import { ScreenshotScopes } from './screenshot-overlays';

// Mirrored from server/src/ws-protocol.ts — the UI does not import the
// server's compilation graph; the shape only ever crosses as JSON.

/**
 * A capture's `fitTo: { shapes, margin? }`: shape ids or assembly instance
 * ids to frame, and the frame's size as a multiple of what they cover on
 * screen (1 = flush with the frame edge on the tighter axis).
 */
export type ScreenshotShapeFit = {
  shapes: string[];
  margin?: number;
};

/**
 * Framing a capture on a set of shapes rather than the model: the view gives
 * the direction, and the page's tight fit ({@link computeTightFraming})
 * solves the target and the zoom (an orthographic camera) or the distance (a
 * perspective one) for the shapes as they are drawn — one box per drawn
 * piece, world matrices refreshed, so an assembly instance is framed where
 * its pose puts it and an L-shaped part is not framed by the empty corner of
 * its box. Framing only: nothing is hidden or ghosted, and the capture's own
 * `hide`/`focus` do not move the frame (a hidden target is framed where it is).
 */
export class ScreenshotShapeFraming {

  /** A small margin: the shapes fill about 83% of the frame on its tighter axis. */
  static readonly DEFAULT_MARGIN = 1.2;

  private constructor(
    /** Every drawn piece of the targets, world space. */
    readonly parts: readonly Box3[],
    readonly margin: number,
  ) {}

  /**
   * Measure the targets in `scene`. Throws naming every id the page draws
   * nothing for — call it before the capture changes the scene, so a refusal
   * leaves nothing to undo.
   */
  static measure(scene: Object3D, fit: ScreenshotShapeFit): ScreenshotShapeFraming {
    const parts: Box3[] = [];
    const missing: string[] = [];
    for (const id of fit.shapes) {
      const found = ScreenshotShapeFraming.partsOf(scene, id);
      if (found.length === 0) {
        missing.push(id);
      }
      parts.push(...found);
    }
    if (missing.length > 0) {
      const names = missing.map(id => `"${id}"`).join(', ');
      throw new Error(`fitTo.shapes: nothing is drawn on the page for ${names}, so there is nothing to frame.`);
    }
    return new ScreenshotShapeFraming(parts, fit.margin ?? ScreenshotShapeFraming.DEFAULT_MARGIN);
  }

  /**
   * The drawn pieces of every object `id` addresses (a shape group, or an
   * instance group with everything in it). A match nested inside another is
   * measured with its ancestor, not twice.
   */
  private static partsOf(scene: Object3D, id: string): Box3[] {
    const roots = ScreenshotScopes.matching(scene, new Set([id]));
    const rootSet = new Set(roots);
    const parts: Box3[] = [];
    for (const root of roots) {
      if (root.parent && ScreenshotScopes.isUnder(root.parent, rootSet)) {
        continue;
      }
      for (const part of geometryPartsOf(root)) {
        if (!part.isEmpty()) {
          parts.push(part);
        }
      }
    }
    return parts;
  }

  /**
   * Point `camera` at the shapes from `view`'s direction and frame them in a
   * `size` canvas. `current` is the interactive camera's eye and target, which
   * the `current` and `orbit-from-current` views start from. A `look-from`
   * view lends its direction only: the fit decides where the camera stands.
   * Returns false, leaving the camera as `view` would have pointed it, when
   * there is no direction or nothing with extent to frame.
   */
  pose(
    camera: OrthographicCamera | PerspectiveCamera,
    view: ScreenshotView,
    current: { eye: Vector3; target: Vector3 },
    size: { width: number; height: number },
  ): boolean {
    const bounds = unionBox(this.parts);
    const center = bounds.getCenter(new Vector3());
    const diameter = bounds.getSize(new Vector3()).length();
    const direction = ScreenshotShapeFraming.directionFor(camera, view, center, diameter, current);
    if (!direction) {
      return false;
    }

    // Look at the shapes from that direction first: the tight fit solves
    // against the camera's own basis, up vector included.
    const standoff = Math.max(diameter, 1);
    const eye = center.clone().addScaledVector(direction, standoff);
    if (view.kind === 'current') {
      // The interactive view keeps its roll (a sketch camera's up is the sketch's Y).
      camera.position.copy(eye);
      camera.lookAt(center);
    } else {
      orientCameraForView(camera, eye, center);
    }

    const framing = computeTightFraming(this.parts, eye, center, camera.up, ScreenshotShapeFraming.lensOf(camera), size, this.margin);
    if (!framing) {
      camera.updateProjectionMatrix();
      return false;
    }

    if ((camera as OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as OrthographicCamera;
      ortho.position.copy(framing.target).addScaledVector(direction, standoff);
      ortho.lookAt(framing.target);
      ortho.zoom = framing.zoom;
    } else {
      const persp = camera as PerspectiveCamera;
      persp.position.copy(framing.target).addScaledVector(direction, framing.distance);
      persp.lookAt(framing.target);
      // The live clip range is sized for the live distance; a close shot of a
      // small shape would land inside its near plane. Callers restore both.
      persp.near = Math.min(persp.near, framing.distance / 1000);
      persp.far = Math.max(persp.far, framing.distance + diameter * this.margin);
    }
    camera.updateProjectionMatrix();
    return true;
  }

  /** The unit direction from the shapes to the eye that `view` asks for, or null when it has none. */
  private static directionFor(
    camera: OrthographicCamera | PerspectiveCamera,
    view: ScreenshotView,
    center: Vector3,
    diameter: number,
    current: { eye: Vector3; target: Vector3 },
  ): Vector3 | null {
    let direction: Vector3;
    if (view.kind === 'current') {
      direction = camera.getWorldDirection(new Vector3()).negate();
    } else {
      const resolved = resolveView(view, center, diameter, current.eye, current.target);
      if (!resolved) {
        return null;
      }
      direction = resolved.eye.clone().sub(resolved.target);
    }
    if (direction.lengthSq() < 1e-18) {
      return null;
    }
    return direction.normalize();
  }

  private static lensOf(camera: OrthographicCamera | PerspectiveCamera): FitLens {
    if ((camera as OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as OrthographicCamera;
      return { kind: 'orthographic', frustumHeight: ortho.top - ortho.bottom };
    }
    return { kind: 'perspective', fovDeg: (camera as PerspectiveCamera).fov };
  }
}
