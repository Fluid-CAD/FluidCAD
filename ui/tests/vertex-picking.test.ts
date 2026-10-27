// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubleSide, Group, Mesh, MeshBasicMaterial, type Object3D, PerspectiveCamera, Plane, PlaneGeometry, Raycaster, Scene, Vector2, Vector3, type WebGLRenderer } from 'three';
import { VertexPicking } from '../src/interactive/vertex-picking';
import type { OcclusionMap, PointOcclusion } from '../src/interactive/occluder-depth';
import { Viewer } from '../src/viewer';
import { collectPickCandidates } from '../src/interactive/pick-candidates';
import { pointIsVisible } from '../src/interactive/pick-visibility';
import { entityKey, sameEntity, selectionChipRows } from '../src/helpers/entities';
import { runFrameHooks } from '../src/meshes/frame-hooks';
import { ShapeGroup } from '../src/meshes/containers/shape-group';
import { FeatureGhostOverlay } from '../src/interactive/create-feature/feature-ghost';
import { themeColors } from '../src/scene/theme-colors';
import type { SceneObjectRender } from '../src/types';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

/**
 * The occlusion as the exact sight line decides it, in place of the GPU map
 * jsdom can't draw: it records what the picker hands it, so the tests can
 * see which faces occlude and how many points a pick asks about.
 */
class SightLineOcclusion implements PointOcclusion {
  readonly updates: (readonly Object3D[])[] = [];
  readonly asked: number[] = [];
  released = 0;
  disposed = 0;
  constructor(private readonly ctx: { camera: PerspectiveCamera; createPickingRaycaster(x: number, y: number): Raycaster }) {}
  update(occluders: readonly Object3D[]): OcclusionMap | null {
    this.updates.push(occluders);
    return null;
  }
  visible(points: readonly { x: number; y: number; z: number }[], occluders: readonly Object3D[]): boolean[] {
    this.asked.push(points.length);
    return points.map(p => pointIsVisible(new Vector3(p.x, p.y, p.z), [...occluders], 1e-5, this.ctx.camera,
      (x, y) => this.ctx.createPickingRaycaster(x, y)));
  }
  release(): void { this.released++; }
  dispose(): void { this.disposed++; }
}

function setup() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 40, top: 30, width: 400, height: 400 } as DOMRect);
  const renderer = {
    domElement: canvas,
    getSize: (size: Vector2) => size.set(400, 400),
    getDrawingBufferSize: (size: Vector2) => size.set(800, 800),
    getPixelRatio: () => 2,
  } as unknown as WebGLRenderer;
  const ctx = { scene, camera, renderer, requestRender: vi.fn(), createPickingRaycaster(x: number, y: number) {
    const ray = new Raycaster(); ray.setFromCamera(new Vector2(x, y), camera); return ray;
  } };
  const occlusion = new SightLineOcclusion(ctx);
  const picker = new VertexPicking(ctx, () => [], occlusion);
  disposers.push(() => picker.dispose());
  return { scene, camera, renderer, picker, ctx, occlusion };
}

function vertices(id: string, coordinates: number[]): Group {
  const group = new Group();
  group.userData.shapeId = id;
  group.userData.topologyVertices = coordinates;
  return group;
}

function wallAt(z: number, material = new MeshBasicMaterial({ side: DoubleSide })): Mesh {
  const wall = new Mesh(new PlaneGeometry(4, 4), material);
  wall.position.z = z;
  wall.userData.faceMapping = [0, 0];
  return wall;
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
    expect(picker.drawnDots).toHaveLength(1);
    expect(picker.pick(240, 230)).toBeNull();
    picker.setScope([]);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(0);
    picker.setScope(null);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(2);
  });

  it('collapses coincident edge endpoints and reports their alternate identities', () => {
    const { picker, scene } = setup();
    scene.add(vertices('a', [0, 0, 0, 1, 0, 0]), vertices('b', [0, 0, 0, 0, 1, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(3);
    const pick = picker.pick(240, 230)!;
    expect(pick.sub.alternates).toEqual([{ shapeId: 'b', index: 0, instanceId: null }]);
    picker.setSelected([{ shapeId: 'b', sub: { type: 'vertex', index: 0 } }]);
    picker.refresh();
    expect(picker.drawnDots.filter(dot => dot.color === themeColors.vertexSelectedColor)).toHaveLength(1);
  });

  it('restricts individual topology vertices and rebuilds the candidates when the scope changes', () => {
    const { scene, picker } = setup();
    scene.add(vertices('body', [0, 0, 0, 1, 0, 0, 2, 0, 0]));
    picker.setActive(true);
    picker.setScope([{ shapeId: 'body', indices: [0] }, { shapeId: 'body', indices: [1] }]);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(2);
    expect(picker.pick(240, 230)?.sub.index).toBe(0);
    picker.setScope([{ shapeId: 'body', indices: [2] }]);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(1);
    expect(picker.pick(240, 230)).toBeNull();
    picker.setScope(['body']);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(3);
  });

  it('dims completed selections while a different vertex is emphasized', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0, 1, 0, 0]));
    const selected = [0, 1].map(index => ({ shapeId: 'a', sub: { type: 'vertex' as const, index } }));
    picker.setSelected(selected);
    picker.setEmphasized([selected[1]]);
    picker.refresh();
    expect(picker.drawnDots.map(dot => dot.opacity)).toEqual([0.6, 1]);
    picker.setEmphasized(null);
    picker.refresh();
    expect(picker.drawnDots.map(dot => dot.opacity)).toEqual([1, 1]);
  });

  it('replaces sketch endpoint dots while armed, follows ones added later, and restores their prior visibility', () => {
    const { scene, picker } = setup();
    const shown = new Group();
    const hidden = new Group();
    shown.userData.isVertexDot = hidden.userData.isVertexDot = true;
    hidden.visible = false;
    scene.add(shown, hidden);
    picker.setActive(true);
    expect(shown.visible).toBe(false);
    // The per-frame walk sees only the visible scene: a dot it already hid stays hidden, a new one is hidden too.
    const later = new Group();
    later.userData.isVertexDot = true;
    scene.add(later);
    picker.refresh();
    expect(shown.visible).toBe(false);
    expect(later.visible).toBe(false);
    // Removed from the scene while hidden: handed back.
    later.removeFromParent();
    picker.refresh();
    expect(later.visible).toBe(true);
    picker.setActive(false);
    expect(shown.visible).toBe(true);
    expect(hidden.visible).toBe(false);
    picker.setActive(true);
    picker.dispose();
    expect(shown.visible).toBe(true);
  });

  it('merges coincident positions even when they straddle spatial cell boundaries', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0.999e-6, 0, 0]), vertices('b', [1.001e-6, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(1);
    expect(picker.pick(240, 230)?.sub.alternates).toHaveLength(1);
  });

  it('ignores clipped vertices and hands clipped faces to the occlusion, which never lets them occlude', () => {
    const { scene, picker, occlusion } = setup();
    const wall = wallAt(2, new MeshBasicMaterial({ side: DoubleSide, clippingPlanes: [new Plane(new Vector3(1, 0, 0), -1)] }));
    wall.userData.shapeId = 'wall';
    wall.userData.topologyVertices = [0, 0, 0];
    scene.add(wall, vertices('behind', [0, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(1);
    expect(occlusion.updates.at(-1)).toEqual([wall]);
    expect(picker.pick(240, 230)?.shapeId).toBe('behind');
  });

  it('routes the viewer vertex channel into the shared picker', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0]));
    picker.setActive(true);
    expect((Viewer.prototype as any).pickAt.call({ pickFilter: 'vertex', vertexPicking: picker }, 240, 230))
      .toMatchObject({ shapeId: 'a', sub: { type: 'vertex', index: 0 } });
  });

  it('draws candidate, hover and selected dots at their sizes and colours, highlighted ones last, and clears them with selection state', () => {
    const { scene, picker } = setup();
    scene.add(vertices('a', [0, 0, 0, 1, 0, 0]));
    picker.setActive(true);
    picker.refresh();
    expect(picker.drawnDots.map(dot => dot.radiusPx)).toEqual([2.5, 2.5]);
    const pick = picker.pick(240, 230)!;
    picker.setHover(pick);
    picker.refresh();
    expect(picker.drawnDots.at(-1)).toMatchObject({ radiusPx: 4.5, color: themeColors.vertexHoverColor, position: { x: 0 } });
    picker.setSelected([pick]);
    picker.setActive(false);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(1);
    expect(picker.drawnDots[0]).toMatchObject({ radiusPx: 3.5, color: themeColors.vertexSelectedColor });
    picker.setSelected([]);
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(0);
  });

  it('frees the occlusion map while no dot is drawn', () => {
    const { scene, picker, occlusion } = setup();
    scene.add(vertices('a', [0, 0, 0]));
    picker.refresh();
    expect(occlusion.updates).toHaveLength(0);
    expect(occlusion.released).toBe(1);
    picker.setActive(true);
    picker.refresh();
    expect(occlusion.updates).toHaveLength(1);
    picker.setActive(false);
    picker.refresh();
    expect(occlusion.released).toBe(2);
  });

  it('does not pick vertices occluded by faces, behind the camera or in hidden ancestors, and never draws hidden ones', () => {
    const { scene, picker, occlusion } = setup();
    const wall = wallAt(2);
    const hidden = new Group(); hidden.visible = false;
    hidden.add(vertices('hidden', [0, 0, 3]));
    scene.add(wall, hidden, vertices('back', [0, 0, 0]), vertices('behind-eye', [0, 0, 20]));
    picker.setActive(true);
    picker.refresh();
    // Occlusion and the eye plane are the shader's to decide; a hidden shape is no candidate at all.
    expect(picker.drawnDots.map(dot => dot.position.z)).toEqual([0, 20]);
    expect(occlusion.updates.at(-1)).toEqual([wall]);
    expect(picker.pick(240, 230)).toBeNull();
    wall.visible = false;
    picker.refresh();
    expect(occlusion.updates.at(-1)).toEqual([]);
    expect(picker.pick(240, 230)?.shapeId).toBe('back');
  });

  it('keeps profile vertices pickable through a feature ghost while real solids still occlude them', () => {
    const { scene, picker, ctx, occlusion } = setup();
    scene.add(vertices('middle-profile', [0, 0, 0]));
    picker.setActive(true);
    picker.setScope(['middle-profile']);
    expect(picker.pick(240, 230)?.shapeId).toBe('middle-profile');

    // A preview wall lies in front of the middle profile, as a twisted
    // loft ghost does when editing the rolled-back sketches at a breakpoint.
    const ghost = new FeatureGhostOverlay({ sceneContext: ctx } as unknown as Viewer);
    disposers.push(() => ghost.clear());
    ghost.set([{ meshes: [{
      label: 'solid-faces', vertices: [-2, -2, 2, 2, -2, 2, 2, 2, 2, -2, 2, 2],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2, 0, 2, 3], faceMapping: [0, 0],
    }, {
      label: 'solid-edges', vertices: [-2, -2, 2, 2, -2, 2],
      normals: [], indices: [0, 1], edgeIndex: 0,
    }] }], 'add');
    expect(picker.pick(240, 230)?.shapeId).toBe('middle-profile');
    picker.refresh();
    expect(picker.drawnDots).toHaveLength(1);
    expect(occlusion.updates.at(-1)).toEqual([]);

    const candidates = collectPickCandidates(scene, {
      sketchWires: false, profileWires: false, axes: false, planes: false,
    });
    expect(candidates.faces).toHaveLength(0);
    expect(candidates.edges).toHaveLength(0);

    const solid = wallAt(3);
    scene.add(solid);
    expect(picker.pick(240, 230)).toBeNull();
    picker.refresh();
    expect(occlusion.updates.at(-1)).toEqual([solid]);
    solid.visible = false;
    expect(picker.pick(240, 230)?.shapeId).toBe('middle-profile');
    disposers.push(() => {
      solid.geometry.dispose();
      (solid.material as MeshBasicMaterial).dispose();
    });
  });

  it('collects and merges the candidates only when a source, its placement, its clipping or the scope changes', () => {
    const { scene, camera, picker } = setup();
    const merge = vi.spyOn(picker as unknown as { mergeCandidates: () => unknown }, 'mergeCandidates');
    const shape = vertices('a', [0, 0, 0, 1, 0, 0]);
    const material = new MeshBasicMaterial();
    const face = new Mesh(new PlaneGeometry(1, 1), material);
    shape.add(face);
    scene.add(shape);
    picker.setActive(true);

    picker.refresh();
    picker.pick(240, 230);
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(1);

    // The camera alone: the shader and the pick take it from here.
    camera.position.x = 0.5;
    camera.updateMatrixWorld(true);
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(1);

    shape.position.z = -1;
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(2);

    material.clippingPlanes = [new Plane(new Vector3(0, 0, 1), 5)];
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(3);

    shape.userData.topologyVertices = [0, 0, 0];
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(4);

    picker.setScope(['a']);
    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(5);

    picker.refresh();
    expect(merge).toHaveBeenCalledTimes(5);
  });

  it('asks the occlusion only about the candidates under the cursor', () => {
    const { scene, picker, occlusion } = setup();
    // 400 vertices 0.1 apart (about 4 px here), so a dozen or so lie within the 12 px radius.
    const many: number[] = [];
    for (let i = 0; i < 400; i++) {
      many.push(-1 + (i % 20) * 0.1, -1 + Math.floor(i / 20) * 0.1, 0);
    }
    scene.add(vertices('grid', many));
    picker.setActive(true);
    expect(picker.pick(240, 230)?.sub.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(occlusion.asked).toHaveLength(1);
    expect(occlusion.asked[0]).toBeGreaterThan(1);
    expect(occlusion.asked[0]).toBeLessThan(40);
    // Nothing under the cursor: the occlusion isn't asked at all.
    picker.pick(1000, 1000);
    expect(occlusion.asked).toHaveLength(1);
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
    expect(picker.drawnDots[0].position.x).toBe(1);
    expect(picker.drawnDots[0].color).toBe(themeColors.vertexSelectedColor);
    expect(picker.pick(240, 230)).toBeNull();
  });

  it('refreshes dots when geometry disappears and frees everything on disposal', () => {
    const { scene, picker, renderer, camera, occlusion } = setup();
    const shape = vertices('a', [0, 0, 0]); scene.add(shape);
    picker.setActive(true);
    picker.refresh();
    shape.removeFromParent();
    runFrameHooks(renderer, camera);
    expect(picker.drawnDots).toHaveLength(0);
    picker.dispose();
    expect(occlusion.disposed).toBe(1);
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
