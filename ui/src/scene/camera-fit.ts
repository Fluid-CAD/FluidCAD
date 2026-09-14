import { Box3, MathUtils, Matrix4, Vector3 } from 'three';

/**
 * How a fit frames the scene.
 *
 * `sphere` frames the sphere around it. The framing is then the same from
 * every angle, so orbiting after a fit never changes how much of the frame
 * the model takes and a re-fit mid-orbit never jumps. It pays for that in
 * space: a sphere drawn around a long model is mostly empty, and it is fitted
 * to the *shorter* side of the viewport, so a crankshaft in a 2:1 frame ends
 * up a third of the size it could be. That is the right trade while someone
 * is working in the scene and the wrong one for a viewport whose whole job is
 * to show the model.
 *
 * `tight` frames what the model actually covers on screen, in the viewport's
 * own aspect ratio: the long model fills the wide frame.
 */
export type FitMode = 'sphere' | 'tight';

/** Framing options shared by every fit call. */
export type FitOptions = {
  /** Defaults to `sphere` — see {@link FitMode}. */
  mode?: FitMode;
  /**
   * Breathing room as a multiple of the framed extent: 1 puts the model flush
   * against the frame edge, 1.1 leaves a tenth of it as margin. Defaults to
   * {@link FIT_PADDING}.
   */
  padding?: number;
  /**
   * The pieces the subject is made of, each in world space. A `tight` fit
   * frames the space they cover between them rather than the single box
   * around them all, which matters as soon as a model is not box-shaped: the
   * corners of an engine's bounding box — above the bare end of the crank,
   * below the pistons — hold no geometry at all, and framing them pushes the
   * model off centre and shrinks it to make room for nothing. Defaults to the
   * one box the fit was given.
   */
  parts?: readonly Box3[];
};

/** The canvas a fit is computed against, in CSS pixels. */
export type FitViewport = {
  width: number;
  height: number;
  /**
   * The projection-window shift in pixels (see `SceneContext.setViewShift`).
   * The model slides that far off centre, so the room a fit may use shrinks
   * by the same amount on the side it slides towards — otherwise a shifted
   * model is framed to fill a canvas half of it has been pushed out of.
   */
  shiftX?: number;
  shiftY?: number;
};

/** The lens the fit is solved for. */
export type FitLens =
  /** `frustumHeight` is `top - bottom` at zoom 1 — the ortho window's height. */
  | { kind: 'orthographic'; frustumHeight: number }
  /** Vertical field of view, in degrees. */
  | { kind: 'perspective'; fovDeg: number };

/** Where a fit puts the camera. */
export type Framing = {
  /** What the camera looks at: the middle of what the model covers on screen. */
  target: Vector3;
  /** Eye distance from the target. Solved for a perspective lens, carried through unchanged for an orthographic one. */
  distance: number;
  /** Camera zoom. Solved for an orthographic lens, 1 for a perspective one. */
  zoom: number;
};

/** The camera's axes in world space, three.js `lookAt` convention. */
export type ViewBasis = {
  /** Screen +x. */
  right: Vector3;
  /** Screen +y. */
  up: Vector3;
  /** Out of the screen, towards the eye. */
  back: Vector3;
};

/** How much of the camera's axes the model takes up, and where its middle is. */
export type ViewSpan = {
  /** Half the extent along right, up and back. */
  half: Vector3;
  /** The world point that projects to the middle of the span. */
  centre: Vector3;
};

/** A camera eye that has fallen onto its own target has no direction to read. */
const DEGENERATE = 1e-12;

/**
 * The camera's world axes for an eye/target pair. `Matrix4.lookAt` is the
 * same construction camera-controls drives the camera with (`camera.lookAt`
 * against `camera.up`), including its handling of a view direction parallel
 * to up, so the basis here is the one the next frame will actually render
 * with rather than an approximation of it.
 */
export function viewBasis(eye: Vector3, target: Vector3, up: Vector3): ViewBasis {
  const basis = { right: new Vector3(), up: new Vector3(), back: new Vector3() };
  new Matrix4().lookAt(eye, target, up).extractBasis(basis.right, basis.up, basis.back);
  return basis;
}

/**
 * What `parts` cover along the camera's axes, and the world point in the
 * middle of it.
 *
 * A box's corners are its centre plus every sign combination of its half
 * size, and projection onto an axis is linear, so one box's span along an
 * axis is symmetric about its centre and reaches the sum of the half size's
 * components against the absolute axis. Several boxes' spans are not
 * symmetric about anything in particular, which is the point: the middle of
 * what an engine covers on screen is not the middle of the box around it, and
 * a camera aimed at the latter leaves the model visibly off centre.
 *
 * Returns null when there is nothing with any extent to measure.
 */
export function viewSpanOf(parts: readonly Box3[], basis: ViewBasis): ViewSpan | null {
  const axes = [basis.right, basis.up, basis.back];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const centre = new Vector3();
  const half = new Vector3();
  for (const part of parts) {
    if (part.isEmpty()) {
      continue;
    }
    part.getCenter(centre);
    part.getSize(half).multiplyScalar(0.5);
    for (let i = 0; i < 3; i++) {
      const axis = axes[i];
      const middle = centre.dot(axis);
      const reach = half.x * Math.abs(axis.x) + half.y * Math.abs(axis.y) + half.z * Math.abs(axis.z);
      min[i] = Math.min(min[i], middle - reach);
      max[i] = Math.max(max[i], middle + reach);
    }
  }
  if (!Number.isFinite(min[0])) {
    return null;
  }
  // The basis is orthonormal and rooted at the world origin, so a point
  // rebuilt from per-axis coordinates projects back to exactly those.
  const world = new Vector3();
  for (let i = 0; i < 3; i++) {
    world.addScaledVector(axes[i], (min[i] + max[i]) / 2);
  }
  return {
    half: new Vector3((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2),
    centre: world,
  };
}

/**
 * Half the canvas the model may use, in pixels. A view shift pushes the model
 * off centre, and it has to stay inside the canvas on the side it is pushed
 * towards, so the usable half-extent is the shorter one.
 */
function usableHalfCanvas(viewport: FitViewport): { x: number; y: number } | null {
  const x = viewport.width / 2 - Math.abs(viewport.shiftX ?? 0);
  const y = viewport.height / 2 - Math.abs(viewport.shiftY ?? 0);
  // A shift wider than the canvas, or a canvas measured while it was display:
  // none. There is no framing to compute either way.
  return x > 0 && y > 0 ? { x, y } : null;
}

/**
 * Frame `parts` as they project from the current angle — the `tight` fit.
 *
 * Returns null when there is nothing to solve: no part with any extent, a
 * canvas with no area, an eye sitting on its target.
 */
export function computeTightFraming(
  parts: readonly Box3[],
  eye: Vector3,
  target: Vector3,
  up: Vector3,
  lens: FitLens,
  viewport: FitViewport,
  padding: number,
): Framing | null {
  if (eye.distanceToSquared(target) < DEGENERATE) {
    return null;
  }
  const canvas = usableHalfCanvas(viewport);
  if (!canvas) {
    return null;
  }
  const basis = viewBasis(eye, target, up);
  const span = viewSpanOf(parts, basis);
  if (!span || (span.half.x <= 0 && span.half.y <= 0)) {
    return null;
  }
  const safePadding = padding > 0 ? padding : 1;

  if (lens.kind === 'orthographic') {
    // World units per pixel: the zoom that makes the model touch the frame on
    // whichever axis runs out first. The ortho window's height is fixed and
    // its width follows the canvas aspect, so either axis gives the same
    // units-per-pixel and the height is the simpler one to invert.
    const unitsPerPixel = Math.max(
      (span.half.x * safePadding) / canvas.x,
      (span.half.y * safePadding) / canvas.y,
    );
    if (unitsPerPixel <= 0) {
      return null;
    }
    return {
      target: span.centre,
      distance: eye.distanceTo(target),
      zoom: lens.frustumHeight / (unitsPerPixel * viewport.height),
    };
  }

  // Perspective. The near corners project larger than the middle, so a
  // distance solved from the span's width and height alone cuts them off.
  // Solve it corner by corner instead: a corner at camera-space (x, y, z)
  // sits `distance - z` in front of an eye `distance` from the middle, and
  // stays inside the frustum while |x| ≤ (distance - z)·tanX and |y| ≤ the
  // same against tanY. The fit is the deepest requirement any corner makes —
  // taking the widest corner and the nearest corner separately would be a
  // different, looser answer, because they are rarely the same one.
  const tanV = Math.tan(MathUtils.DEG2RAD * lens.fovDeg * 0.5);
  const tanY = (tanV * 2 * canvas.y) / viewport.height;
  const tanX = (tanV * 2 * canvas.x) / viewport.height;
  if (!(tanX > 0) || !(tanY > 0)) {
    return null;
  }
  let distance = 0;
  const offset = new Vector3();
  for (const part of parts) {
    if (part.isEmpty()) {
      continue;
    }
    for (const corner of boxCorners(part)) {
      offset.subVectors(corner, span.centre);
      const x = Math.abs(offset.dot(basis.right)) * safePadding;
      const y = Math.abs(offset.dot(basis.up)) * safePadding;
      const z = offset.dot(basis.back);
      distance = Math.max(distance, z + x / tanX, z + y / tanY);
    }
  }
  if (!Number.isFinite(distance) || distance <= 0) {
    return null;
  }
  return { target: span.centre, distance, zoom: 1 };
}

/** The box's eight corners. */
function boxCorners(box: Box3): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        corners.push(new Vector3(x, y, z));
      }
    }
  }
  return corners;
}
