// @vitest-environment jsdom
// The page's mesh cache (generators S6b, P5/P6). A scene's whole payloads
// are kept by mesh key, and a shape the server sent by reference (`meshRef`)
// gets its payload back from them before anything reads the scene — as a
// whole message would have carried it. A reference the cache lacks is
// fetched first, and the messages after that scene wait: a scene is drawn
// whole or not at all. Every object drawing a cached solid mesh — each
// instance of an assembly template, each re-render keeping the shape —
// shares one geometry, which the cache alone frees, on eviction, and never
// while something still draws it. A page that never kept a payload builds
// geometry per object, as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { MeshCache, type MeshPayload } from '../src/scene/mesh-cache';
import { SceneMeshes, type MeshLookup } from '../src/scene/scene-meshes';
import { ServerInbox } from '../src/scene/server-inbox';
import { SceneTimings } from '../src/scene/scene-timings';
import { AssemblyController } from '../src/scene/assembly-controller';
import { buildSceneMesh } from '../src/meshes/mesh-factory';
import { EdgeMesh } from '../src/meshes/shape-meshes/edge-mesh';
import { FaceMesh } from '../src/meshes/shape-meshes/face-mesh';
import { meshCache } from '../src/scene/mesh-cache';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

const loc = { filePath: '/ws/rack.assembly.js', line: 2, column: 1 };

/** A solid's payload: one face group, one edge with face sides. (9+9+3+1) + (6+3+2+6) + 9 + 3 = 51 numbers. */
function payload(seed: number): MeshPayload {
  return {
    meshes: [
      { label: 'solid-faces', vertices: [seed, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], faceMapping: [0] },
      { label: 'solid-edges', vertices: [seed, 0, 0, 1, 0, 0], normals: [0, 0, 0], indices: [0, 1], edgeIndex: 0, faceSides: [0, 1, 0, 0, 0, 1] },
    ],
    vertices: [seed, 0, 0, 1, 0, 0, 1, 1, 0],
    faceVertices: [[0, 1, 2]],
  };
}
const WEIGHT = 51;

/** A whole shape, as JSON brings it: fresh arrays every time. */
function whole(key: string, seed = 1, shapeId = `shape-${key}`): any {
  return { shapeId, shapeType: 'solid', meshKey: key, ...JSON.parse(JSON.stringify(payload(seed))) };
}

/** A shape by reference: every field but the payload's. */
function ref(key: string, shapeId = `shape-${key}`): any {
  return { shapeId, shapeType: 'solid', meshRef: key };
}

function scene(...rows: any[][]): any {
  return { type: 'scene-rendered', result: rows.map((shapes, i) => ({ id: `row-${i}`, sceneShapes: shapes })) };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Every geometry under `root`. */
function geometriesOf(root: Object3D): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (geometry) {
      out.push(geometry);
    }
  });
  return out;
}

/** How many times each geometry was really freed (three's `dispose` event). */
function countDisposals(geometries: BufferGeometry[]): Map<BufferGeometry, number> {
  const counts = new Map<BufferGeometry, number>();
  for (const geometry of geometries) {
    counts.set(geometry, 0);
    geometry.addEventListener('dispose', () => counts.set(geometry, counts.get(geometry)! + 1));
  }
  return counts;
}

afterEach(() => {
  meshCache.clear();
  meshCache.setOnScreen([]);
});

describe('resolving a scene\'s meshes', () => {
  it('keeps whole payloads and gives a referenced shape the payload held, as a whole shape carries it', () => {
    const cache = new MeshCache();
    const meshes = new SceneMeshes(cache, async () => null);
    const first = scene([whole('A')]);
    expect(meshes.prepare(first)).toMatchObject({ missing: [], refs: 0, whole: 1 });
    const canonical = first.result[0].sceneShapes[0];

    const second = scene([ref('A'), whole('B', 2)]);
    expect(meshes.prepare(second)).toMatchObject({ missing: [], refs: 1, whole: 1 });
    const resolved = second.result[0].sceneShapes[0];
    expect(resolved).toEqual(whole('A'));
    expect(resolved.meshRef).toBeUndefined();
    // The very arrays the first scene brought: one payload per key.
    expect(resolved.meshes).toBe(canonical.meshes);
    expect(resolved.vertices).toBe(canonical.vertices);

    // A whole shape of a held key takes the held arrays too.
    const third = scene([whole('A')]);
    meshes.prepare(third);
    expect(third.result[0].sceneShapes[0].meshes).toBe(canonical.meshes);
    expect(SceneMeshes.keysOf(second)).toEqual(new Set(['A', 'B']));
  });

  it('resolves a reference to a payload sent earlier in the same message, in any list', () => {
    const meshes = new SceneMeshes(new MeshCache(), async () => null);
    const msg = scene([ref('C', 'shape-C2')], [whole('C')]);
    msg.result[0].hiddenShapes = [ref('C', 'shape-C3')];
    expect(meshes.prepare(msg).missing).toEqual([]);
    expect(msg.result[0].sceneShapes[0]).toEqual(whole('C', 1, 'shape-C2'));
    expect(msg.result[0].hiddenShapes[0].meshes).toBe(msg.result[1].sceneShapes[0].meshes);
  });

  it('fetches the references it lacks before the scene is handled, holding every message after it', async () => {
    const answer = deferred<MeshLookup | null>();
    const lookup = vi.fn((_keys: string[]) => answer.promise);
    const meshes = new SceneMeshes(new MeshCache(), lookup);
    const handled: string[] = [];
    const inbox = new ServerInbox<any>({
      prepare: (msg) => (msg.type === 'scene-rendered' ? meshes.ready(msg) : 'handle'),
      handle: (msg) => handled.push(msg.type === 'scene-rendered' ? `scene:${msg.result[0].sceneShapes[0].meshes ? 'drawn' : 'unresolved'}` : msg.type),
      skip: (msg) => handled.push(`skipped:${msg.type}`),
    });
    inbox.push({ type: 'render-version', state: 'start' });
    const msg = scene([ref('D'), ref('D', 'shape-D2'), whole('E')]);
    inbox.push(msg);
    inbox.push({ type: 'render-version', state: 'end' });
    expect(handled).toEqual(['render-version']);
    expect(inbox.pending).toBe(2);
    // One key, asked once.
    expect(lookup).toHaveBeenCalledWith(['D']);

    answer.resolve({ meshes: { D: payload(4) }, missing: [] });
    await vi.waitFor(() => expect(handled).toEqual(['render-version', 'scene:drawn', 'render-version']));
    expect(msg.result[0].sceneShapes[0]).toEqual(whole('D', 4));
    expect(msg.result[0].sceneShapes[1].meshes).toBe(msg.result[0].sceneShapes[0].meshes);
  });

  it('skips a scene the server no longer has every mesh of, and goes on with the next', async () => {
    const meshes = new SceneMeshes(new MeshCache(), async () => ({ meshes: {}, missing: ['Z'] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handled: string[] = [];
    const inbox = new ServerInbox<any>({
      prepare: (msg) => (msg.type === 'scene-rendered' ? meshes.ready(msg) : 'handle'),
      handle: (msg) => handled.push(msg.type === 'scene-rendered' ? `scene:${msg.result.length}` : msg.type),
      skip: (msg) => handled.push(`skipped:${msg.result.length}`),
    });
    inbox.push(scene([ref('Z')]));
    inbox.push(scene([whole('F')], [whole('G')]));
    await vi.waitFor(() => expect(handled).toEqual(['skipped:1', 'scene:2']));
    warn.mockRestore();
  });

  it('records each scene\'s page timings', () => {
    window.__fluidcadSceneTimings = [];
    const meshes = new SceneMeshes(new MeshCache(), async () => null);
    meshes.ready(scene([whole('H')]));
    const msg = { ...scene([ref('H'), whole('I')]), sceneVersion: 7, sceneKind: 'assembly' };
    SceneTimings.received(msg, 1234, 0.5);
    expect(meshes.ready(msg)).toBe('handle');
    SceneTimings.applied(msg, 3.21, new MeshCache().stats());
    expect(window.__fluidcadSceneTimings).toEqual([expect.objectContaining({
      version: 7, sceneKind: 'assembly', bytes: 1234, parseMs: 0.5, refs: 1, whole: 1, fetched: 0, skipped: false, applyMs: 3.2,
    })]);
  });
});

describe('the server inbox', () => {
  it('reports a handler that throws and goes on', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handled: number[] = [];
    const inbox = new ServerInbox<number>({
      prepare: () => 'handle',
      handle: (n) => {
        if (n === 1) {
          throw new Error('boom');
        }
        handled.push(n);
      },
      skip: () => {},
    });
    inbox.push(1);
    inbox.push(2);
    expect(handled).toEqual([2]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('drops what waits and what is queued when its connection closes', async () => {
    const wait = deferred<'handle'>();
    const handled: string[] = [];
    const inbox = new ServerInbox<string>({
      prepare: (msg) => (msg === 'scene' ? wait.promise : 'handle'),
      handle: (msg) => handled.push(msg),
      skip: () => {},
    });
    inbox.push('scene');
    inbox.push('after');
    inbox.close();
    wait.resolve('handle');
    await new Promise((resolve) => setTimeout(resolve, 0));
    inbox.push('late');
    expect(handled).toEqual([]);
  });
});

describe('cached geometry', () => {
  it('is built once and shared; a dispose() from a mesh tree leaves it alone', () => {
    const cache = new MeshCache();
    const kept = cache.keep('A', payload(1));
    const build = vi.fn(() => FaceMesh.buildGeometry(kept.meshes[0]));
    const geometry = cache.geometryOf(kept.meshes[0], build);
    expect(cache.geometryOf(kept.meshes[0], build)).toBe(geometry);
    expect(build).toHaveBeenCalledTimes(1);
    expect(cache.isShared(geometry)).toBe(true);
    const disposals = countDisposals([geometry]);
    geometry.dispose();
    expect(disposals.get(geometry)).toBe(0);

    // A mesh the cache does not hold gets geometry of its own, every time.
    const loose = payload(2).meshes[0];
    const own = cache.geometryOf(loose, () => FaceMesh.buildGeometry(loose));
    expect(cache.geometryOf(loose, () => FaceMesh.buildGeometry(loose))).not.toBe(own);
    expect(cache.isShared(own)).toBe(false);
  });

  it('evicts the least recently used past its capacity, freeing its geometry once', () => {
    const cache = new MeshCache(WEIGHT * 2.5);
    const a = cache.keep('A', payload(1));
    cache.keep('B', payload(2));
    const geometry = cache.geometryOf(a.meshes[0], () => FaceMesh.buildGeometry(a.meshes[0]));
    const disposals = countDisposals([geometry]);
    cache.keep('C', payload(3));
    expect(cache.stats()).toMatchObject({ entries: 3, weight: 3 * WEIGHT });
    cache.trim();
    expect(cache.has('A')).toBe(false);
    expect(cache.stats()).toMatchObject({ entries: 2, weight: 2 * WEIGHT, evicted: 1 });
    expect(disposals.get(geometry)).toBe(1);
    expect(cache.isShared(geometry)).toBe(false);
    // Its meshes are nobody's now: drawing one builds geometry of its own.
    expect(cache.geometryOf(a.meshes[0], () => new BufferGeometry())).not.toBe(geometry);
  });

  it('a key used since is the most recent: the oldest unused one goes', () => {
    const cache = new MeshCache(WEIGHT * 2.5);
    cache.keep('A', payload(1));
    cache.keep('B', payload(2));
    cache.take('A');
    cache.keep('C', payload(3));
    cache.trim();
    expect(['A', 'B', 'C'].filter((key) => cache.has(key))).toEqual(['A', 'C']);
  });

  it('never evicts what the scene on screen names, nor geometry a watched tree still draws', () => {
    // Under one payload's weight: a trim evicts everything it may.
    const cache = new MeshCache(WEIGHT * 0.5);
    const a = cache.keep('A', payload(1));
    const b = cache.keep('B', payload(2));
    cache.keep('C', payload(3));
    const drawnGeometry = cache.geometryOf(b.meshes[0], () => FaceMesh.buildGeometry(b.meshes[0]));
    const root = new Group();
    root.add(new Mesh(drawnGeometry, new MeshBasicMaterial()));
    const unwatch = cache.watch(root);
    cache.setOnScreen(['A']);
    cache.trim();
    // A is on screen, B is drawn: only C went — the weight stays over, which is fine.
    expect(['A', 'B', 'C'].filter((key) => cache.has(key))).toEqual(['A', 'B']);

    // Off screen and no longer drawn, they go.
    unwatch();
    cache.setOnScreen([]);
    const disposals = countDisposals([drawnGeometry]);
    cache.trim();
    expect(cache.stats()).toMatchObject({ entries: 0, weight: 0, evicted: 3 });
    expect(disposals.get(drawnGeometry)).toBe(1);
    expect(cache.geometryOf(a.meshes[0], () => drawnGeometry)).toBe(drawnGeometry);
  });

  it('clear() hands geometry still drawn back to its tree', () => {
    const cache = new MeshCache();
    const a = cache.keep('A', payload(1));
    const geometry = cache.geometryOf(a.meshes[0], () => FaceMesh.buildGeometry(a.meshes[0]));
    const root = new Group();
    root.add(new Mesh(geometry, new MeshBasicMaterial()));
    cache.watch(root);
    const disposals = countDisposals([geometry]);
    cache.clear();
    expect(disposals.get(geometry)).toBe(0);
    // The tree's own disposal frees it now.
    geometry.dispose();
    expect(disposals.get(geometry)).toBe(1);
  });

  it('keeps a sketch line\'s geometry its own: a drag rewrites it in place', () => {
    const kept = meshCache.keep('S', payload(5));
    const sketchLine = new EdgeMesh({ shapeType: 'edge', meshes: [kept.meshes[1]] });
    const solidEdge = new EdgeMesh({ shapeType: 'edge', meshes: [kept.meshes[1]] }, { sharedGeometry: true });
    const [own] = geometriesOf(sketchLine);
    const [shared] = geometriesOf(solidEdge);
    expect(meshCache.isShared(own)).toBe(false);
    expect(meshCache.isShared(shared)).toBe(true);
    expect(geometriesOf(new EdgeMesh({ shapeType: 'edge', meshes: [kept.meshes[1]] }, { sharedGeometry: true }))[0]).toBe(shared);
  });

  it('a page without the cache: on unless the flag turns it off', () => {
    expect(MeshCache.enabled()).toBe(true);
    window.localStorage.setItem(MeshCache.OFF_FLAG, '0');
    expect(MeshCache.enabled()).toBe(false);
    window.localStorage.removeItem(MeshCache.OFF_FLAG);
  });
});

describe('drawing scenes from the cache', () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);

  function part(id: string): SceneObjectRender {
    return {
      id, name: id, parentId: null, isContainer: true, type: 'part', uniqueType: 'part',
      object: { name: id }, sceneShapes: [], ownShapes: [], visible: true, sourceLocation: loc,
    } as unknown as SceneObjectRender;
  }

  function body(id: string, parentId: string | null, shapes: any[]): SceneObjectRender {
    return {
      id, name: id, parentId, isContainer: false, type: 'extrude', uniqueType: 'extrude',
      object: {}, sceneShapes: shapes, ownShapes: shapes, visible: true, sourceLocation: loc,
    } as unknown as SceneObjectRender;
  }

  /** A render of the rack: a shelf part (two instances) and a post part — ids re-minted per render. */
  function rack(render: number): { rows: SceneObjectRender[]; assembly: SerializedAssembly } {
    const shelf = `shelf-${render}`;
    const post = `post-${render}`;
    const instance = (instanceId: string, partId: string, z: number) => ({
      instanceId, partId, partName: partId, name: instanceId, grounded: false,
      position: { x: 0, y: 0, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    });
    return {
      rows: [part(shelf), body(`${shelf}/b`, shelf, [whole('SHELF', 1)]), part(post), body(`${post}/b`, post, [whole('POST', 2)])],
      assembly: { instances: [instance('i1', shelf, 0), instance('i2', shelf, 10), instance('i3', post, 0)], mates: [] } as SerializedAssembly,
    };
  }

  function controller(): AssemblyController {
    const canvas = document.createElement('canvas');
    const renderer = { domElement: canvas } as unknown as WebGLRenderer;
    return new AssemblyController(renderer, camera, () => {}, () => new Raycaster());
  }

  const instanceGeometries = (c: AssemblyController, id: string) => geometriesOf(c.getInstanceGroup(id)!);

  it('draws every instance of a template with one geometry, kept across renders that re-mint the part ids', () => {
    const meshes = new SceneMeshes(meshCache, async () => null);
    const c = controller();
    const first = rack(1);
    meshes.prepare({ result: first.rows });
    c.update(first.rows, first.assembly);
    const shelfA = instanceGeometries(c, 'i1');
    expect(shelfA).toHaveLength(2);
    expect(instanceGeometries(c, 'i2')).toEqual(shelfA);
    expect(instanceGeometries(c, 'i3').some((g) => shelfA.includes(g))).toBe(false);
    expect(shelfA.every((g) => meshCache.isShared(g))).toBe(true);
    const disposals = countDisposals(shelfA);

    // The next render: new part ids, the same keys sent whole again.
    const second = rack(2);
    meshes.prepare({ result: second.rows });
    c.update(second.rows, second.assembly);
    expect(instanceGeometries(c, 'i1')).toEqual(shelfA);
    expect(instanceGeometries(c, 'i2')).toEqual(shelfA);
    expect([...disposals.values()]).toEqual([0, 0]);
  });

  it('draws each instance with geometry of its own when the page never kept the payloads', () => {
    const c = controller();
    const { rows, assembly } = rack(3);
    c.update(rows, assembly);
    const shelfA = instanceGeometries(c, 'i1');
    expect(shelfA).toHaveLength(2);
    expect(instanceGeometries(c, 'i2').some((g) => shelfA.includes(g))).toBe(false);
    expect(shelfA.some((g) => meshCache.isShared(g))).toBe(false);
  });

  it('part mode: a re-render draws the same geometry, and freeing the old tree leaves it to the cache', () => {
    const meshes = new SceneMeshes(meshCache, async () => null);
    const rows = () => [body('e1', null, [whole('PLATE', 3)])];
    const firstRows = rows();
    meshes.prepare({ result: firstRows });
    const first = buildSceneMesh(firstRows, null, camera);
    const drawn = geometriesOf(first);
    const disposals = countDisposals(drawn);
    // What the viewer's removeCompiledMesh does to the old tree.
    first.traverse((object) => (object as { geometry?: BufferGeometry }).geometry?.dispose());
    expect([...disposals.values()]).toEqual([0, 0]);

    const secondRows = rows();
    meshes.prepare({ result: secondRows });
    expect(geometriesOf(buildSceneMesh(secondRows, null, camera))).toEqual(drawn);
    void new Scene();
    void Vector2;
  });
});
