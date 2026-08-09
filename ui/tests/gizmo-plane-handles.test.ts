// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Scene, Vector2, Vector3 } from 'three';
import { GizmoHandleFactory } from '../src/interactive/gizmo/gizmo-geometry';
import { TransformGizmo } from '../src/interactive/gizmo/transform-gizmo';
import type { GizmoDelta } from '../src/interactive/gizmo/gizmo-session';

// The planar squares live in the positive pocket between their two axes and
// their clicks must claim the gesture (a miss falls through to the assembly
// free-drag — view-plane movement, exactly the "no planar constraint" bug)
// and constrain deltas to the plane.

const W = 800;
const H = 600;

/** World center of each square: PLANE_OFFSET along both of its plane axes. */
const POCKETS: [string, Vector3, number][] = [
  // [id, world center, index of the axis a planar drag must never move]
  ['pxy', new Vector3(2.2, 2.2, 0), 2],
  ['pyz', new Vector3(0, 2.2, 2.2), 0],
  ['pxz', new Vector3(2.2, 0, 2.2), 1],
];

function makeRect(el: HTMLElement): void {
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
}

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: 1 });
  (e as any).pointerId = 1;
  return e as unknown as PointerEvent;
}

describe('gizmo plane squares', () => {
  it('places each square hit mesh in the positive pocket of its plane', () => {
    const set = GizmoHandleFactory.build();
    set.root.visible = true;
    set.root.updateMatrixWorld(true);
    for (const [id, pocket] of POCKETS) {
      const record = set.handles.find(h => h.id === id)!;
      const world = new Vector3();
      record.hitMesh.getWorldPosition(world);
      expect(world.distanceTo(pocket), `${id} at ${world.toArray()}`).toBeLessThan(1e-9);
    }
  });

  it('square clicks claim the gesture and drags stay in-plane', () => {
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
    const deltas: GizmoDelta[] = [];
    const gizmo = new TransformGizmo(
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
        onDragStart: () => {},
        onDragUpdate: (delta) => { deltas.push(delta); },
        onCommit: () => {},
        onCancel: () => {},
      },
    );
    gizmo.show(new Vector3(0, 0, 0));
    // The app's render loop keeps world matrices current; the rig has no
    // renderer, so emulate it.
    scene.updateMatrixWorld(true);

    // A later canvas capture listener — the assembly free-drag's slot. A
    // claimed pointerdown must never reach it.
    let leaked = 0;
    canvas.addEventListener('pointerdown', () => { leaked += 1; }, true);

    const toClient = (world: Vector3) => {
      const p = world.clone().project(camera);
      return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
    };

    for (const [id, pocket, lockedAxis] of POCKETS) {
      deltas.length = 0;
      const at = toClient(pocket);
      canvas.dispatchEvent(pointerEvent('pointerdown', at.x, at.y));
      expect(gizmo.hasActiveGesture, `${id} pointerdown did not claim`).toBe(true);
      canvas.dispatchEvent(pointerEvent('pointermove', at.x + 40, at.y + 15));
      canvas.dispatchEvent(pointerEvent('pointermove', at.x + 80, at.y + 30));
      canvas.dispatchEvent(pointerEvent('pointerup', at.x + 80, at.y + 30));

      expect(deltas.length, `${id} produced no drag deltas`).toBeGreaterThan(0);
      for (const delta of deltas) {
        expect(delta.kind).toBe('translate');
        if (delta.kind === 'translate') {
          expect(Math.abs(delta.delta.getComponent(lockedAxis)), `${id} left its plane`).toBeLessThan(1e-9);
          expect(delta.delta.length()).toBeGreaterThan(0);
        }
      }
    }
    expect(leaked).toBe(0);
    gizmo.dispose();
  });
});
