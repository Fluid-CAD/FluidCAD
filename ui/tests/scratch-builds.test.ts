import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScratchBuilds, type ScratchBuildMeshes } from '../src/ui/scratch-build/scratch-builds';
import type { PartThumbnailRenderer } from '../src/ui/insert-part/part-thumbnails';

// The page's side of scratch builds: the two routes, and which of the
// thumbnail renderer's entries draws a build's meshes.

function answer(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const MESHES: ScratchBuildMeshes = {
  id: '0b0e7d0c-5f0e-4c58-9d55-0f3f1a1c2d3e',
  file: '/ws/block.part.js',
  sceneKind: 'part',
  unit: 'mm',
  objects: [{ id: 'part-1', sceneShapes: [], ownShapes: [] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ScratchBuilds', () => {
  it('posts a candidate and answers the outcome, a failed candidate included', async () => {
    const fetched = vi.fn(async () => answer(200, { state: 'compile-error', file: '/ws/block.part.js', durationMs: 2, compileError: { message: 'Unexpected token' } }));
    vi.stubGlobal('fetch', fetched);
    const outcome = await ScratchBuilds.build({ file: '/ws/block.part.js', source: 'const = ;', params: { Height: 10 } });
    expect(outcome).toMatchObject({ state: 'compile-error', compileError: { message: 'Unexpected token' } });
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('api/scratch-build');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ file: '/ws/block.part.js', source: 'const = ;', params: { Height: 10 } });
  });

  it('answers a refusal as its error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(403, { error: 'Path is outside the workspace: /etc/passwd' })));
    expect(await ScratchBuilds.build({ file: '/etc/passwd' })).toEqual({ error: 'Path is outside the workspace: /etc/passwd' });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Failed to fetch');
    }));
    expect(await ScratchBuilds.build({ file: '/ws/block.part.js' })).toEqual({ error: 'Failed to fetch' });
  });

  it('fetches a build\'s meshes by id, and null once the engine let them go', async () => {
    const fetched = vi.fn(async () => answer(200, MESHES));
    vi.stubGlobal('fetch', fetched);
    expect(await ScratchBuilds.meshes(MESHES.id)).toEqual(MESHES);
    expect((fetched.mock.calls[0] as unknown as [string])[0]).toBe(`api/scratch-build/${MESHES.id}/meshes`);

    vi.stubGlobal('fetch', vi.fn(async () => answer(404, { error: 'No such scratch build' })));
    expect(await ScratchBuilds.meshes(MESHES.id)).toBeNull();
  });

  it('draws a model as the whole scene and an assembly posed by its instances', () => {
    const renderer = {
      renderScene: vi.fn(() => 'data:scene'),
      renderAssembly: vi.fn(() => 'data:assembly'),
    };
    expect(ScratchBuilds.thumbnail(renderer as unknown as PartThumbnailRenderer, MESHES)).toBe('data:scene');
    expect(renderer.renderScene).toHaveBeenCalledWith(MESHES.objects);

    const assembly = { instances: [], mates: [], connectors: [] };
    expect(ScratchBuilds.thumbnail(renderer as unknown as PartThumbnailRenderer, { ...MESHES, sceneKind: 'assembly', assembly })).toBe('data:assembly');
    expect(renderer.renderAssembly).toHaveBeenCalledWith(MESHES.objects, [], [], []);
  });
});
