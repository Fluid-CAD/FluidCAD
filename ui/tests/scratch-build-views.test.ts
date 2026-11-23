// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { ScratchBuildViews } from '../src/ui/scratch-build/scratch-build-views';
import { ScratchBuilds, type ScratchBuildMeshes } from '../src/ui/scratch-build/scratch-builds';
import type { Viewer } from '../src/viewer';

// A scratch build shown over the model on screen (a variant a chat card
// offers): which of its rows are the solids to draw, the ghost layer they go
// into, and what happens once the engine let the build go.

function answer(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const FACES = { label: 'solid-faces', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const solid = (id: string) => ({ shapeId: id, shapeType: 'solid' as const, meshes: [FACES] });

const MESHES: ScratchBuildMeshes = {
  id: 'build-1',
  file: '/ws/block.part.js',
  sceneKind: 'part',
  unit: 'mm',
  objects: [
    { id: 'part-1', sceneShapes: [], ownShapes: [] },
    { id: 'extrude-1', sceneShapes: [solid('s1'), { shapeId: 'w1', shapeType: 'wire', meshes: [FACES] }], ownShapes: [] },
    { id: 'hidden', visible: false, sceneShapes: [solid('s2')], ownShapes: [] },
    { id: 'meta', sceneShapes: [{ ...solid('s3'), isMetaShape: true }], ownShapes: [] },
    { id: 'cut-1', sceneShapes: [solid('s4')], ownShapes: [] },
  ] as unknown as ScratchBuildMeshes['objects'],
};

function viewer() {
  const scene = new Scene();
  const requestRender = vi.fn();
  return { scene, requestRender, viewer: { sceneContext: { scene, camera: null, requestRender } } as unknown as Viewer };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScratchBuildViews', () => {
  it('takes the solids of the rows on screen as what a build shows', () => {
    expect(ScratchBuildViews.solidsOf(MESHES)).toEqual([{ meshes: [FACES] }, { meshes: [FACES] }]);
    expect(ScratchBuildViews.solidsOf({ ...MESHES, objects: [] })).toEqual([]);
  });

  it('draws a build over the scene in a ghost layer of its own, one build at a time, and takes it out again', async () => {
    const fetched = vi.fn(async (url: string) => answer(200, { ...MESHES, id: url.split('/')[2] }));
    vi.stubGlobal('fetch', fetched);
    const { scene, requestRender, viewer: v } = viewer();
    const views = new ScratchBuildViews(v);
    expect(await views.showGhost('build-1')).toBe(true);
    const layer = scene.children.find((child) => child.name === 'featureGhost')!;
    // Out of the fit bounds and of every pick, like a feature dialog's ghost.
    expect(layer.userData.isMetaShape).toBe(true);
    expect(layer.children).toHaveLength(2);
    expect(requestRender).toHaveBeenCalled();

    // Another build replaces it; the first build's meshes are fetched once however often it is shown.
    expect(await views.showGhost('build-2')).toBe(true);
    expect(await views.showGhost('build-1')).toBe(true);
    expect(layer.children).toHaveLength(2);
    expect(fetched.mock.calls.map((call) => call[0])).toEqual(['api/scratch-build/build-1/meshes', 'api/scratch-build/build-2/meshes']);

    views.hideGhost();
    expect(layer.children).toHaveLength(0);
    views.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('shows nothing for a build the engine let go, an assembly, or a build without a solid', async () => {
    const { scene, viewer: v } = viewer();
    const views = new ScratchBuildViews(v);
    vi.stubGlobal('fetch', vi.fn(async () => answer(404, { error: 'No such scratch build' })));
    expect(await views.showGhost('gone')).toBe(false);
    expect(await views.picture('gone')).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { ...MESHES, sceneKind: 'assembly', assembly: { instances: [], mates: [], connectors: [] } })));
    expect(await views.showGhost('assembly')).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { ...MESHES, objects: [] })));
    expect(await views.showGhost('empty')).toBe(false);
    expect(scene.children.flatMap((child) => child.children)).toHaveLength(0);
    views.dispose();
  });

  it('a ghost asked for and taken back while its meshes load is not drawn', async () => {
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(answer(200, MESHES));
    })));
    const { scene, viewer: v } = viewer();
    const views = new ScratchBuildViews(v);
    const shown = views.showGhost('build-1');
    views.hideGhost();
    release();
    await shown;
    expect(scene.children.flatMap((child) => child.children)).toHaveLength(0);
    views.dispose();
  });

  it('draws several builds together, and leaves out the ones the engine let go', async () => {
    const fetched = vi.fn(async (url: string) => (url.includes('gone') ? answer(404, { error: 'No such scratch build' }) : answer(200, { ...MESHES, id: url.split('/')[2] })));
    vi.stubGlobal('fetch', fetched);
    const together = vi.spyOn(ScratchBuilds, 'thumbnails').mockImplementation((_renderer, builds) => builds.map((build) => `data:${build.id}`));
    const views = new ScratchBuildViews(viewer().viewer);
    // Both kept: one drawing of the two, in the order asked.
    expect(await views.pictures(['before', 'after'])).toEqual(['data:before', 'data:after']);
    expect(together).toHaveBeenCalledTimes(1);
    expect(together.mock.calls[0][1].map((build) => build.id)).toEqual(['before', 'after']);
    // One gone: the other is drawn alone, and the gone one has no picture.
    expect(await views.pictures(['gone-1', 'after'])).toEqual([null, 'data:after']);
    expect(together.mock.calls[1][1].map((build) => build.id)).toEqual(['after']);
    // None kept: nothing is drawn at all.
    expect(await views.pictures(['gone-1', 'gone-2'])).toEqual([null, null]);
    expect(together).toHaveBeenCalledTimes(2);
    // A drawing that fails is no picture, not an error.
    together.mockImplementation(() => {
      throw new Error('context lost');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await views.pictures(['before'])).toEqual([null]);
    warn.mockRestore();
    views.dispose();
    together.mockRestore();
  });
});
