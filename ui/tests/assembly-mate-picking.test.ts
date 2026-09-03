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
import { WORLD_BODY_ID } from '../src/solver';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

// The mate dialog's connector picking: arming reveals every connector and
// makes pointerdown bail (clicks mean "pick", never "move"); picks resolve
// by screen distance to the gizmo origins; hover feedback rides a scale
// multiplier on the gizmo; picks re-find themselves by (instance, name)
// after a render re-mints scene ids.

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
  mesh.visible = false; // assembly default: hidden until a mate dialog reveals
  return mesh;
}

function makeRig(withSibling = false) {
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
  const connectorObj: SceneObjectRender = {
    id: 'c1', type: 'connector', parentId: 'p1', name: 'top',
    object: {
      name: 'top',
      origin: { x: 0, y: 0, z: 0 },
      xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
    sceneShapes: [], ownShapes: [],
  };
  const instanceRecord = (instanceId: string, x: number) => ({
    instanceId, partId: 'p1', partName: 'p1',
    position: { x, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false, name: instanceId,
    sourceLocation: { filePath: '/ws/m.assembly.js', line: 4, column: 0 },
  });
  const assembly: SerializedAssembly = {
    instances: [instanceRecord('i1', 0), ...(withSibling ? [instanceRecord('i2', 4)] : [])],
    mates: [],
  };
  const sceneObjects = [partTemplate, connectorObj];
  controller.update(sceneObjects, assembly);

  const group = controller.getInstanceGroup('i1')!;
  group.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()));
  const connectorMesh = fakeConnectorMesh('c1', [1, 0, 0]);
  group.add(connectorMesh);
  // A second instance of the SAME part — its gizmo shares the part-scoped
  // connector id, the way real renders duplicate the template's connectors.
  let siblingConnectorMesh: Group | null = null;
  if (withSibling) {
    siblingConnectorMesh = fakeConnectorMesh('c1', [1, 0, 0]);
    controller.getInstanceGroup('i2')!.add(siblingConnectorMesh);
  }
  scene.updateMatrixWorld(true);

  return { canvas, scene, controller, group, connectorMesh, siblingConnectorMesh, sceneObjects, assembly };
}

describe('mate-dialog connector picking', () => {
  it('pointerdown bails while picking is armed, so clicks bubble to the viewer', () => {
    const { canvas, controller } = makeRig();

    controller.setMatePicking(true);
    let leaked = 0;
    canvas.addEventListener('pointerdown', () => { leaked += 1; }, true);
    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(false);
    expect(leaked).toBe(1);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
    expect(controller.consumeRecentDrag()).toBeNull();

    // Disarmed again: the claim behavior returns.
    controller.setMatePicking(false);
    canvas.dispatchEvent(pointerEvent('pointerdown', W / 2, H / 2));
    expect(controller.isDragGestureActive()).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointerup', W / 2, H / 2));
  });

  it('arming reveals every connector; disarming re-hides unhovered ones', () => {
    const { controller, connectorMesh } = makeRig();
    expect(connectorMesh.visible).toBe(false);
    controller.setMatePicking(true);
    expect(connectorMesh.visible).toBe(true);
    controller.setMatePicking(false);
    expect(connectorMesh.visible).toBe(false);
  });

  it('hover-reveal arming (the edit dialog) reveals per-instance on hover', () => {
    const { controller, connectorMesh } = makeRig();
    controller.setMatePicking(true, false);
    // No blanket reveal — connectors appear per-instance on hover.
    expect(connectorMesh.visible).toBe(false);
    controller.setHoveredInstance('i1');
    expect(connectorMesh.visible).toBe(true);
    controller.setHoveredInstance(null);
    expect(connectorMesh.visible).toBe(false);
    // The dialog's slot chips pin their connectors in view without hover …
    controller.setMatePickedConnectors([{ instanceId: 'i1', connectorId: 'c1' }]);
    expect(connectorMesh.visible).toBe(true);
    controller.setMatePickedConnectors([]);
    expect(connectorMesh.visible).toBe(false);
    // … and disarming hides everything — hover reveals nothing without a
    // mate dialog open.
    controller.setMatePicking(false);
    controller.setHoveredInstance('i1');
    expect(connectorMesh.visible).toBe(false);
  });

  it('hover reveals nothing while no mate dialog is open', () => {
    const { controller, connectorMesh } = makeRig();
    controller.setHoveredInstance('i1');
    expect(connectorMesh.visible).toBe(false);
    // The hover tracked while closed still counts once a dialog arms in
    // hover-reveal mode — the part already under the cursor shows at once.
    controller.setMatePicking(true, false);
    expect(connectorMesh.visible).toBe(true);
    controller.setHoveredInstance(null);
    expect(connectorMesh.visible).toBe(false);
  });

  it('pins a picked slot on ITS instance only, not on part siblings', () => {
    const { controller, connectorMesh, siblingConnectorMesh } = makeRig(true);
    controller.setMatePicking(true, false);
    // Both instances carry the part-scoped connector id 'c1'; only the
    // picked instance's copy may reveal.
    controller.setMatePickedConnectors([{ instanceId: 'i1', connectorId: 'c1' }]);
    expect(connectorMesh.visible).toBe(true);
    expect(siblingConnectorMesh!.visible).toBe(false);
  });

  it('a diff update mid-pick keeps rebuilt connectors revealed', () => {
    const { controller, group, sceneObjects, assembly } = makeRig();
    controller.setMatePicking(true);
    controller.update(sceneObjects, assembly);
    // The fast path kept the same group; its connector must still be shown.
    const stillThere = group.children.find(c => c.userData?.isConnector);
    expect(stillThere?.visible).toBe(true);
  });

  it('pickConnectorAt resolves the gizmo nearest the cursor by screen distance', () => {
    const { controller, connectorMesh } = makeRig();
    controller.setMatePicking(true);

    // The gizmo origin sits at world (1, 0, 0); project it the same way the
    // controller does and click a few pixels off it.
    const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const projected = connectorMesh.children[0].getWorldPosition(new Vector3()).project(camera);
    const px = ((projected.x + 1) / 2) * W;
    const py = ((1 - projected.y) / 2) * H;

    expect(controller.pickConnectorAt(px + 5, py + 5)).toEqual({ instanceId: 'i1', connectorId: 'c1' });
    // Far away: no hit.
    expect(controller.pickConnectorAt(px + 200, py)).toBeNull();
  });

  it('does not pick hidden connectors (not armed, not hovered)', () => {
    const { controller } = makeRig();
    expect(controller.pickConnectorAt(W / 2, H / 2)).toBeNull();
  });

  // An assembly connector (`connector('base', [0, 0, 0])` at assembly
  // level) is the user's own feature: visible by default, hidden by name
  // from the rail, revealed again while a mate dialog is picking, and
  // picked as the world side.
  const worldConnector = {
    connectorId: 'w1', name: 'base', owner: '',
    origin: { x: 0, y: 0, z: 0 },
    xDirection: { x: 1, y: 0, z: 0 },
    yDirection: { x: 0, y: 1, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    sourceLocation: { filePath: '/ws/m.assembly.js', line: 6, column: 0 },
  };

  it('assembly connectors show by default and are pickable as the world side', () => {
    const { controller, scene, sceneObjects, assembly } = makeRig();
    controller.update(sceneObjects, { ...assembly, connectors: [worldConnector] });
    scene.updateMatrixWorld(true);
    const gizmo = controller.getWorldConnectorGroup('w1')!;
    expect(gizmo.visible).toBe(true);
    // The world origin projects to screen center (camera looks at 0,0,0),
    // safely past the 22px radius of the instance's gizmo at world (1,0,0).
    expect(controller.pickConnectorAt(W / 2, H / 2)).toEqual({
      instanceId: WORLD_BODY_ID,
      connectorId: 'w1',
    });

    controller.setWorldConnectorHidden('base', true);
    expect(gizmo.visible).toBe(false);
    expect(controller.isWorldConnectorHidden('base')).toBe(true);
    expect(controller.pickConnectorAt(W / 2, H / 2)).toBeNull();

    // Picking needs the complete set — a hidden connector shows again.
    controller.setMatePicking(true);
    expect(gizmo.visible).toBe(true);
    expect(controller.pickConnectorAt(W / 2, H / 2)).toEqual({ instanceId: WORLD_BODY_ID, connectorId: 'w1' });
    controller.setMatePicking(false);
    expect(gizmo.visible).toBe(false);

    // A re-render re-mints the id; the hide follows the name.
    controller.update(sceneObjects, { ...assembly, connectors: [{ ...worldConnector, connectorId: 'w2' }] });
    expect(controller.getWorldConnectorGroup('w1')).toBeNull();
    expect(controller.getWorldConnectorGroup('w2')!.visible).toBe(false);
    expect(controller.findWorldConnectorId('base')).toBe('w2');
    controller.setWorldConnectorHidden('base', false);
    expect(controller.getWorldConnectorGroup('w2')!.visible).toBe(true);
  });

  it('coincident gizmos are listed as candidates, nearest-first, the instance connector staying the default', () => {
    const { controller, scene, sceneObjects, assembly } = makeRig();
    // A second assembly connector exactly on the first; the instance gizmo
    // at world (1,0,0) is well outside the ambiguity band.
    controller.update(sceneObjects, { ...assembly, connectors: [worldConnector, { ...worldConnector, connectorId: 'w2', name: 'other' }] });
    scene.updateMatrixWorld(true);
    const candidates = controller.pickConnectorCandidatesAt(W / 2, H / 2);
    expect(candidates.map(c => c.connectorId)).toEqual(['w1', 'w2']);
    expect(candidates.every(c => c.instanceId === WORLD_BODY_ID)).toBe(true);
    expect(controller.pickConnectorAt(W / 2, H / 2)).toEqual({ instanceId: WORLD_BODY_ID, connectorId: 'w1' });

    // Hiding one drops it from the candidates; a lone hit is not ambiguous.
    controller.setWorldConnectorHidden('other', true);
    expect(controller.pickConnectorCandidatesAt(W / 2, H / 2).map(c => c.connectorId)).toEqual(['w1']);
  });

  it('hover highlight and mate pinning reach assembly connectors', () => {
    const { controller, sceneObjects, assembly } = makeRig();
    controller.update(sceneObjects, { ...assembly, connectors: [worldConnector] });
    const gizmo = controller.getWorldConnectorGroup('w1')!;
    controller.setMatePicking(true);
    controller.setHighlightedConnector('w1');
    expect(gizmo.children[0].userData.highlight).toBeGreaterThan(1);
    controller.setHighlightedConnector(null);
    expect(gizmo.children[0].userData.highlight).toBe(1);
    controller.setMatePicking(false);

    // A joints-panel selection of a mate on this connector keeps it visible
    // even when hidden from the rail; clearing the highlight re-hides it.
    controller.setWorldConnectorHidden('base', true);
    expect(gizmo.visible).toBe(false);
    controller.highlightMate({
      mateId: 'mate-0', type: 'fastened', status: 'satisfied',
      frameA: { connectorId: 'w1' },
      connectorB: { instanceId: 'i1', connectorId: 'c1' },
    }, 0xff0000);
    expect(gizmo.visible).toBe(true);
    controller.clearHighlight();
    expect(gizmo.visible).toBe(false);
  });

  it('hover highlight rides the gizmo scale multiplier and clears', () => {
    const { controller, connectorMesh } = makeRig();
    controller.setMatePicking(true);
    controller.setHighlightedConnector('c1');
    expect(connectorMesh.children[0].userData.highlight).toBeGreaterThan(1);
    controller.setHighlightedConnector(null);
    expect(connectorMesh.children[0].userData.highlight).toBe(1);
  });

  it('picking renders gizmos translucent; hovered and picked ones opaque', () => {
    const { controller, connectorMesh } = makeRig();
    const mat = new MeshBasicMaterial({ transparent: true, opacity: 1 });
    connectorMesh.children[0].add(new Mesh(new BoxGeometry(1, 1, 1), mat));

    controller.setMatePicking(true);
    expect(mat.opacity).toBeLessThan(1);

    controller.setHighlightedConnector('c1');
    expect(mat.opacity).toBe(1);
    controller.setHighlightedConnector(null);
    expect(mat.opacity).toBeLessThan(1);

    controller.setMatePickedConnectors([{ instanceId: 'i1', connectorId: 'c1' }]);
    expect(mat.opacity).toBe(1);
    controller.setMatePickedConnectors([]);
    expect(mat.opacity).toBeLessThan(1);

    // Disarming restores full opacity (hover-reveal shows the normal triad).
    controller.setMatePicking(false);
    expect(mat.opacity).toBe(1);
  });

  it('resolves connector names and ids for the mate dialog', () => {
    const { controller } = makeRig();
    expect(controller.getConnectorName('c1')).toBe('top');
    expect(controller.getConnectorName('nope')).toBeNull();
    expect(controller.findConnectorId('i1', 'top')).toBe('c1');
    expect(controller.findConnectorId('i1', 'missing')).toBeNull();
    expect(controller.findConnectorId('ghost', 'top')).toBeNull();
  });

  it('clearing the provisional mate restores serialized poses', () => {
    const { controller, group, sceneObjects, assembly } = makeRig();
    controller.setProvisionalMate({
      mateId: '__mate-preview__',
      type: 'fastened',
      connectorA: { instanceId: 'i1', connectorId: 'c1' },
      connectorB: { instanceId: 'i1', connectorId: 'c2' },
    });
    // Whatever the (degenerate) provisional solve did, clearing must snap
    // the group back to the serialized source-of-truth pose.
    group.position.set(5, 5, 5);
    controller.setProvisionalMate(null);
    expect(group.position.toArray()).toEqual([0, 0, 0]);
    // And a later update() keeps working.
    controller.update(sceneObjects, assembly);
  });

  it('committing the provisional mate keeps the preview poses on screen', () => {
    const { controller, group } = makeRig();
    controller.setProvisionalMate({
      mateId: '__mate-preview__',
      type: 'fastened',
      connectorA: { instanceId: 'i1', connectorId: 'c1' },
      connectorB: { instanceId: 'i1', connectorId: 'c2' },
    });
    group.position.set(5, 5, 5);
    // Apply's commit drops the record without the serialized-pose restore …
    controller.commitProvisionalMate();
    expect(group.position.toArray()).toEqual([5, 5, 5]);
    // … so the dialog exit's clear is a no-op and the poses hold until the
    // committed render re-solves with the real mate.
    controller.setProvisionalMate(null);
    expect(group.position.toArray()).toEqual([5, 5, 5]);
  });
});

// The edit dialog's preview: a provisional record carrying a COMMITTED
// mate's id must replace that mate in the solve — appending it instead
// would pit two conflicting constraints against each other and mark the
// assembly inconsistent for the whole session.
describe('provisional mate replacing a committed one', () => {
  function makeMatedRig(offset: [number, number, number]) {
    const canvas = makeCanvas();
    const renderer = { domElement: canvas } as unknown as WebGLRenderer;
    const camera = new PerspectiveCamera(50, W / H, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    const controller = new AssemblyController(renderer, camera, () => {}, () => new Raycaster());

    const partTemplate: SceneObjectRender = {
      id: 'p1', type: 'part', visible: false, sceneShapes: [], ownShapes: [],
    };
    const connectorObj: SceneObjectRender = {
      id: 'c1', type: 'connector', parentId: 'p1', name: 'top',
      object: {
        name: 'top',
        origin: { x: 0, y: 0, z: 0 },
        xDirection: { x: 1, y: 0, z: 0 },
        yDirection: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
      },
      sceneShapes: [], ownShapes: [],
    };
    const instance = (instanceId: string, grounded: boolean, x: number) => ({
      instanceId, partId: 'p1', partName: 'p1',
      position: { x, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      grounded, name: instanceId,
      sourceLocation: { filePath: '/ws/m.assembly.js', line: 4, column: 0 },
    });
    const assembly: SerializedAssembly = {
      instances: [instance('i1', true, 0), instance('i2', false, 4)],
      mates: [{
        mateId: 'mate-0',
        type: 'fastened',
        connectorA: { instanceId: 'i1', connectorId: 'c1' },
        connectorB: { instanceId: 'i2', connectorId: 'c1' },
        status: 'satisfied',
        options: { offset },
      }],
    };
    controller.update([partTemplate, connectorObj], assembly);
    return { controller, follower: controller.getInstanceGroup('i2')! };
  }

  it('solves the provisional record INSTEAD of the mate sharing its id', () => {
    // Reference: an assembly whose committed mate already has the new offset.
    const reference = makeMatedRig([0, 0, 5]).follower.position.clone();

    const { controller, follower } = makeMatedRig([0, 0, 2]);
    expect(follower.position.distanceTo(reference)).toBeGreaterThan(1);

    let lastResult = '';
    let lastFailed: string[] = [];
    controller.setSolverUpdateHandler((out) => {
      lastResult = out.result;
      lastFailed = out.failed;
    });
    controller.setProvisionalMate({
      mateId: 'mate-0',
      type: 'fastened',
      connectorA: { instanceId: 'i1', connectorId: 'c1' },
      connectorB: { instanceId: 'i2', connectorId: 'c1' },
      options: { offset: [0, 0, 5] },
    });

    // A clean solve landing on the reference pose — an appended (not
    // replaced) record would fight the committed offset instead.
    expect(lastResult).toBe('okay');
    expect(lastFailed).toEqual([]);
    expect(follower.position.distanceTo(reference)).toBeLessThan(1e-6);
  });
});
