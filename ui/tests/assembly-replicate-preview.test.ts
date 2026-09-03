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
  type WebGLRenderer,
} from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import { provisionalReplicaId, provisionalReplicaMateId } from '../src/scene/provisional-replicas';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// The controller's replicate preview: ghost clones of the seed's bodies
// join the solve under provisional ids, land on the row's targets, render
// translucent (never hidden), and never answer picks; a render disposes
// them; commit keeps them on screen but out of the solve.

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  (canvas as any).setPointerCapture = () => {};
  (canvas as any).releasePointerCapture = () => {};
  return canvas;
}

function connectorRender(id: string, parentId: string, name: string, origin: [number, number, number], normal: [number, number, number]): SceneObjectRender {
  return {
    id, type: 'connector', parentId, name,
    object: {
      name,
      origin: { x: origin[0], y: origin[1], z: origin[2] },
      xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 },
      normal: { x: normal[0], y: normal[1], z: normal[2] },
    },
    sceneShapes: [], ownShapes: [],
  } as SceneObjectRender;
}

function makeRig() {
  const canvas = makeCanvas();
  const renderer = { domElement: canvas } as unknown as WebGLRenderer;
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  const scene = new Scene();
  const controller = new AssemblyController(renderer, camera, () => {}, (x, y) => {
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(x, y), camera);
    return raycaster;
  });
  scene.add(controller.getContainer());
  const sceneObjects: SceneObjectRender[] = [
    { id: 'p-block', type: 'part', visible: false, sceneShapes: [], ownShapes: [] } as SceneObjectRender,
    { id: 'p-pin', type: 'part', visible: false, sceneShapes: [], ownShapes: [] } as SceneObjectRender,
    connectorRender('h1', 'p-block', 'h1', [-40, 0, 10], [0, 0, 1]),
    connectorRender('h2', 'p-block', 'h2', [0, 0, 10], [0, 0, 1]),
    connectorRender('base', 'p-pin', 'base', [0, 0, 0], [0, 0, -1]),
  ];
  const assembly: SerializedAssembly = {
    instances: [
      { instanceId: 'i0', partId: 'p-block', partName: 'Block', position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, grounded: true, name: 'Block' },
      { instanceId: 'i1', partId: 'p-pin', partName: 'Pin', position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, grounded: false, name: 'Pin' },
    ],
    mates: [{
      mateId: 'mate-0', type: 'fastened', status: 'satisfied',
      connectorA: { instanceId: 'i1', connectorId: 'base' },
      connectorB: { instanceId: 'i0', connectorId: 'h1' },
    }],
  };
  controller.update(sceneObjects, assembly);
  // A visible body on the pin so the ghost has something to clone.
  const pinGroup = controller.getInstanceGroup('i1')!;
  const pinMesh = new Mesh(new BoxGeometry(2, 2, 20), new MeshBasicMaterial({ color: 0x808080 }));
  pinMesh.userData.shapeId = 'pin-solid';
  pinGroup.add(pinMesh);
  const provisional = () => controller.getContainer().getObjectByName('assemblyProvisionalReplicas') as Group;
  return { controller, sceneObjects, assembly, pinGroup, pinMesh, provisional };
}

describe('provisional replicas', () => {
  it('clones the seed onto the row target, ghosted and unpickable', () => {
    const { controller, provisional, pinGroup } = makeRig();
    // The seed sits on h1 after the initial solve.
    expect(pinGroup.position.x).toBeCloseTo(-40, 6);
    expect(pinGroup.position.z).toBeCloseTo(10, 6);
    const ghostId = provisionalReplicaId(0, 'i1');
    controller.setProvisionalReplicas({
      rows: [{
        clones: [{ sourceInstanceId: 'i1', provisionalId: ghostId }],
        mates: [{
          mateId: provisionalReplicaMateId(0, 'mate-0'), type: 'fastened',
          connectorA: { instanceId: ghostId, connectorId: 'base' },
          connectorB: { instanceId: 'i0', connectorId: 'h2' },
        }],
      }],
    });
    expect(controller.hasProvisionalReplicas()).toBe(true);
    const ghosts = provisional().children;
    expect(ghosts).toHaveLength(1);
    const ghost = ghosts[0];
    // Solved onto h2 — not left at the seed's pose.
    expect(ghost.position.x).toBeCloseTo(0, 6);
    expect(ghost.position.z).toBeCloseTo(10, 6);
    // Same orientation as the seed (same mate options).
    expect(ghost.quaternion.angleTo(pinGroup.quaternion)).toBeCloseTo(0, 6);
    // Ghosted: translucent, lightened, meta (unpickable), no instance identity.
    const mesh = ghost.getObjectByProperty('type', 'Mesh') as Mesh;
    expect(mesh).toBeTruthy();
    const material = mesh.material as MeshBasicMaterial;
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeLessThan(1);
    expect(material.color.getHex()).toBeGreaterThan(0x808080);
    expect(mesh.userData.isMetaShape).toBe(true);
    expect(ghost.userData.instanceId).toBeUndefined();
    expect(mesh.visible).toBe(true);
    // The seed's own material is untouched.
    expect(((pinGroup.children.find(c => (c as Mesh).isMesh) as Mesh).material as MeshBasicMaterial).transparent).toBe(false);
  });

  it('clearing restores the scene; commit keeps ghosts on screen but out of the solve; a render disposes them', () => {
    const { controller, provisional, sceneObjects, assembly } = makeRig();
    const ghostId = provisionalReplicaId(0, 'i1');
    const spec = {
      rows: [{
        clones: [{ sourceInstanceId: 'i1', provisionalId: ghostId }],
        mates: [{
          mateId: provisionalReplicaMateId(0, 'mate-0'), type: 'fastened' as const,
          connectorA: { instanceId: ghostId, connectorId: 'base' },
          connectorB: { instanceId: 'i0', connectorId: 'h2' },
        }],
      }],
    };
    controller.setProvisionalReplicas(spec);
    controller.setProvisionalReplicas(null);
    expect(provisional().children).toHaveLength(0);
    expect(controller.hasProvisionalReplicas()).toBe(false);
    controller.setProvisionalReplicas(spec);
    controller.commitProvisionalReplicas();
    expect(provisional().children).toHaveLength(1);
    expect(controller.hasProvisionalReplicas()).toBe(true);
    controller.update(sceneObjects, assembly);
    expect(provisional().children).toHaveLength(0);
    expect(controller.hasProvisionalReplicas()).toBe(false);
  });
});
