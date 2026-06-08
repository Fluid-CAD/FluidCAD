import { Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, Vec3Data } from '../types';

export function projectToSketch(
  ctx: SceneContext,
  plane: PlaneData,
  clientX: number,
  clientY: number,
): [number, number] | null {
  const renderer = ctx.renderer;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

  const raycaster = ctx.createPickingRaycaster(ndcX, ndcY);

  const rayOrigin = raycaster.ray.origin;
  const rayDir = raycaster.ray.direction;

  const planeOrigin = vec3(plane.origin);
  const planeNormal = vec3(plane.normal);

  const denom = rayDir.dot(planeNormal);
  if (Math.abs(denom) < 1e-6) {
    return null;
  }

  const t = planeOrigin.clone().sub(rayOrigin).dot(planeNormal) / denom;
  if (t < 0) {
    return null;
  }

  const worldPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));

  const rel = worldPoint.clone().sub(planeOrigin);
  const xDir = vec3(plane.xDirection);
  const yDir = vec3(plane.yDirection);

  return [rel.dot(xDir), rel.dot(yDir)];
}

export function localToWorld(point2d: [number, number], plane: PlaneData): Vector3 {
  const o = plane.origin;
  const x = plane.xDirection;
  const y = plane.yDirection;
  return new Vector3(
    o.x + x.x * point2d[0] + y.x * point2d[1],
    o.y + x.y * point2d[0] + y.y * point2d[1],
    o.z + x.z * point2d[0] + y.z * point2d[1],
  );
}

// Inverse of projectToSketch: maps a sketch-plane 2D point back to client
// pixel coordinates (relative to the viewport, including the canvas offset).
export function sketchToClient(
  ctx: SceneContext,
  plane: PlaneData,
  point2d: [number, number],
): { clientX: number; clientY: number } {
  const ndc = localToWorld(point2d, plane).project(ctx.camera);
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  return {
    clientX: ((ndc.x + 1) / 2) * rect.width + rect.left,
    clientY: ((1 - ndc.y) / 2) * rect.height + rect.top,
  };
}

export function worldToSketch2D(worldPoint: Vec3Data, plane: PlaneData): [number, number] {
  const rel = new Vector3(
    worldPoint.x - plane.origin.x,
    worldPoint.y - plane.origin.y,
    worldPoint.z - plane.origin.z,
  );
  const xDir = vec3(plane.xDirection);
  const yDir = vec3(plane.yDirection);
  return [rel.dot(xDir), rel.dot(yDir)];
}

export function roundPoint(p: [number, number]): [number, number] {
  return [
    Math.round(p[0] * 100) / 100,
    Math.round(p[1] * 100) / 100,
  ];
}

export function pixelToSketchThreshold(ctx: SceneContext, pxThreshold: number): number {
  const camera = ctx.camera;
  const rect = ctx.renderer.domElement.getBoundingClientRect();
  const canvasHeight = rect.height || 1;

  let worldHeight: number;
  const cam = camera as any;
  if (cam.isOrthographicCamera) {
    worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
  } else {
    const target = new Vector3();
    ctx.cameraControls.getTarget(target);
    const d = camera.position.distanceTo(target);
    const fovRad = (cam.fov * Math.PI) / 180;
    worldHeight = 2 * d * Math.tan(fovRad / 2);
  }

  return (worldHeight / canvasHeight) * pxThreshold;
}

export function dist2D(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function vec3(v: Vec3Data): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}
