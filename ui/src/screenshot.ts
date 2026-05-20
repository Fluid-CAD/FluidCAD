import {
  ACESFilmicToneMapping,
  Box3,
  Object3D,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { FIT_PADDING, SceneContext } from './scene/scene-context';
import { computeSceneBounds, resolveView, type ScreenshotView } from './screenshot-view';

export interface ScreenshotOptions {
  width: number;
  height: number;
  showGrid: boolean;
  showAxes: boolean;
  transparent: boolean;
  autoCrop: boolean;
  /** Fit camera to the model without cropping the canvas. */
  fitToModel: boolean;
  margin: number;
  view: ScreenshotView;
}

const DEFAULTS: ScreenshotOptions = {
  width: 800,
  height: 800,
  showGrid: false,
  showAxes: false,
  transparent: false,
  autoCrop: false,
  fitToModel: false,
  margin: 0,
  view: { kind: 'current' },
};

/** Render the current scene to a PNG blob with the given options. */
export function captureScreenshot(sceneCtx: SceneContext, opts: Partial<ScreenshotOptions> = {}): Promise<Blob> {
  const options = { ...DEFAULTS, ...opts };
  const canvas = renderToCanvas(sceneCtx, options);
  return canvasToPng(canvas);
}

/**
 * Render four sub-images (front, top, right, iso-ftr) into a single 2×2
 * composite PNG. `width`/`height` is the *total* output size; each tile is
 * rendered at half that.
 */
export function captureScreenshotMulti(
  sceneCtx: SceneContext,
  opts: Partial<ScreenshotOptions> = {},
): Promise<Blob> {
  const merged: ScreenshotOptions = { ...DEFAULTS, ...opts };
  const tileW = Math.max(1, Math.floor(merged.width / 2));
  const tileH = Math.max(1, Math.floor(merged.height / 2));

  const tiles: Array<{ x: number; y: number; view: ScreenshotView }> = [
    { x: 0,     y: 0,     view: { kind: 'named', name: 'front' } },
    { x: tileW, y: 0,     view: { kind: 'named', name: 'top' } },
    { x: 0,     y: tileH, view: { kind: 'named', name: 'right' } },
    { x: tileW, y: tileH, view: { kind: 'named', name: 'iso-ftr' } },
  ];

  const composite = document.createElement('canvas');
  composite.width = tileW * 2;
  composite.height = tileH * 2;
  const ctx2d = composite.getContext('2d');
  if (!ctx2d) {
    return Promise.reject(new Error('Failed to get composite 2d context.'));
  }
  if (!merged.transparent) {
    ctx2d.fillStyle = '#ffffff';
    ctx2d.fillRect(0, 0, composite.width, composite.height);
  }

  for (const tile of tiles) {
    const tileCanvas = renderToCanvas(sceneCtx, {
      ...merged,
      width: tileW,
      height: tileH,
      view: tile.view,
      // Disable autoCrop per-tile so tiles align on the grid.
      autoCrop: false,
      fitToModel: true,
    });
    ctx2d.drawImage(tileCanvas, tile.x, tile.y);
  }

  return canvasToPng(composite);
}

/**
 * The core render-with-save/restore routine. Returns the final canvas (either
 * the raw renderer canvas, or an auto-cropped copy).
 */
function renderToCanvas(sceneCtx: SceneContext, options: ScreenshotOptions): HTMLCanvasElement {
  const { width, height, showGrid, showAxes, transparent, autoCrop, fitToModel, margin, view } = options;

  const scene = sceneCtx.scene;
  const camera = sceneCtx.camera;
  const cc = sceneCtx.cameraControls;

  // --- Save state ---
  const gridObj = scene.getObjectByName('grid');
  const defaultAxes = scene.getObjectByName('defaultAxesHelper');
  const sketchAxes = scene.getObjectByName('sketchAxesHelper');

  const savedGrid = gridObj?.visible;
  const savedDefaultAxes = defaultAxes?.visible;
  const savedSketchAxes = sketchAxes?.visible;
  const savedBackground = scene.background;

  const savedCamPos = new Vector3();
  const savedCamTarget = new Vector3();
  cc.getPosition(savedCamPos);
  cc.getTarget(savedCamTarget);
  const savedZoom = camera.zoom;

  // --- Apply export settings ---
  if (gridObj) { gridObj.visible = showGrid; }
  if (defaultAxes) { defaultAxes.visible = showAxes; }
  if (sketchAxes) { sketchAxes.visible = showAxes; }
  if (transparent) { scene.background = null; }

  // Adjust camera projection for export aspect ratio BEFORE applying a view,
  // so view fitting computes zoom against the correct frustum dimensions.
  const exportAspect = width / height;
  const cam = camera as any;
  let savedCameraState: any;
  if (cam.isOrthographicCamera) {
    savedCameraState = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom };
    const currentHeight = cam.top - cam.bottom;
    cam.left = -exportAspect * currentHeight / 2;
    cam.right = exportAspect * currentHeight / 2;
    cam.updateProjectionMatrix();
  } else {
    savedCameraState = { aspect: cam.aspect };
    cam.aspect = exportAspect;
    cam.updateProjectionMatrix();
  }

  // --- Apply requested view (if any) ---
  // Stateless: we mutate the camera directly and restore it below. The user's
  // CameraControls are never moved, so the interactive view is preserved.
  const resolved = resolveSceneViewport(sceneCtx);
  if (view.kind !== 'current') {
    const target = resolveView(view, resolved.center, resolved.diameter, savedCamPos, savedCamTarget);
    if (target) {
      camera.position.copy(target.eye);
      camera.lookAt(target.target);

      if (cam.isOrthographicCamera && resolved.diameter > 0) {
        const frustumW = cam.right - cam.left;
        const frustumH = cam.top - cam.bottom;
        cam.zoom = Math.min(frustumW / resolved.diameter, frustumH / resolved.diameter);
      } else if (cam.isPerspectiveCamera && resolved.diameter > 0) {
        // Place the camera at a distance that frames the bounding sphere.
        const halfFovV = (cam.fov * Math.PI) / 360;
        const halfFovH = Math.atan(Math.tan(halfFovV) * cam.aspect);
        const halfFov = Math.min(halfFovV, halfFovH);
        const distance = (resolved.diameter / 2) / Math.sin(halfFov);
        const dir = camera.position.clone().sub(target.target).normalize();
        camera.position.copy(target.target).add(dir.multiplyScalar(distance));
        camera.lookAt(target.target);
      }
      cam.updateProjectionMatrix();
    }
  } else if (autoCrop || fitToModel) {
    // Original behavior: keep the user's viewing direction, just refit.
    const compiled = scene.getObjectByName('compiledMesh');
    if (compiled) {
      const box = new Box3();
      expandBounds(box, compiled);
      if (!box.isEmpty()) {
        const center = box.getCenter(new Vector3());
        const diameter = box.getSize(new Vector3()).length() * FIT_PADDING;

        if (diameter > 0) {
          const dir = new Vector3();
          camera.getWorldDirection(dir);
          camera.position.copy(center).sub(dir.clone().multiplyScalar(1000));
          camera.lookAt(center);

          if (cam.isOrthographicCamera) {
            const frustumW = cam.right - cam.left;
            const frustumH = cam.top - cam.bottom;
            cam.zoom = Math.min(frustumW / diameter, frustumH / diameter);
          }
          cam.updateProjectionMatrix();
        }
      }
    }
  }

  // --- Render to off-screen canvas ---
  const tmpRenderer = new WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  tmpRenderer.setSize(width, height);
  tmpRenderer.setPixelRatio(1);
  tmpRenderer.toneMapping = ACESFilmicToneMapping;
  tmpRenderer.outputColorSpace = SRGBColorSpace;

  const dir = new Vector3();
  camera.getWorldDirection(dir);
  scene.traverse((obj) => {
    if ((obj as any).isDirectionalLight) {
      obj.position.copy(dir.clone().multiplyScalar(-10));
    }
  });

  tmpRenderer.render(scene, camera);

  // --- Optional auto-crop ---
  let exportCanvas: HTMLCanvasElement = tmpRenderer.domElement;

  if (autoCrop) {
    const cropRect = computeCropRect(sceneCtx, width, height, margin);
    if (cropRect) {
      const cropped = document.createElement('canvas');
      cropped.width = cropRect.w;
      cropped.height = cropRect.h;
      const ctx2d = cropped.getContext('2d')!;
      ctx2d.drawImage(tmpRenderer.domElement, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
      exportCanvas = cropped;
    }
  }

  // Detach exportCanvas before disposing the renderer, so callers can still
  // read its pixels (drawImage is synchronous, so this is fine for the
  // composite path too).
  const finalCanvas = detachCanvas(exportCanvas, width, height);

  // --- Restore state ---
  if (gridObj) { gridObj.visible = savedGrid!; }
  if (defaultAxes) { defaultAxes.visible = savedDefaultAxes!; }
  if (sketchAxes) { sketchAxes.visible = savedSketchAxes!; }
  scene.background = savedBackground;

  if (cam.isOrthographicCamera) {
    cam.left = savedCameraState.left;
    cam.right = savedCameraState.right;
    cam.top = savedCameraState.top;
    cam.bottom = savedCameraState.bottom;
  } else {
    cam.aspect = savedCameraState.aspect;
  }
  camera.zoom = savedZoom;
  camera.position.copy(savedCamPos);
  camera.lookAt(savedCamTarget);
  cam.updateProjectionMatrix();

  // Resync camera-controls to the restored camera state
  cc.setLookAt(
    savedCamPos.x, savedCamPos.y, savedCamPos.z,
    savedCamTarget.x, savedCamTarget.y, savedCamTarget.z,
    false,
  );

  tmpRenderer.dispose();
  sceneCtx.requestRender();

  return finalCanvas;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create PNG blob.'));
      }
    }, 'image/png');
  });
}

/**
 * Copy a canvas to a fresh one we own — the WebGLRenderer's canvas is disposed
 * with the renderer, so we need to detach the pixels before that happens.
 */
function detachCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width || w;
  out.height = src.height || h;
  const ctx = out.getContext('2d');
  if (!ctx) {
    return src;
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

function resolveSceneViewport(sceneCtx: SceneContext): { center: Vector3; diameter: number } {
  const compiled = sceneCtx.scene.getObjectByName('compiledMesh');
  const root: Object3D = compiled ?? sceneCtx.scene;
  const box = computeSceneBounds(root);
  if (box.isEmpty()) {
    return { center: new Vector3(), diameter: 100 };
  }
  const center = box.getCenter(new Vector3());
  const diameter = box.getSize(new Vector3()).length() * FIT_PADDING;
  return { center, diameter };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCropRect(
  sceneCtx: SceneContext,
  canvasW: number,
  canvasH: number,
  margin: number,
): { x: number; y: number; w: number; h: number } | null {
  const compiled = sceneCtx.scene.getObjectByName('compiledMesh');
  if (!compiled) { return null; }

  const box = new Box3();
  expandBounds(box, compiled);
  if (box.isEmpty()) { return null; }

  const camera = sceneCtx.camera;
  const corners = [
    new Vector3(box.min.x, box.min.y, box.min.z),
    new Vector3(box.max.x, box.min.y, box.min.z),
    new Vector3(box.min.x, box.max.y, box.min.z),
    new Vector3(box.max.x, box.max.y, box.min.z),
    new Vector3(box.min.x, box.min.y, box.max.z),
    new Vector3(box.max.x, box.min.y, box.max.z),
    new Vector3(box.min.x, box.max.y, box.max.z),
    new Vector3(box.max.x, box.max.y, box.max.z),
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const c of corners) {
    c.project(camera);
    const px = (c.x + 1) / 2 * canvasW;
    const py = (1 - c.y) / 2 * canvasH;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }

  const x = Math.max(0, Math.floor(minX - margin));
  const y = Math.max(0, Math.floor(minY - margin));
  const x2 = Math.min(canvasW, Math.ceil(maxX + margin));
  const y2 = Math.min(canvasH, Math.ceil(maxY + margin));
  const w = x2 - x;
  const h = y2 - y;

  if (w <= 0 || h <= 0) { return null; }
  return { x, y, w, h };
}

/** Recursively expand a Box3 to include all visible geometry.
 *  Unlike the viewer's expandBoxExcludingMeta, this includes guide/construction
 *  edges so that screenshots frame everything the user can see. Construction
 *  planes are still skipped because their geometry extends far beyond the model. */
function expandBounds(box: Box3, object: Object3D): void {
  if (object.userData.isConstructionPlane) { return; }
  if (!object.visible) { return; }
  const o = object as any;
  if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) {
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  }
  for (const child of object.children) {
    expandBounds(box, child);
  }
}

