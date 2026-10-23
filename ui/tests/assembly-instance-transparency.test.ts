// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import type { SceneObjectRender, SerializedAssembly, SerializedAssemblyInstance } from '../src/types';

// `.transparent(v)` in the assembly view: the payload's per-instance value
// fades that instance's faces and edges (never its connector gizmos, never
// another instance of the same part), the parts panel's slider previews it
// live, and a render that changed nothing but display state leaves every
// part where it is on screen — a hand-rotated mated part included.

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

function makeController(): AssemblyController {
  const renderer = { domElement: makeCanvas() } as unknown as WebGLRenderer;
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  const controller = new AssemblyController(renderer, camera, () => {}, (x, y) => {
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(x, y), camera);
    return raycaster;
  });
  new Scene().add(controller.getContainer());
  return controller;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function instance(id: string, partId: string, extra: Partial<SerializedAssemblyInstance> = {}): SerializedAssemblyInstance {
  return {
    instanceId: id, partId, partName: partId, name: id,
    position: { x: 0, y: 0, z: 0 }, quaternion: IDENTITY, grounded: false,
    ...extra,
  };
}

/** A visible part with one solid: one face triangle and one edge line, built by the real mesh factory. */
function solidPart(partId: string): SceneObjectRender[] {
  return [
    { id: partId, type: 'part', visible: true, sceneShapes: [], ownShapes: [] } as SceneObjectRender,
    {
      id: `${partId}-body`, type: 'extrude', parentId: partId, visible: true, ownShapes: [],
      sceneShapes: [{
        shapeId: `${partId}-solid`, shapeType: 'solid',
        meshes: [
          { label: 'solid-faces', vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], faceMapping: [0] },
          { label: 'solid-edges', vertices: [0, 0, 0, 10, 0, 0], normals: [], indices: [0, 1], edgeIndex: 0 },
        ],
      }],
    } as unknown as SceneObjectRender,
  ];
}

function materialsOf(root: Object3D): Material[] {
  const out: Material[] = [];
  root.traverse((o) => {
    if (o.userData?.isConnector) {
      return;
    }
    const m = (o as Mesh).material;
    if (m) {
      out.push(...(Array.isArray(m) ? m : [m]));
    }
  });
  return out;
}

describe('instance transparency in the assembly view', () => {
  it('fades the instance it is set on, faces and edges alike, and nothing else', () => {
    const controller = makeController();
    controller.update(solidPart('p1'), {
      instances: [instance('a', 'p1', { transparency: 0.6 }), instance('b', 'p1')],
      mates: [],
    });

    const faded = materialsOf(controller.getInstanceGroup('a')!);
    expect(faded.length).toBeGreaterThanOrEqual(2);
    for (const m of faded) {
      expect(m.opacity).toBeCloseTo(0.4, 9);
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
    }
    // Another instance of the same part has materials of its own.
    for (const m of materialsOf(controller.getInstanceGroup('b')!)) {
      expect(m.opacity).toBe(1);
      expect(m.transparent).toBe(false);
      expect(m.depthWrite).toBe(true);
    }
  });

  it('a later render back to opaque restores the materials exactly', () => {
    const controller = makeController();
    const objects = solidPart('p1');
    controller.update(objects, { instances: [instance('a', 'p1', { transparency: 0.5 })], mates: [] });
    controller.update(objects, { instances: [instance('a', 'p1')], mates: [] });
    for (const m of materialsOf(controller.getInstanceGroup('a')!)) {
      expect(m.opacity).toBe(1);
      expect(m.transparent).toBe(false);
      expect(m.depthWrite).toBe(true);
    }
  });

  it('leaves connector gizmos to the mate picker', () => {
    const controller = makeController();
    controller.update(solidPart('p1'), { instances: [instance('a', 'p1')], mates: [] });
    const group = controller.getInstanceGroup('a')!;
    const gizmo = new Group();
    gizmo.userData.isConnector = true;
    const gizmoMaterial = new MeshBasicMaterial();
    gizmo.add(new Mesh(undefined, gizmoMaterial));
    group.add(gizmo);

    controller.previewInstanceTransparency('a', 0.7);
    expect(gizmoMaterial.opacity).toBe(1);
    expect(gizmoMaterial.transparent).toBe(false);
  });

  it('the slider preview shows over the payload; ending it without a write shows the source value again', () => {
    const controller = makeController();
    const objects = solidPart('p1');
    controller.update(objects, { instances: [instance('a', 'p1', { transparency: 0.2 })], mates: [] });

    controller.previewInstanceTransparency('a', 0.9);
    expect(controller.getInstanceTransparency('a')).toBeCloseTo(0.9, 9);
    expect(materialsOf(controller.getInstanceGroup('a')!)[0].opacity).toBeCloseTo(0.1, 9);

    // A render landing mid-drag keeps the slider's value.
    controller.update(objects, { instances: [instance('a', 'p1', { transparency: 0.2 })], mates: [] });
    expect(materialsOf(controller.getInstanceGroup('a')!)[0].opacity).toBeCloseTo(0.1, 9);

    controller.endInstanceTransparencyPreview('a', false);
    expect(controller.getInstanceTransparency('a')).toBeCloseTo(0.2, 9);
    expect(materialsOf(controller.getInstanceGroup('a')!)[0].opacity).toBeCloseTo(0.8, 9);
  });

  it('a written preview stays up until the next render brings the statement value', () => {
    const controller = makeController();
    const objects = solidPart('p1');
    controller.update(objects, { instances: [instance('a', 'p1')], mates: [] });

    controller.previewInstanceTransparency('a', 0.5);
    controller.endInstanceTransparencyPreview('a', true);
    // No flash back to opaque while the write's render is in flight.
    expect(materialsOf(controller.getInstanceGroup('a')!)[0].opacity).toBeCloseTo(0.5, 9);

    controller.update(objects, { instances: [instance('a', 'p1', { transparency: 0.3 })], mates: [] });
    expect(controller.getInstanceTransparency('a')).toBeCloseTo(0.3, 9);
  });

  it('a rebuilt group keeps the eye toggle', () => {
    const controller = makeController();
    const objects = solidPart('p1');
    controller.update(objects, { instances: [instance('a', 'p1')], mates: [] });
    controller.setInstanceVisible('a', false);
    // Part ids re-mint every assembly render — the rebuild path.
    const remint = objects.map(o => ({ ...o, id: o.id!.replace('p1', 'p1x'), parentId: o.parentId?.replace('p1', 'p1x') }));
    controller.update(remint as SceneObjectRender[], { instances: [instance('a', 'p1x', { transparency: 0.5 })], mates: [] });
    expect(controller.isInstanceVisible('a')).toBe(false);
  });
});

describe('a transparency-only render keeps every pose on screen', () => {
  function connector(id: string, parentId: string, name: string, normalZ: 1 | -1): SceneObjectRender {
    return {
      id, type: 'connector', parentId, name, sceneShapes: [], ownShapes: [],
      object: {
        name,
        origin: { x: 0, y: 0, z: 0 },
        xDirection: { x: 1, y: 0, z: 0 },
        yDirection: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: normalZ },
      },
    } as SceneObjectRender;
  }

  /**
   * One render's payload: a grounded base and an arm on a revolute mate.
   * `epoch` re-mints every scene id like a real assembly render does.
   */
  function render(epoch: number, arm: Partial<SerializedAssemblyInstance> = {}, basePosition = { x: 0, y: 0, z: 0 }) {
    const base = `base-${epoch}`;
    const link = `link-${epoch}`;
    const objects: SceneObjectRender[] = [
      { id: base, type: 'part', visible: false, sceneShapes: [], ownShapes: [] } as SceneObjectRender,
      { id: link, type: 'part', visible: false, sceneShapes: [], ownShapes: [] } as SceneObjectRender,
      // Face to face, like a real hinge: the arm rests at identity.
      connector(`axis-${epoch}`, base, 'axis', 1),
      connector(`pivot-${epoch}`, link, 'pivot', -1),
    ];
    const assembly: SerializedAssembly = {
      instances: [
        { ...instance('i0', base, { grounded: true, position: basePosition }), partName: 'Base' },
        { ...instance('i1', link, arm), partName: 'Arm' },
      ],
      mates: [{
        mateId: 'mate-0', type: 'revolute', status: 'satisfied',
        connectorA: { instanceId: 'i1', connectorId: `pivot-${epoch}` },
        connectorB: { instanceId: 'i0', connectorId: `axis-${epoch}` },
      }],
    };
    return { objects, assembly };
  }

  function armPose(controller: AssemblyController): { position: Vector3; quaternion: Quaternion } {
    const group = controller.getInstanceGroup('i1')!;
    return { position: group.position.clone(), quaternion: group.quaternion.clone() };
  }

  /** Settle on the initial render, then turn the arm on its hinge the way the Animate bar / a drag does: live only. */
  function turnedArm() {
    const controller = makeController();
    const first = render(1);
    controller.update(first.objects, first.assembly);
    const rest = armPose(controller);
    expect(rest.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-9);
    expect(controller.driveMateValue('mate-0', 45)).not.toBeNull();
    const turned = armPose(controller);
    // Nothing is written back: the arm's statement keeps its warm-start pose.
    expect(turned.quaternion.angleTo(rest.quaternion)).toBeCloseTo(Math.PI / 4, 6);
    return { controller, rest, turned };
  }

  it('the hand-turned arm stays turned through the `.transparent()` re-render', () => {
    const { controller, turned } = turnedArm();

    const second = render(2, { transparency: 0.5 });
    controller.update(second.objects, second.assembly);
    expect(armPose(controller).quaternion.angleTo(turned.quaternion)).toBeLessThan(1e-9);
    expect(armPose(controller).position.distanceTo(turned.position)).toBeLessThan(1e-9);
    expect(controller.getInstanceTransparency('i1')).toBe(0.5);

    // A name change is display state too.
    const third = render(3, { transparency: 0.5, name: 'Left arm' });
    controller.update(third.objects, third.assembly);
    expect(armPose(controller).quaternion.angleTo(turned.quaternion)).toBeLessThan(1e-9);
  });

  it('a render that changes a pose input still re-syncs to the statements', () => {
    const { controller, rest } = turnedArm();

    const moved = render(2, { transparency: 0.5 }, { x: 5, y: 0, z: 0 });
    controller.update(moved.objects, moved.assembly);
    expect(armPose(controller).quaternion.angleTo(rest.quaternion)).toBeLessThan(1e-6);
    expect(armPose(controller).position.x).toBeCloseTo(rest.position.x + 5, 9);
  });
});
