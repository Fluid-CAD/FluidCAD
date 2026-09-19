// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubleSide, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Plane, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, type WebGLRenderer } from 'three';
import { VertexPicking } from '../src/interactive/vertex-picking';
import { Viewer } from '../src/viewer';
import { collectPickCandidates } from '../src/interactive/pick-candidates';
import { pointIsVisible } from '../src/interactive/pick-visibility';
import { entityKey, sameEntity, selectionChipRows } from '../src/helpers/entities';
import { runFrameHooks } from '../src/meshes/frame-hooks';
import { ShapeGroup } from '../src/meshes/containers/shape-group';
import type { SceneObjectRender } from '../src/types';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function setup() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 40, top: 30, width: 400, height: 400 } as DOMRect);
  const renderer = { domElement: canvas, getSize: (size: Vector2) => size.set(400, 400) } as unknown as WebGLRenderer;
  const ctx = { scene, camera, renderer, requestRender: vi.fn(), createPickingRaycaster(x: number, y: number) {
    const ray = new Raycaster(); ray.setFromCamera(new Vector2(x, y), camera); return ray;
  } };
  const visible = (Viewer.prototype as any).isPointVisible;
  const picker = new VertexPicking(ctx, (point, faces) => visible.call({ ctx }, point, faces, 1e-5));
  disposers.push(() => picker.dispose());
  return { scene, camera, renderer, picker, ctx };
}

function vertices(id: string, coordinates: number[]): Group {
  const group = new Group();
  group.userData.shapeId = id;
  group.userData.topologyVertices = coordinates;
  return group;
}

function dots(scene: Scene): Group[] {
  return scene.getObjectByName('vertex-pick-dots')!.children as Group[];
}

describe('vertex picking channel', () => {
  it('is opt-in, uses the 12 pixel grab radius and respects the canvas offset', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0]));
    expect(picker.pick(240, 230)).toBeNull();
    picker.setActive(true);
    expect(picker.pick(251, 230)).toMatchObject({ shapeId: 'a', sub: { type: 'vertex', index: 0, position: { x: 0, y: 0, z: 0 } } });
    expect(picker.pick(253, 230)).toBeNull();
    picker.setActive(false);
    expect(picker.pick(240, 230)).toBeNull();
  });

  it('scopes candidate dots and picks, with [] meaning no candidates', () => {
    const { scene, picker, renderer, camera } = setup();
    scene.add(vertices('a', [0, 0, 0]), vertices('b', [1, 0, 0]));
    picker.setActive(true);
    picker.setScope(['b']);
    runFrameHooks(renderer, camera);
    expect(dots(scene)).toHaveLength(1);
    expect(picker.pick(240, 230)).toBeNull();
    picker.setScope([]);
    picker.refresh();
    expect(dots(scene)).toHaveLength(0);
    picker.setScope(null);
    picker.refresh();
    expect(dots(scene)).toHaveLength(2);
  });

  it('collapses coincident edge endpoints and reports their alternate identities', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0, 1, 0, 0]), vertices('b', [0, 0, 0, 0, 1, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(dots(scene)).toHaveLength(3);
    const pick = picker.pick(240, 230)!;
    expect(pick.sub.alternates).toEqual([{ shapeId: 'b', index: 0, instanceId: null }]);
    picker.setSelected([{ shapeId: 'b', sub: { type: 'vertex', index: 0 } }]);
    picker.refresh();
    expect(dots(scene).filter(dot => dot.userData.vertexState === 'selected')).toHaveLength(1);
  });

  it('merges coincident positions even when they straddle spatial cell boundaries', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0.999e-6, 0, 0]), vertices('b', [1.001e-6, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(dots(scene)).toHaveLength(1);
    expect(picker.pick(240, 230)?.sub.alternates).toHaveLength(1);
  });

  it('ignores clipped vertices and does not let a clipped face occlude a point behind it', () => {
    const { scene, picker } = setup();
    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ side: DoubleSide,
      clippingPlanes: [new Plane(new Vector3(1, 0, 0), -1)],
    }));
    wall.position.z = 2;
    wall.userData.faceMapping = [0, 0];
    wall.userData.shapeId = 'wall';
    wall.userData.topologyVertices = [0, 0, 0];
    scene.add(wall, vertices('behind', [0, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(dots(scene)).toHaveLength(1);
    expect(picker.pick(240, 230)?.shapeId).toBe('behind');
  });

  it('routes the viewer vertex channel into the shared picker', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0]));
    picker.setActive(true);
    expect((Viewer.prototype as any).pickAt.call({ pickFilter: 'vertex', vertexPicking: picker }, 240, 230))
      .toMatchObject({ shapeId: 'a', sub: { type: 'vertex', index: 0 } });
  });

  it('shows muted, hover and selected markers, and clears them with selection state', () => {
    const { scene, picker, renderer, camera } = setup();
    const drawMarker = () => {
      const dot = dots(scene)[0].children[0] as Mesh;
      dot.onBeforeRender(renderer, scene, camera, dot.geometry, dot.material as MeshBasicMaterial, null);
    };
    scene.add(vertices('a', [0, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    drawMarker();
    expect(dots(scene)[0].userData.vertexState).toBe('candidate');
    const candidateScale = dots(scene)[0].scale.x;
    const pick = picker.pick(240, 230)!;
    picker.setHover(pick);
    picker.refresh();
    drawMarker();
    expect(dots(scene)[0].userData.vertexState).toBe('hover');
    expect(dots(scene)[0].scale.x).toBeGreaterThan(candidateScale);
    picker.setSelected([pick]);
    picker.setActive(false);
    picker.refresh();
    expect(dots(scene)[0].userData.vertexState).toBe('selected');
    picker.setSelected([]);
    picker.refresh();
    expect(dots(scene)).toHaveLength(0);
  });

  it('does not draw or pick vertices occluded by faces, behind the camera or in hidden ancestors', () => {
    const { scene, picker } = setup();
    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ side: DoubleSide }));
    wall.position.z = 2;
    wall.userData.faceMapping = [0, 0];
    const hidden = new Group(); hidden.visible = false;
    hidden.add(vertices('hidden', [0, 0, 3]));
    scene.add(wall, hidden, vertices('back', [0, 0, 0]), vertices('behind-eye', [0, 0, 20]));
    picker.setActive(true);
    picker.refresh();
    expect(dots(scene)).toHaveLength(0);
    expect(picker.pick(240, 230)).toBeNull();
    wall.visible = false;
    picker.refresh();
    expect(dots(scene)).toHaveLength(1);
    expect(picker.pick(240, 230)?.shapeId).toBe('back');
  });

  it('reuses the visibility answer until the camera, the candidates or an occluder change', () => {
    const { scene, camera, ctx } = setup();
    const visible = (Viewer.prototype as any).isPointVisible;
    const isVisible = vi.fn((point: Vector3, faces: any[]) => visible.call({ ctx }, point, faces, 1e-5));
    const picker = new VertexPicking(ctx, isVisible);
    disposers.push(() => picker.dispose());
    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ side: DoubleSide }));
    wall.position.z = -2;
    wall.userData.faceMapping = [0, 0];
    const shape = vertices('a', [0, 0, 0, 1, 0, 0]);
    scene.add(wall, shape);
    picker.setActive(true);

    // A pointer move is a pick followed by the hover repaint: one sight line per vertex, not two.
    picker.pick(240, 230);
    picker.refresh();
    picker.pick(250, 230);
    expect(isVisible).toHaveBeenCalledTimes(2);

    camera.position.x = 0.5;
    camera.updateMatrixWorld(true);
    picker.refresh();
    expect(isVisible).toHaveBeenCalledTimes(4);

    wall.position.z = -3;
    picker.refresh();
    expect(isVisible).toHaveBeenCalledTimes(6);

    shape.userData.topologyVertices = [0, 0, 0];
    picker.refresh();
    expect(isVisible).toHaveBeenCalledTimes(7);

    picker.refresh();
    expect(isVisible).toHaveBeenCalledTimes(7);
  });

  it('shares one sight-line test with edge picking: a clipped face never occludes', () => {
    const { camera, ctx } = setup();
    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial({ side: DoubleSide }));
    wall.position.z = 2;
    wall.updateMatrixWorld(true);
    const point = new Vector3(0, 0, 0);
    const test = () => pointIsVisible(point, [wall], 1e-5, camera, (x, y) => ctx.createPickingRaycaster(x, y));
    expect(test()).toBe(false);
    // The section plane removes everything with z > 1 — the wall included.
    (wall.material as MeshBasicMaterial).clippingPlanes = [new Plane(new Vector3(0, 0, -1), 1)];
    expect(test()).toBe(true);
  });

  it('retains assembly instance identity and updates positions when an instance moves', () => {
    const { scene, picker } = setup();
    const instance = new Group(); instance.userData.instanceId = 'occurrence';
    instance.add(vertices('shared-shape', [0, 0, 0]));
    scene.add(instance);
    picker.setActive(true);
    const pick = picker.pick(240, 230)!;
    expect(pick.instanceId).toBe('occurrence');
    picker.setSelected([pick]);
    instance.position.x = 1;
    picker.refresh();
    expect(dots(scene)[0].position.x).toBe(1);
    expect(dots(scene)[0].userData.vertexState).toBe('selected');
    expect(picker.pick(240, 230)).toBeNull();
  });

  it('refreshes dots when geometry disappears and unregisters its frame hook on disposal', () => {
    const { scene, picker, renderer, camera } = setup();
    const shape = vertices('a', [0, 0, 0]); scene.add(shape);
    picker.setActive(true);
    picker.refresh();
    shape.removeFromParent();
    runFrameHooks(renderer, camera);
    expect(dots(scene)).toHaveLength(0);
    picker.dispose();
    expect(() => runFrameHooks(renderer, camera)).not.toThrow();
    expect(scene.getObjectByName('vertex-pick-dots')).toBeUndefined();
  });

  it('carries topology positions through ShapeGroup and ignores them in ordinary picking', () => {
    const { scene } = setup();
    const object = { id: 'object', type: 'line', ownShapes: [], sceneShapes: [{
      shapeId: 'edge', shapeType: 'edge', vertices: [0, 0, 0, 1, 0, 0],
      meshes: [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }],
    }] } as SceneObjectRender;
    scene.add(new ShapeGroup(object, false));
    const channels = { sketchWires: false, profileWires: false, axes: false, planes: false };
    expect(collectPickCandidates(scene, channels).vertices).toHaveLength(0);
    expect(collectPickCandidates(scene, { ...channels, vertices: true }).vertices).toHaveLength(2);
    expect(collectPickCandidates(scene, channels).edges).toHaveLength(1);
  });

  it('uses the existing entity identity and chip helpers for vertices', () => {
    const a = { shapeId: 'a', sub: { type: 'vertex' as const, index: 2 }, instanceId: 'one' };
    expect(entityKey(a)).toBe('a:vertex:2@one');
    expect(sameEntity(a, { ...a })).toBe(true);
    expect(sameEntity(a, { ...a, instanceId: 'two' })).toBe(false);
    expect(selectionChipRows([a], [])).toEqual([{ label: 'Vertex', members: [a] }]);
  });
});
