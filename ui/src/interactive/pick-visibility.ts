import { type Camera, type Material, type Object3D, type Raycaster, Vector3 } from 'three';

/** Mirrors Three's material clipping so clipped faces cannot occlude a pick. */
export function clippedByMaterial(point: Vector3, material: Material): boolean {
  const planes = material.clippingPlanes;
  if (!planes?.length) {
    return false;
  }
  const clipped = planes.map(plane => plane.distanceToPoint(point) < 0);
  return material.clipIntersection ? clipped.every(Boolean) : clipped.some(Boolean);
}

/** Visibility along the sight line through the point itself, shared by edges and vertices. */
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
    const material = (hit.object as Object3D & { material?: Material | Material[] }).material;
    const hitMaterial = Array.isArray(material) ? material[hit.face?.materialIndex ?? 0] : material;
    if (hitMaterial && clippedByMaterial(hit.point, hitMaterial)) {
      continue;
    }
    return hit.distance >= pointDepth - tolerance;
  }
  return true;
}
