import { Box3, MathUtils, Object3D, Vector3 } from 'three';

// View types — mirrored from server/src/ws-protocol.ts. We don't import from
// that file because the UI is built with its own tsconfig and shouldn't pull
// in the server's compilation graph; structural compatibility is enough since
// these only flow over JSON.
export type NamedView =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso-ftr'
  | 'iso-fbr'
  | 'iso-ftl'
  | 'iso-fbl'
  | 'iso-btr'
  | 'iso-bbr'
  | 'iso-btl'
  | 'iso-bbl';

export type ScreenshotView =
  | { kind: 'current' }
  | { kind: 'named'; name: NamedView }
  | { kind: 'orbit-from-current'; azimuthDeg: number; elevationDeg: number }
  | { kind: 'look-from'; eye: [number, number, number]; target?: [number, number, number] };

/**
 * Unit eye-direction vectors for each named view.
 *
 * Convention (Z-up, looking at origin):
 *   +Y is "back", -Y is "front"
 *   +X is "right", -X is "left"
 *   +Z is "top",  -Z is "bottom"
 * The eye direction is the unit vector FROM the scene center TO the camera —
 * so "front" places the camera on the -Y side, looking back along +Y.
 */
export const NAMED_VIEW_DIRECTIONS: Record<NamedView, Vector3> = {
  front: new Vector3(0, -1, 0),
  back: new Vector3(0, 1, 0),
  left: new Vector3(-1, 0, 0),
  right: new Vector3(1, 0, 0),
  top: new Vector3(0, 0, 1),
  bottom: new Vector3(0, 0, -1),
  'iso-ftr': new Vector3(1, -1, 1).normalize(),
  'iso-fbr': new Vector3(1, -1, -1).normalize(),
  'iso-ftl': new Vector3(-1, -1, 1).normalize(),
  'iso-fbl': new Vector3(-1, -1, -1).normalize(),
  'iso-btr': new Vector3(1, 1, 1).normalize(),
  'iso-bbr': new Vector3(1, 1, -1).normalize(),
  'iso-btl': new Vector3(-1, 1, 1).normalize(),
  'iso-bbl': new Vector3(-1, 1, -1).normalize(),
};

export type EyeTarget = {
  eye: Vector3;
  target: Vector3;
};

/**
 * For a named view, place the camera at `center + dir * distance` looking at
 * `center`. `distance` should be derived from scene bounds so the model fits.
 */
export function eyeTargetForNamedView(
  name: NamedView,
  center: Vector3,
  distance: number,
): EyeTarget {
  const dir = NAMED_VIEW_DIRECTIONS[name];
  const safeDistance = Math.max(distance, 1);
  return {
    eye: center.clone().add(dir.clone().multiplyScalar(safeDistance)),
    target: center.clone(),
  };
}

/**
 * Orbit the current eye around the current target by spherical deltas, keeping
 * the eye→target distance fixed. Z is up, so we use the camera-controls
 * convention where polar (phi) measures the angle from +Z.
 */
export function eyeTargetForOrbit(
  currentEye: Vector3,
  currentTarget: Vector3,
  azimuthDeg: number,
  elevationDeg: number,
): EyeTarget {
  // Z-up spherical math: phi is the angle from +Z, theta is the XY azimuth.
  const offset = currentEye.clone().sub(currentTarget);
  const r = offset.length();
  let phi = Math.acos(MathUtils.clamp(offset.z / Math.max(r, 1e-9), -1, 1));
  let theta = Math.atan2(offset.y, offset.x);

  theta += azimuthDeg * MathUtils.DEG2RAD;
  phi = MathUtils.clamp(phi - elevationDeg * MathUtils.DEG2RAD, 1e-3, Math.PI - 1e-3);

  const sinPhi = Math.sin(phi);
  const newOffset = new Vector3(
    r * sinPhi * Math.cos(theta),
    r * sinPhi * Math.sin(theta),
    r * Math.cos(phi),
  );

  return {
    eye: currentTarget.clone().add(newOffset),
    target: currentTarget.clone(),
  };
}

/**
 * Resolve a `ScreenshotView` to an `eye`/`target` pair plus a hint distance
 * (the bounding-sphere diameter used for fitting). Returns `null` for
 * `kind: 'current'` — caller should leave the camera untouched.
 */
export function resolveView(
  view: ScreenshotView,
  sceneCenter: Vector3,
  sceneDiameter: number,
  currentEye: Vector3,
  currentTarget: Vector3,
): EyeTarget | null {
  switch (view.kind) {
    case 'current':
      return null;
    case 'named':
      return eyeTargetForNamedView(view.name, sceneCenter, sceneDiameter);
    case 'orbit-from-current':
      return eyeTargetForOrbit(currentEye, currentTarget, view.azimuthDeg, view.elevationDeg);
    case 'look-from': {
      const eye = new Vector3(view.eye[0], view.eye[1], view.eye[2]);
      const target = view.target
        ? new Vector3(view.target[0], view.target[1], view.target[2])
        : sceneCenter.clone();
      return { eye, target };
    }
  }
}

/**
 * Compute the bounds of every visible mesh/line/points object in the scene,
 * skipping construction planes (which extend far beyond the model). Mirrors
 * `expandBounds` in screenshot.ts.
 */
export function computeSceneBounds(root: Object3D): Box3 {
  const box = new Box3();
  expandBounds(box, root);
  return box;
}

function expandBounds(box: Box3, object: Object3D): void {
  if (object.userData.isConstructionPlane) {
    return;
  }
  if (!object.visible) {
    return;
  }
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
