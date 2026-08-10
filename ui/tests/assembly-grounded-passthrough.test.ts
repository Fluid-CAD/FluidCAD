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

// Locked instances (grounded, or fastened-only-chained to ground) can never
// be dragged, so the pick ray must fall through them: a pointerdown whose
// first precise hit is a grounded part should claim the draggable part
// behind it instead of bubbling to camera nav. Only when nothing draggable
// lies along the ray does the gesture bubble.

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

function makeRig(instances: Array<{ id: string; z: number; grounded?: boolean }>) {
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

  const partTemplate: SceneObjectRender = {
    id: 'p1', type: 'part', visible: false, sceneShapes: [], ownShapes: [],
  };
  const assembly: SerializedAssembly = {
    instances: instances.map(({ id, z, grounded }) => ({
      instanceId: id, partId: 'p1', partName: 'p1',
      position: { x: 0, y: 0, z },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded: grounded === true, name: id,
    })),
    mates: [],
  };
  controller.update([partTemplate], assembly);

  for (const { id } of instances) {
    const group = controller.getInstanceGroup(id)!;
    group.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  }
  scene.updateMatrixWorld(true);

  return { canvas, controller };
}

describe('drag pick falls through grounded instances', () => {
  it('a grounded instance in front yields the drag to the draggable one behind', () => {
    const { canvas, controller } = makeRig([
      { id: 'front', z: 4, grounded: true },
      { id: 'back', z: -4 },
    ]);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'back', moved: false });
  });

  it('bubbles to camera nav when only grounded instances are along the ray', () => {
    const { canvas, controller } = makeRig([{ id: 'front', z: 4, grounded: true }]);

    let leakedToCamera = 0;
    canvas.addEventListener('pointerdown', () => { leakedToCamera += 1; }, true);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(false);
    expect(leakedToCamera).toBe(1);

    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    // No ghost drop that would swallow the follow-up selection click.
    expect(controller.consumeRecentDrag()).toBeNull();
  });

  it('skips a grounded AND a hidden instance stacked in front of the draggable one', () => {
    const { canvas, controller } = makeRig([
      { id: 'grounded', z: 6, grounded: true },
      { id: 'hidden', z: 2 },
      { id: 'back', z: -4 },
    ]);
    controller.setInstanceVisible('hidden', false);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'back', moved: false });
  });
});
