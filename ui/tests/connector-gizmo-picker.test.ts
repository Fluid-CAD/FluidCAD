// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, Vector3 } from 'three';
import {
  CONNECTOR_AMBIGUITY_PX,
  CONNECTOR_PICK_RADIUS_PX,
  ConnectorGizmoPicker,
  type ConnectorGizmoTarget,
} from '../src/scene/connector-gizmo-picker';

// The one screen-space connector pick every dialog shares — the assembly
// controller's mate and replicate picks and the part dialogs' (the Copy
// dialog's connector targets and axis). Gizmos draw depth-test-off on top
// of everything, so the gizmo a click means is the one whose origin projects
// nearest the cursor; gizmos a few pixels apart are all offered.

const W = 800;
const H = 600;

function makeCanvas(rect: { width: number; height: number } = { width: W, height: H }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: rect.width, bottom: rect.height, width: rect.width, height: rect.height, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
  return canvas;
}

function makeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** A ConnectorMesh stand-in: the flagged group at the part origin, its gizmo child at the frame origin. */
function connectorMesh(connectorId: string, origin: [number, number, number]): Group {
  const mesh = new Group();
  mesh.userData.isConnector = true;
  mesh.userData.connectorId = connectorId;
  const gizmo = new Group();
  gizmo.position.set(...origin);
  mesh.add(gizmo);
  return mesh;
}

/** Where a world point lands on the 800 × 600 canvas. */
function screenOf(camera: PerspectiveCamera, point: [number, number, number]): { x: number; y: number } {
  const projected = new Vector3(...point).project(camera);
  return { x: ((projected.x + 1) / 2) * W, y: ((1 - projected.y) / 2) * H };
}

function rig() {
  const camera = makeCamera();
  const picker = new ConnectorGizmoPicker(() => camera, makeCanvas());
  const root = new Group();
  return { camera, picker, root };
}

describe('ConnectorGizmoPicker', () => {
  it('picks the gizmo whose origin projects nearest the cursor, within the radius', () => {
    const { camera, picker, root } = rig();
    root.add(connectorMesh('a', [1, 0, 0]), connectorMesh('b', [-1, 0, 0]));
    root.updateMatrixWorld(true);
    const a = screenOf(camera, [1, 0, 0]);

    const hits = picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), a.x + 4, a.y + 3);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ instanceId: null, connectorId: 'a' });
    expect(hits[0].distPx).toBeCloseTo(5, 6);
    // Just outside the radius: nothing.
    expect(picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), a.x + CONNECTOR_PICK_RADIUS_PX + 1, a.y))
      .toEqual([]);
  });

  it('lists coincident gizmos nearest first, and only those within the ambiguity band', () => {
    const { camera, picker, root } = rig();
    // Two gizmos on one origin (a seed and a connector declared on the same
    // rim), and a third a few pixels further than the band allows.
    root.add(connectorMesh('near', [0, 0, 0]), connectorMesh('same', [0, 0, 0]), connectorMesh('far', [0.1, 0, 0]));
    root.updateMatrixWorld(true);
    const origin = screenOf(camera, [0, 0, 0]);
    const far = screenOf(camera, [0.1, 0, 0]);
    expect(far.x - origin.x).toBeGreaterThan(CONNECTOR_AMBIGUITY_PX);

    const hits = picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), origin.x, origin.y);

    expect(hits.map(hit => hit.connectorId)).toEqual(['near', 'same']);
  });

  it('keeps each target\'s owner — the assembly instance, or null in a part scene', () => {
    const { camera, picker } = rig();
    const gizmo = new Group();
    const targets: ConnectorGizmoTarget<string>[] = [{ instanceId: 'i1', connectorId: 'c1', anchor: gizmo }];
    gizmo.updateMatrixWorld(true);
    const at = screenOf(camera, [0, 0, 0]);

    expect(picker.candidatesAt(targets, at.x, at.y)).toEqual([{ instanceId: 'i1', connectorId: 'c1', distPx: 0 }]);
  });

  it('never picks a gizmo behind the camera, or anything on a canvas with no size', () => {
    const { camera, root } = rig();
    root.add(connectorMesh('behind', [0, 0, 20]));
    root.updateMatrixWorld(true);
    const picker = new ConnectorGizmoPicker(() => camera, makeCanvas());
    expect(picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), W / 2, H / 2)).toEqual([]);

    const front = new Group();
    front.add(connectorMesh('front', [0, 0, 0]));
    front.updateMatrixWorld(true);
    const collapsed = new ConnectorGizmoPicker(() => camera, makeCanvas({ width: 0, height: 0 }));
    expect(collapsed.candidatesAt(ConnectorGizmoPicker.gizmosIn(front, null), 0, 0)).toEqual([]);
  });

  it('measures against the camera it is handed now — a projection switch swaps the camera', () => {
    let camera = makeCamera();
    const picker = new ConnectorGizmoPicker(() => camera, makeCanvas());
    const root = new Group();
    root.add(connectorMesh('a', [2, 0, 0]));
    root.updateMatrixWorld(true);
    const before = screenOf(camera, [2, 0, 0]);
    expect(picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), before.x, before.y)).toHaveLength(1);

    camera = makeCamera();
    camera.position.set(0, 0, 40);
    camera.updateMatrixWorld(true);
    const after = screenOf(camera, [2, 0, 0]);
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(CONNECTOR_PICK_RADIUS_PX);
    expect(picker.candidatesAt(ConnectorGizmoPicker.gizmosIn(root, null), after.x, after.y)).toHaveLength(1);
  });

  describe('gizmosIn', () => {
    it('anchors each drawn connector at its gizmo child — the frame origin, not the part origin', () => {
      const root = new Group();
      const mesh = connectorMesh('c1', [5, 0, 0]);
      root.add(mesh);

      const [target] = ConnectorGizmoPicker.gizmosIn(root, 'i1');

      expect(target).toEqual({ instanceId: 'i1', connectorId: 'c1', anchor: mesh.children[0] });
    });

    it('leaves out a hidden connector and every connector under a hidden ancestor', () => {
      const root = new Group();
      const hidden = connectorMesh('hidden', [0, 0, 0]);
      hidden.visible = false;
      const body = new Group();
      body.visible = false;
      body.add(connectorMesh('under-hidden', [0, 0, 0]));
      const nested = new Group();
      nested.add(connectorMesh('nested', [0, 0, 0]));
      root.add(hidden, body, nested, new Group());

      expect(ConnectorGizmoPicker.gizmosIn(root, null).map(t => t.connectorId)).toEqual(['nested']);
    });
  });
});
