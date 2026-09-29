// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OrthographicCamera, Quaternion, Vector3 } from 'three';
import CameraControls from 'camera-controls';
import { CameraTransition, orbitAngles, viewOrientation } from '../src/scene/camera-transition';

// The sketch enter/exit swing changes the camera's up vector on the way.
// camera-controls' own setLookAt transition cannot animate that: it tweens
// orbit angles recorded under the old up towards angles computed under the
// new one, so the camera starts from a pose it never had, rolls at once and
// swings past the pole. The flight here slerps the whole orientation and
// hands camera-controls the rest; everything below is checked on a real
// CameraControls instance, reading the camera pose it renders each frame.

CameraControls.install({ THREE });

const DT = 1 / 60;
const Z_UP = new Vector3(0, 0, 1);

/** The up axis and the eye direction the camera actually renders with. */
function rendered(camera: OrthographicCamera): { up: Vector3; back: Vector3 } {
  return {
    up: new Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
    back: new Vector3(0, 0, 1).applyQuaternion(camera.quaternion),
  };
}

function angleBetween(a: Vector3, b: Vector3): number {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b) / (a.length() * b.length()))));
}

type Harness = {
  camera: OrthographicCamera;
  cc: CameraControls;
  transition: CameraTransition;
  inputListeners: Set<() => void>;
  renders: number;
  /** Advance one frame the way SceneContext.tick does: flight first, then camera-controls. */
  frame(): void;
  /** Run frames until the flight settles (bounded). */
  settle(): number;
  /** Run frames until camera-controls' own damping of target and distance has rested as well. */
  rest(): void;
};

let harness: Harness;

beforeEach(() => {
  const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.up.copy(Z_UP);
  const cc = new CameraControls(camera, document.createElement('div'));
  cc.smoothTime = 0.1;
  const inputListeners = new Set<() => void>();
  const host = {
    camera,
    cameraControls: cc,
    requestRender: () => { harness.renders += 1; },
    subscribeUserCameraInput: (fn: () => void) => {
      inputListeners.add(fn);
      return () => inputListeners.delete(fn);
    },
  };
  const transition = new CameraTransition(host);
  // Start on the default iso view, world Z up.
  cc.setLookAt(100, -100, 80, 0, 0, 0, false);
  cc.updateCameraUp();
  cc.update(DT);
  harness = {
    camera, cc, transition, inputListeners, renders: 0,
    frame() {
      transition.update(DT);
      cc.update(DT);
    },
    settle() {
      let frames = 0;
      while (transition.active && frames < 600) {
        this.frame();
        frames += 1;
      }
      // One more so camera-controls renders the settled angles.
      this.frame();
      return frames;
    },
    rest() {
      for (let i = 0; i < 180; i++) {
        this.frame();
      }
    },
  };
});

afterEach(() => {
  harness.transition.dispose();
  harness.cc.dispose();
});

/** The sketch-entry destination: face the XY plane from +Z with the plane's y as up. */
const SKETCH = { position: new Vector3(0, 0, 250), target: new Vector3(0, 0, 0), up: new Vector3(0, 1, 0) };

describe('camera flight to a new up vector', () => {
  it('leaves camera-controls aimed at the destination the moment it starts (a same-tick fit reads it)', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    expect(harness.cc.getPosition(new Vector3()).distanceTo(SKETCH.position)).toBeLessThan(1e-6);
    expect(harness.cc.getTarget(new Vector3()).distanceTo(SKETCH.target)).toBeLessThan(1e-6);
    expect(harness.transition.active).toBe(true);
    expect(harness.renders).toBeGreaterThan(0);
  });

  it('starts from the pose on screen — no roll, no jump — and turns about one fixed axis', () => {
    const before = rendered(harness.camera);
    const startQ = harness.camera.quaternion.clone();
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    const endQ = viewOrientation(SKETCH.position, SKETCH.target, SKETCH.up);

    let previous = before;
    let previousToEnd = startQ.angleTo(endQ);
    let axis: Vector3 | null = null;
    let frames = 0;
    while (harness.transition.active && frames < 600) {
      harness.frame();
      frames += 1;
      const now = rendered(harness.camera);
      // Continuity: the first frame is a hair from the start pose, and every
      // frame turns by at most a few degrees — no instant swap of the up vector.
      expect(angleBetween(previous.up, now.up)).toBeLessThan(0.2);
      expect(angleBetween(previous.back, now.back)).toBeLessThan(0.2);
      // Monotone: always closer to the destination than the frame before.
      const toEnd = harness.camera.quaternion.angleTo(endQ);
      expect(toEnd).toBeLessThanOrEqual(previousToEnd + 1e-9);
      // One rotation: the turn from the start pose is about the same axis every frame.
      const relative = harness.camera.quaternion.clone().multiply(startQ.clone().invert());
      const turned = 2 * Math.acos(Math.min(1, Math.abs(relative.w)));
      if (turned > 0.05) {
        const thisAxis = new Vector3(relative.x, relative.y, relative.z).normalize();
        if (relative.w < 0) thisAxis.negate();
        if (axis) {
          expect(angleBetween(axis, thisAxis)).toBeLessThan(1e-3);
        } else {
          axis = thisAxis;
        }
      }
      previous = now;
      previousToEnd = toEnd;
    }
    expect(frames).toBeGreaterThan(3);
    expect(axis).not.toBeNull();
  });

  it('arrives exactly, with the requested up as the orbit axis', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    const frames = harness.settle();
    expect(frames).toBeLessThan(120);
    expect(harness.transition.active).toBe(false);
    // The orientation has landed; camera-controls finishes damping the distance on its own.
    const { back: landed } = rendered(harness.camera);
    expect(angleBetween(landed, new Vector3(0, 0, 1))).toBeLessThan(1e-6);
    harness.rest();
    expect(harness.camera.position.distanceTo(SKETCH.position)).toBeLessThan(1e-3);
    expect(harness.camera.up.distanceTo(SKETCH.up)).toBeLessThan(1e-9);
    const { back } = rendered(harness.camera);
    expect(angleBetween(back, new Vector3(0, 0, 1))).toBeLessThan(1e-6);
    // The orbit angles camera-controls holds put the camera at the destination.
    expect(harness.cc.getPosition(new Vector3()).distanceTo(SKETCH.position)).toBeLessThan(1e-3);
  });

  it('flies back to a world-up view whose up is not perpendicular to the view, and restores that up exactly', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    harness.settle();
    const home = new Vector3(100, -100, 80);
    harness.transition.flyTo(home, new Vector3(0, 0, 0), Z_UP);
    harness.settle();
    harness.rest();
    expect(harness.camera.position.distanceTo(home)).toBeLessThan(1e-3);
    // The orbit axis is the world up, not the orthonormalised screen up.
    expect(harness.camera.up.distanceTo(Z_UP)).toBeLessThan(1e-9);
    const expected = viewOrientation(home, new Vector3(0, 0, 0), Z_UP);
    expect(harness.camera.quaternion.angleTo(expected)).toBeLessThan(1e-3);
  });

  it('does not fly when already facing the destination, and lets camera-controls tween the target', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    harness.settle();
    const shifted = new Vector3(10, 5, 0);
    harness.transition.flyTo(shifted.clone().add(new Vector3(0, 0, 250)), shifted, SKETCH.up);
    expect(harness.transition.active).toBe(false);
    harness.frame();
    // Under way, not there yet: the target damps over.
    const mid = harness.cc.getTarget(new Vector3(), false);
    expect(mid.distanceTo(shifted)).toBeGreaterThan(0.3);
    expect(mid.distanceTo(new Vector3(0, 0, 0))).toBeGreaterThan(0.3);
    for (let i = 0; i < 120; i++) harness.frame();
    expect(harness.cc.getTarget(new Vector3(), false).distanceTo(shifted)).toBeLessThan(1e-2);
  });

  it('composes with a fit issued in the same tick: the fit retargets, the flight still turns', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    const fitTarget = new Vector3(20, -10, 0);
    harness.cc.moveTo(fitTarget.x, fitTarget.y, fitTarget.z, true);
    harness.settle();
    harness.rest();
    expect(harness.cc.getTarget(new Vector3(), false).distanceTo(fitTarget)).toBeLessThan(1e-2);
    const { back } = rendered(harness.camera);
    expect(angleBetween(back, new Vector3(0, 0, 1))).toBeLessThan(1e-6);
    expect(harness.camera.up.distanceTo(SKETCH.up)).toBeLessThan(1e-9);
  });

  it('snaps to the destination when the user takes the camera mid-flight', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    harness.frame();
    harness.frame();
    expect(harness.transition.active).toBe(true);
    for (const fn of harness.inputListeners) fn();
    expect(harness.transition.active).toBe(false);
    harness.frame();
    const { back } = rendered(harness.camera);
    expect(angleBetween(back, new Vector3(0, 0, 1))).toBeLessThan(1e-6);
  });
});

describe('setUp', () => {
  it('changes the orbit axis without moving the eye or the target (only the roll follows the new up)', () => {
    harness.transition.flyTo(SKETCH.position, SKETCH.target, SKETCH.up);
    harness.settle();
    harness.rest();
    const posBefore = harness.camera.position.clone();
    const backBefore = rendered(harness.camera).back;
    // An up that is neither the current one nor along the view (camera-controls
    // nudges a view exactly along its up off the pole by a millionth of a radian).
    const up = new Vector3(1, 0, 0);
    harness.transition.setUp(up);
    harness.frame();
    expect(harness.camera.position.distanceTo(posBefore)).toBeLessThan(1e-6);
    expect(angleBetween(rendered(harness.camera).back, backBefore)).toBeLessThan(1e-6);
    expect(harness.camera.up.distanceTo(up)).toBeLessThan(1e-9);
  });

  it('keeps a camera-controls tween in flight on course', () => {
    const dest = new Vector3(0, -200, 0);
    harness.cc.setLookAt(dest.x, dest.y, dest.z, 0, 0, 0, true);
    harness.frame();
    harness.transition.setUp(new Vector3(1, 0, 0));
    expect(harness.cc.getPosition(new Vector3()).distanceTo(dest)).toBeLessThan(1e-6);
    for (let i = 0; i < 120; i++) harness.frame();
    expect(harness.camera.position.distanceTo(dest)).toBeLessThan(1e-2);
  });
});

describe('orbitAngles', () => {
  it('reproduces camera-controls\' own angle construction for an eye direction', () => {
    const up = new Vector3(0, 1, 0);
    const back = new Vector3(0.3, 0.2, 0.9).normalize();
    const { theta, phi } = orbitAngles(back, up);
    const toYUp = new Quaternion().setFromUnitVectors(up, new Vector3(0, 1, 0));
    const rebuilt = new Vector3().setFromSphericalCoords(1, phi, theta).applyQuaternion(toYUp.clone().invert());
    expect(rebuilt.distanceTo(back)).toBeLessThan(1e-9);
  });
});
