import {
  Camera,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

const _sizeTmp = new Vector2();

function getViewportHeightPx(renderer: WebGLRenderer): number {
  renderer.getSize(_sizeTmp);
  const h = _sizeTmp.y;
  if (h > 0) {
    return h;
  }
  return renderer.domElement.clientHeight || 1;
}

function viewHeightWorldAt(camera: Camera, position: Vector3): number {
  if (camera instanceof OrthographicCamera) {
    return (camera.top - camera.bottom) / camera.zoom;
  }
  if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = (camera.fov * Math.PI) / 180;
    return 2 * dist * Math.tan(vFov / 2);
  }
  return 1;
}

export function pixelsToWorld(
  renderer: WebGLRenderer,
  camera: Camera,
  position: Vector3,
  targetPixels: number,
): number {
  const viewHeightPx = getViewportHeightPx(renderer);
  const viewHeightWorld = viewHeightWorldAt(camera, position);
  return (targetPixels / viewHeightPx) * viewHeightWorld;
}

export function pixelScale(
  renderer: WebGLRenderer,
  camera: Camera,
  position: Vector3,
  targetPixels: number,
  geometryUnits: number,
): number {
  const worldSize = pixelsToWorld(renderer, camera, position, targetPixels);
  const raw = worldSize / geometryUnits;
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1e-4;
  }
  return Math.min(Math.max(raw, 1e-4), 1e6);
}

export function applyConstantPixelSize(
  mesh: Object3D,
  group: Object3D,
  position: Vector3,
  targetPixels: number,
  geometryUnits: number,
): void {
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    group.scale.setScalar(pixelScale(renderer, camera, position, targetPixels, geometryUnits));
    group.updateMatrixWorld(true);
  };
}
