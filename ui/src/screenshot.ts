import {
  ACESFilmicToneMapping,
  Box3,
  Object3D,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { SceneContext } from './scene/scene-context';

export interface ScreenshotOptions {
  width: number;
  height: number;
  showGrid: boolean;
  showAxes: boolean;
  transparent: boolean;
  autoCrop: boolean;
  margin: number;
}

const DEFAULTS: ScreenshotOptions = {
  width: 800,
  height: 800,
  showGrid: false,
  showAxes: false,
  transparent: false,
  autoCrop: false,
  margin: 0,
};

/** Render the current scene to a PNG blob with the given options. */
export function captureScreenshot(sceneCtx: SceneContext, opts: Partial<ScreenshotOptions> = {}): Promise<Blob> {
  const options = { ...DEFAULTS, ...opts };
  const { width, height, showGrid, showAxes, transparent, autoCrop, margin } = options;

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

  // Auto-fit the model into view before rendering
  if (autoCrop) {
    const compiled = scene.getObjectByName('compiledMesh');
    if (compiled) {
      const box = new Box3();
      expandBounds(box, compiled);
      if (!box.isEmpty()) {
        sceneCtx.fitToBox(box, false);
        cc.update(0);
      }
    }
  }

  // Adjust camera projection for export aspect ratio
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
  cam.updateProjectionMatrix();

  cc.setLookAt(
    savedCamPos.x, savedCamPos.y, savedCamPos.z,
    savedCamTarget.x, savedCamTarget.y, savedCamTarget.z,
    false,
  );
  cc.update(0);

  tmpRenderer.dispose();
  sceneCtx.requestRender();

  // --- Extract PNG blob ---
  return new Promise<Blob>((resolve, reject) => {
    exportCanvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create PNG blob.'));
      }
    }, 'image/png');
  });
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

function expandBounds(box: Box3, object: Object3D): void {
  if (object.userData.isMetaShape) { return; }
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
