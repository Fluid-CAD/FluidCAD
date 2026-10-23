// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Scene, Vector2, Vector3 } from 'three';
import { TransformGizmo } from '../src/interactive/gizmo/transform-gizmo';

// A host may refuse a drag the moment it begins — the assembly driver when
// the instance can't be claimed, the translate dialog when a distance can't
// be read — by cancelling from onDragStart. The gesture must end right there:
// no update reaches the host, no value input opens, and the release is still
// the gizmo's, never a click on whatever lies under the pointer.

const W = 800;
const H = 600;

function makeRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 });
  (e as any).pointerId = 1;
  return e as unknown as PointerEvent;
}

describe('gizmo drag refused at its start', () => {
  it('ends the gesture without updates, a value input or a click', () => {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    document.body.appendChild(container);
    makeRect(container);
    makeRect(canvas);
    (canvas as any).setPointerCapture = () => {};
    (canvas as any).releasePointerCapture = () => {};

    const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
    camera.position.set(10, 10, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const scene = new Scene();
    const calls = { starts: 0, updates: 0, cancels: 0 };
    const gizmo: TransformGizmo = new TransformGizmo(
      {
        scene,
        overlayContainer: container,
        interactionRoot: container,
        canvas,
        getCamera: () => camera,
        createPickingRaycaster: (ndcX, ndcY) => {
          const raycaster = new Raycaster();
          raycaster.setFromCamera(new Vector2(ndcX, ndcY), camera);
          return raycaster;
        },
        requestRender: () => {},
      },
      {
        onDragStart: () => {
          calls.starts++;
          gizmo.cancelActiveDrag();
        },
        onDragUpdate: () => { calls.updates++; },
        onCommit: () => {},
        onCancel: () => { calls.cancels++; },
      },
    );
    gizmo.show(new Vector3(0, 0, 0));
    scene.updateMatrixWorld(true);

    const toClient = (world: Vector3) => {
      const p = world.clone().project(camera);
      return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
    };
    const from = toClient(new Vector3(4, 0, 0));
    const to = toClient(new Vector3(7, 0, 0));
    canvas.dispatchEvent(pointer('pointerdown', from.x, from.y));
    expect(gizmo.hasActiveGesture).toBe(true);
    expect(() => canvas.dispatchEvent(pointer('pointermove', to.x, to.y))).not.toThrow();

    expect(calls).toEqual({ starts: 1, updates: 0, cancels: 1 });
    expect(gizmo.hasActiveGesture).toBe(false);
    expect(container.querySelector('.expression-input')!.closest('.hidden')).not.toBeNull();

    canvas.dispatchEvent(pointer('pointerup', to.x, to.y));
    expect(gizmo.consumeRecentInteraction()).toBe(true);
  });
});
