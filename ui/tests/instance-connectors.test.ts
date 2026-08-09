// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  type WebGLRenderer,
} from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// Assembly-scoped instance connectors: top-level scene objects whose
// serialized data carries `instanceId`. They render into (and only into)
// their own instance's group, join that body's solver connector set, and
// re-resolve by (instanceId, name) like part connectors do.

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

function connectorFrame() {
  return {
    origin: { x: 1, y: 0, z: 0 },
    xDirection: { x: 1, y: 0, z: 0 },
    yDirection: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
  };
}

function makeRig(sceneObjects: SceneObjectRender[], assembly: SerializedAssembly) {
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
  controller.update(sceneObjects, assembly);
  return { controller, scene };
}

const PART: SceneObjectRender = {
  id: 'p1', type: 'part', visible: true, sceneShapes: [], ownShapes: [],
};

const PART_CONNECTOR: SceneObjectRender = {
  id: 'cpart', type: 'connector', parentId: 'p1', name: 'top', visible: true,
  fromCache: true,
  object: { name: 'top', ...connectorFrame() },
  sceneShapes: [], ownShapes: [],
};

/** Assembly-scoped connector bound to instance i2 — top-level, no parent. */
const INSTANCE_CONNECTOR: SceneObjectRender = {
  id: 'cinst', type: 'connector', parentId: null, name: 'pivot', visible: true,
  fromCache: true,
  object: { name: 'pivot', instanceId: 'i2', ...connectorFrame() },
  sceneShapes: [], ownShapes: [],
};

function twoInstances(): SerializedAssembly {
  const base = {
    partId: 'p1', partName: 'p1',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
  };
  return {
    instances: [
      { ...base, instanceId: 'i1', name: 'i1', sourceLocation: { filePath: '/ws/m.assembly.js', line: 3, column: 0 } },
      { ...base, instanceId: 'i2', name: 'i2', sourceLocation: { filePath: '/ws/m.assembly.js', line: 4, column: 0 } },
    ],
    mates: [],
  };
}

function connectorIdsInGroup(controller: AssemblyController, instanceId: string): string[] {
  const ids: string[] = [];
  controller.getInstanceGroup(instanceId)!.traverse((child) => {
    if (child.userData?.isConnector && typeof child.userData.connectorId === 'string') {
      ids.push(child.userData.connectorId);
    }
  });
  return ids;
}

describe('instance-scoped connectors in the assembly controller', () => {
  it('renders the instance connector only in its own instance group', () => {
    const { controller } = makeRig([PART, PART_CONNECTOR, INSTANCE_CONNECTOR], twoInstances());
    // Part connectors render in every instance's group; the instance
    // connector only in i2's.
    expect(connectorIdsInGroup(controller, 'i1')).toEqual(['cpart']);
    expect(connectorIdsInGroup(controller, 'i2').sort()).toEqual(['cinst', 'cpart']);
  });

  it('resolves ids and ownership by (instanceId, name)', () => {
    const { controller } = makeRig([PART, PART_CONNECTOR, INSTANCE_CONNECTOR], twoInstances());
    expect(controller.findConnectorId('i2', 'pivot')).toBe('cinst');
    expect(controller.findConnectorId('i1', 'pivot')).toBeNull();
    expect(controller.findConnectorId('i1', 'top')).toBe('cpart');
    expect(controller.findConnectorId('i2', 'top')).toBe('cpart');
    expect(controller.getConnectorInstanceId('cinst')).toBe('i2');
    expect(controller.getConnectorInstanceId('cpart')).toBeNull();
    expect(controller.getConnectorName('cinst')).toBe('pivot');
  });

  it('rebuilds the instance group when an instance connector appears', () => {
    const assembly = twoInstances();
    const { controller } = makeRig([PART, PART_CONNECTOR], assembly);
    expect(connectorIdsInGroup(controller, 'i2')).toEqual(['cpart']);

    // Next render carries the new statement; the part subtree is fully
    // cached, so only the instance-connector diff can trigger the rebuild.
    controller.update([
      { ...PART, fromCache: true },
      PART_CONNECTOR,
      { ...INSTANCE_CONNECTOR, fromCache: false },
    ], assembly);
    expect(connectorIdsInGroup(controller, 'i2').sort()).toEqual(['cinst', 'cpart']);
    // The other instance's group is untouched by it.
    expect(connectorIdsInGroup(controller, 'i1')).toEqual(['cpart']);
  });

  it('drops the mesh again when the instance connector is removed', () => {
    const assembly = twoInstances();
    const { controller } = makeRig([PART, PART_CONNECTOR, INSTANCE_CONNECTOR], assembly);
    expect(connectorIdsInGroup(controller, 'i2').sort()).toEqual(['cinst', 'cpart']);
    controller.update([{ ...PART, fromCache: true }, PART_CONNECTOR], assembly);
    expect(connectorIdsInGroup(controller, 'i2')).toEqual(['cpart']);
  });

  it('reveals instance connectors while mate picking is armed', () => {
    const { controller } = makeRig([PART, PART_CONNECTOR, INSTANCE_CONNECTOR], twoInstances());
    const group = controller.getInstanceGroup('i2')!;
    const mesh = (() => {
      let found: any = null;
      group.traverse((child) => {
        if (child.userData?.connectorId === 'cinst') found = child;
      });
      return found;
    })();
    expect(mesh.visible).toBe(false);
    controller.setMatePicking(true);
    expect(mesh.visible).toBe(true);
    controller.setMatePicking(false);
    expect(mesh.visible).toBe(false);
  });
});
