// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  type WebGLRenderer,
} from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// Switching from an assembly file to a part file detaches the assembly
// container from the scene but keeps the controller (and its instance
// groups) alive so a part → assembly round-trip preserves dragged poses.
// The controller's capture-phase pointer handlers must go dormant while
// detached: a pointerdown that raycast-hits the stale, invisible instance
// meshes would otherwise claim the gesture, block camera-controls via
// stopImmediatePropagation, keep isDragGestureActive() true (killing the
// viewer's hover raycast), and feed consumeRecentDrag() a ghost drop that
// swallows the face-selection click — "can't pick faces/edges after
// switching to a part file".

const W = 800;
const H = 600;

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  (canvas as any).setPointerCapture = () => {};
  (canvas as any).releasePointerCapture = () => {};
  return canvas;
}

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 });
  (e as any).pointerId = 1;
  return e as unknown as PointerEvent;
}

function makeRig() {
  const canvas = makeCanvas();
  const renderer = { domElement: canvas } as unknown as WebGLRenderer;

  const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const scene = new Scene();
  const controller = new AssemblyController(
    renderer,
    camera,
    () => {},
    (ndcX, ndcY) => {
      const raycaster = new Raycaster();
      raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
      return raycaster;
    },
  );
  scene.add(controller.getContainer());

  // One draggable (non-grounded) instance. The part template renders as an
  // empty group (visible: false keeps buildObjectMesh trivial); the test
  // gives the instance real raycastable geometry directly.
  const partTemplate: SceneObjectRender = {
    id: 'p1', type: 'part', visible: false, sceneShapes: [], ownShapes: [],
  };
  const assembly: SerializedAssembly = {
    instances: [{
      instanceId: 'i1', partId: 'p1', partName: 'p1',
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded: false, name: 'i1',
    }],
    mates: [],
  };
  controller.update([partTemplate], assembly);

  const group = controller.getInstanceGroup('i1')!;
  group.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  scene.updateMatrixWorld(true);

  return { canvas, scene, controller };
}

describe('assembly controller pointer handlers across a part-file switch', () => {
  it('claims a pointerdown on an instance while the container is attached (baseline)', () => {
    const { canvas, controller } = makeRig();

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(false);
    expect(controller.consumeRecentDrag()).not.toBeNull();
  });

  it('does not claim pointerdowns while the container is detached (part mode)', () => {
    const { canvas, scene, controller } = makeRig();

    // What Viewer.updateView does on a part render: detach, keep state.
    scene.remove(controller.getContainer());

    let leakedToCamera = 0;
    canvas.addEventListener('pointerdown', () => { leakedToCamera += 1; }, true);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(false);
    // The event must propagate on to camera-controls / viewer listeners.
    expect(leakedToCamera).toBe(1);

    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    // No ghost drop: the viewer's mouseup-as-click must see null here, or
    // it swallows the face-selection click in part mode.
    expect(controller.consumeRecentDrag()).toBeNull();
  });

  it('cancels an in-flight drag when the scene switches out mid-gesture', () => {
    const { canvas, scene, controller } = makeRig();

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);

    // A part render arriving mid-drag: Viewer.updateView detaches the
    // container and cancels the gesture so the flag can't stay stuck true.
    scene.remove(controller.getContainer());
    controller.cancelPointerGesture();
    expect(controller.isDragGestureActive()).toBe(false);

    // The still-held pointer's release must not manufacture a ghost drop.
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toBeNull();
  });
});
