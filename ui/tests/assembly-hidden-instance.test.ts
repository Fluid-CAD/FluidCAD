// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// Hiding an instance sets `group.visible = false`, but three's Raycaster
// tests only `layers` and ignores `visible` — so without explicit guards a
// hidden part still produced precise mesh hits, still matched the
// bounding-box fallback, and its connectors stayed screen-pickable. The
// symptoms: a pointerdown over a hidden part claimed the gesture
// (stopImmediatePropagation blocks camera nav), consumeRecentDrag()
// swallowed the follow-up click, and a hidden part in front poached drags
// aimed at the visible part behind it.

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

/** A ConnectorMesh stand-in: outer flagged group + inner gizmo at the frame origin. */
function fakeConnectorMesh(connectorId: string, origin: [number, number, number]): Group {
  const mesh = new Group();
  mesh.userData.isMetaShape = true;
  mesh.userData.isConnector = true;
  mesh.userData.connectorId = connectorId;
  const gizmo = new Group();
  gizmo.position.set(...origin);
  mesh.add(gizmo);
  mesh.visible = false; // assembly default: hidden until hovered/armed
  return mesh;
}

function makeRig(instances: Array<{ id: string; z: number }>) {
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
    instances: instances.map(({ id, z }) => ({
      instanceId: id, partId: 'p1', partName: 'p1',
      position: { x: 0, y: 0, z },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded: false, name: id,
    })),
    mates: [],
  };
  controller.update([partTemplate], assembly);

  for (const { id } of instances) {
    const group = controller.getInstanceGroup(id)!;
    group.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  }
  scene.updateMatrixWorld(true);

  return { canvas, camera, scene, controller };
}

describe('hidden assembly instances are excluded from hit testing', () => {
  it('claims a pointerdown on a visible instance (baseline)', () => {
    const { canvas, controller } = makeRig([{ id: 'i1', z: 0 }]);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'i1', moved: false });
  });

  it('a hidden instance neither claims the gesture nor swallows the click', () => {
    const { canvas, controller } = makeRig([{ id: 'i1', z: 0 }]);
    controller.setInstanceVisible('i1', false);

    let leakedToCamera = 0;
    canvas.addEventListener('pointerdown', () => { leakedToCamera += 1; }, true);

    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(false);
    // The event must propagate on to camera-controls / viewer listeners.
    expect(leakedToCamera).toBe(1);

    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toBeNull();
  });

  it('a hidden instance in front does not poach the drag from the visible one behind', () => {
    const { canvas, controller } = makeRig([{ id: 'front', z: 4 }, { id: 'back', z: -4 }]);

    // Baseline: the nearer instance wins the pick.
    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'front', moved: false });

    controller.setInstanceVisible('front', false);
    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'back', moved: false });
  });

  it('the bounding-box fallback skips hidden instances', () => {
    const { canvas, camera, scene, controller } = makeRig([{ id: 'i1', z: 0 }]);
    // Rotate the box 45° about z: its silhouette is the diamond |x|+|y| ≤ √2,
    // while its AABB stays the square |x|,|y| ≤ √2 — a click near the AABB
    // corner misses the mesh but hits the box, exercising only the fallback.
    const group = controller.getInstanceGroup('i1')!;
    group.children[group.children.length - 1].rotateZ(Math.PI / 4);
    scene.updateMatrixWorld(true);

    const corner = new Vector3(1.2, 1.2, 0).project(camera);
    const px = ((corner.x + 1) / 2) * W;
    const py = ((1 - corner.y) / 2) * H;

    // Baseline: the fallback claims the near-miss while visible.
    canvas.dispatchEvent(pointerEvent('pointerdown', px, py));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', px, py));
    expect(controller.consumeRecentDrag()).toEqual({ instanceId: 'i1', moved: false });

    controller.setInstanceVisible('i1', false);
    canvas.dispatchEvent(pointerEvent('pointerdown', px, py));
    expect(controller.isDragGestureActive()).toBe(false);
    canvas.dispatchEvent(pointerEvent('pointerup', px, py));
    expect(controller.consumeRecentDrag()).toBeNull();
  });

  it('pickConnectorAt ignores connectors of hidden instances even while armed', () => {
    const { camera, scene, controller } = makeRig([{ id: 'i1', z: 0 }]);
    const group = controller.getInstanceGroup('i1')!;
    group.add(fakeConnectorMesh('c1', [1, 0, 0]));
    scene.updateMatrixWorld(true);
    // Arming sets every connector child visible — the instance-level flag is
    // the only thing left saying "this one renders nothing".
    controller.setMatePicking(true);

    const origin = new Vector3(1, 0, 0).project(camera);
    const px = ((origin.x + 1) / 2) * W;
    const py = ((1 - origin.y) / 2) * H;
    expect(controller.pickConnectorAt(px, py)).toEqual({ instanceId: 'i1', connectorId: 'c1' });

    controller.setInstanceVisible('i1', false);
    expect(controller.pickConnectorAt(px, py)).toBeNull();
  });
});
