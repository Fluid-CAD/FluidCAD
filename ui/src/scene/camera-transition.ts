import type CameraControls from 'camera-controls';
import { Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Spherical, Vector3 } from 'three';

/**
 * A camera flight between two poses that changes the up vector on the way —
 * the sketch enter/exit swing, where the world up (Z) gives way to the
 * sketch plane's y direction and back.
 *
 * camera-controls cannot animate that on its own. Its transition tweens the
 * orbit angles (theta, phi) it keeps in the frame of the camera's up vector:
 * the start angles were recorded under the old up, the destination angles
 * are computed under the new one, and the tween runs between the two as if
 * they were the same frame. The camera starts from a pose it never had,
 * rolls the instant the up vector is swapped, and swings through the
 * angles' pole on the way — the "goes up before it turns" motion.
 *
 * This helper slerps the camera's whole orientation instead: one rotation
 * about a fixed axis from the pose actually on screen to the destination,
 * up vector included, so the view turns directly and the horizon rolls in
 * step with it. camera-controls stays the owner of everything else — the
 * target, the eye distance, the zoom — and damps those with the same
 * smoothing as the orientation, so a fit issued in the same tick as the
 * flight (a sketch render fits after entering) composes with it, and the
 * user's orbit takes over from wherever the flight is.
 *
 * Contract with camera-controls state during a flight: the flight owns the
 * orbit angles frame by frame (rotateTo without transition), so cc's
 * *current* and *end* rotation coincide at the interpolated pose; the end
 * target and distance stay the destination's throughout. At the moment
 * {@link flyTo} returns, cc's end state is the destination in full, which
 * is what a same-tick fit reads.
 */

/** What the flight needs from the scene: the camera it flies and the controls that render it. */
export interface CameraTransitionHost {
  readonly camera: OrthographicCamera | PerspectiveCamera;
  readonly cameraControls: CameraControls;
  /** Wake the render loop — the flight is stepped from it. */
  requestRender(): void;
  /** A gesture from the user ends the flight at its destination so their input starts from a settled pose. */
  subscribeUserCameraInput(fn: () => void): () => void;
}

/** Below this remaining fraction of the swing the flight snaps to its destination. */
const REST_FRACTION = 1e-3;

/** Two orientations closer than this (in |dot|) are the same pose — no flight, camera-controls' own tween carries the rest. */
const SAME_POSE_DOT = 1 - 1e-7;

const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * The world orientation of a camera looking from `eye` at `target` under
 * `up` — the same `lookAt` construction camera-controls drives the camera
 * with, including its orthonormalisation of an up that is not perpendicular
 * to the view, so the orientation is the one actually rendered rather than
 * the one the up vector nominally asks for.
 */
export function viewOrientation(eye: Vector3, target: Vector3, up: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(eye, target, up));
}

/**
 * camera-controls' orbit angles for the eye direction `back` (target → eye)
 * under `up`: its own construction (`updateCameraUp` + `setLookAt`), so the
 * angles put the camera exactly where `back` points.
 */
export function orbitAngles(back: Vector3, up: Vector3): { theta: number; phi: number } {
  const toYUp = new Quaternion().setFromUnitVectors(up, AXIS_Y);
  const spherical = new Spherical().setFromVector3(back.clone().applyQuaternion(toYUp));
  return { theta: spherical.theta, phi: spherical.phi };
}

/**
 * Critically damped spring towards `target` — the smoothing camera-controls
 * applies to its own tweens, reproduced so the orientation moves in lockstep
 * with the target and distance it is damping alongside.
 */
function smoothDamp(current: number, target: number, velocity: { value: number }, smoothTime: number, dt: number): number {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  // No overshoot past the target.
  if ((target - current > 0) === (out > target)) {
    out = target;
    velocity.value = 0;
  }
  return out;
}

type Flight = {
  from: Quaternion;
  to: Quaternion;
  /** The up vector the destination was asked for — restored exactly on arrival. */
  endUp: Vector3;
  /** Progress along the slerp, damped 0 → 1. */
  s: number;
  velocity: { value: number };
};

export class CameraTransition {
  private flight: Flight | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly host: CameraTransitionHost) {
    this.unsubscribe = host.subscribeUserCameraInput(() => this.finish());
  }

  /** Whether a flight is in progress. */
  get active(): boolean {
    return this.flight !== null;
  }

  /**
   * Fly to `position` looking at `target` with `up`. Returns with
   * camera-controls' end state at the destination; the orientation itself is
   * stepped by {@link update} from the render loop.
   */
  flyTo(position: Vector3, target: Vector3, up: Vector3): void {
    const cc = this.host.cameraControls;
    const endUp = up.clone().normalize();

    const eye = cc.getPosition(new Vector3(), false);
    const focus = cc.getTarget(new Vector3(), false);
    const from = viewOrientation(eye, focus, this.host.camera.up);
    const to = viewOrientation(position, target, endUp);

    // Re-express the pose on screen under the destination's up, then hand
    // camera-controls the destination: it damps target and distance from
    // here, and its end state is what a same-tick fit reads.
    this.setUp(endUp);
    cc.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true);
    cc.normalizeRotations();

    if (Math.abs(from.dot(to)) > SAME_POSE_DOT) {
      // Already facing that way: nothing to swing, camera-controls' own
      // tween moves target and distance in a frame that no longer changes.
      this.flight = null;
      this.host.requestRender();
      return;
    }

    this.flight = { from, to, endUp, s: 0, velocity: { value: 0 } };
    this.host.requestRender();
  }

  /**
   * Point the orbit's up vector at `up` without moving the view: the pose on
   * screen and any tween in progress are re-expressed under the new up, so
   * the next frame renders where the last one did.
   */
  setUp(up: Vector3): void {
    const cc = this.host.cameraControls;
    const eye = cc.getPosition(new Vector3(), false);
    const focus = cc.getTarget(new Vector3(), false);
    const eyeEnd = cc.getPosition(new Vector3(), true);
    const focusEnd = cc.getTarget(new Vector3(), true);

    this.host.camera.up.copy(up);
    cc.updateCameraUp();
    cc.setLookAt(eye.x, eye.y, eye.z, focus.x, focus.y, focus.z, false);
    cc.setLookAt(eyeEnd.x, eyeEnd.y, eyeEnd.z, focusEnd.x, focusEnd.y, focusEnd.z, true);
    cc.normalizeRotations();
    this.host.requestRender();
  }

  /**
   * Advance the flight by `delta` seconds. Called by the render loop before
   * camera-controls' own update, so the pose it renders is this frame's.
   */
  update(delta: number): void {
    const flight = this.flight;
    if (!flight || delta <= 0) {
      return;
    }
    flight.s = smoothDamp(flight.s, 1, flight.velocity, this.host.cameraControls.smoothTime, delta);
    if (1 - flight.s < REST_FRACTION) {
      this.finish();
      return;
    }
    this.apply(flight.from.clone().slerp(flight.to, flight.s), null);
  }

  /** Jump to the destination of the flight in progress, if any. */
  finish(): void {
    const flight = this.flight;
    if (!flight) {
      return;
    }
    this.flight = null;
    this.apply(flight.to, flight.endUp);
    this.host.requestRender();
  }

  /** Abandon the flight where it is — the pose on screen stays as rendered. */
  cancel(): void {
    this.flight = null;
  }

  dispose(): void {
    this.cancel();
    this.unsubscribe();
  }

  /**
   * Render orientation `q`: its own y axis as the camera up (perpendicular
   * to the view, so `lookAt` reproduces `q` exactly) unless the destination's
   * requested `up` is given — the orbit axis the user then orbits about.
   */
  private apply(q: Quaternion, up: Vector3 | null): void {
    const cc = this.host.cameraControls;
    const cameraUp = up ?? AXIS_Y.clone().applyQuaternion(q);
    const back = AXIS_Z.clone().applyQuaternion(q);
    this.host.camera.up.copy(cameraUp);
    cc.updateCameraUp();
    const { theta, phi } = orbitAngles(back, cameraUp);
    cc.rotateTo(theta, phi, false);
  }
}
