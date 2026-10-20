import { type Camera, type Intersection, type Material, type Object3D, type Raycaster, Vector3 } from 'three';

/** Mirrors Three's material clipping so clipped faces cannot occlude a pick. */
export function clippedByMaterial(point: Vector3, material: Material): boolean {
  const planes = material.clippingPlanes;
  if (!planes?.length) {
    return false;
  }
  const clipped = planes.map(plane => plane.distanceToPoint(point) < 0);
  return material.clipIntersection ? clipped.every(Boolean) : clipped.some(Boolean);
}

/** The material a raycast hit landed on: the group's own for a multi-material mesh. */
export function hitMaterial(hit: Intersection): Material | null {
  const material = (hit.object as Object3D & { material?: Material | Material[] }).material;
  if (!material) {
    return null;
  }
  return Array.isArray(material) ? material[hit.face?.materialIndex ?? 0] ?? null : material;
}

/**
 * True when `point` of the hit (its own point by default, the closest point
 * on a fat line for an edge hit) lies on the half a section view removed:
 * the raycaster ignores material clipping, so a hit there is on geometry the
 * screen does not show and must neither pick nor occlude.
 */
export function hitIsClipped(hit: Intersection, point: Vector3 = hit.point): boolean {
  const material = hitMaterial(hit);
  return material !== null && clippedByMaterial(point, material);
}

/** True when a section view clips the hit's material at all — its kept side is a cut-open view. */
export function hitIsSectioned(hit: Intersection): boolean {
  return (hitMaterial(hit)?.clippingPlanes?.length ?? 0) > 0;
}

/**
 * Visibility along the sight line through the point itself: an edge or axis
 * hit under the cursor. Vertex dots decide the same question on the GPU, for
 * all of them at once (see occluder-depth.ts).
 */
export function pointIsVisible(
  point: Vector3,
  occluders: Object3D[],
  tolerance: number,
  camera: Camera,
  createRaycaster: (x: number, y: number) => Raycaster,
): boolean {
  if (occluders.length === 0) {
    return true;
  }
  const ndc = point.clone().project(camera);
  const ray = createRaycaster(ndc.x, ndc.y);
  const pointDepth = ray.ray.direction.dot(point.clone().sub(ray.ray.origin));
  for (const hit of ray.intersectObjects(occluders, false)) {
    if (hitIsClipped(hit)) {
      continue;
    }
    return hit.distance >= pointDepth - tolerance;
  }
  return true;
}
