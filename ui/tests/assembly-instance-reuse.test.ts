// @vitest-environment jsdom
// An assembly render re-mints every scene id (AssemblyCompare inherits no
// identity), so the controller used to rebuild every instance group on every
// render — every preview tick of a generated assembly. Content names what
// an instance draws instead (generators S6b): its part's rows, ids left out,
// each shape's payload named by its mesh key. A group whose part has the
// same content is kept — its connector ids moved to the new rows, the
// instance highlight's tint taken off — and only the parts that changed are
// rebuilt. A payload without a key (an older engine) can't be named: rebuilt.
import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, type Object3D, type WebGLRenderer } from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import { InstanceContent } from '../src/scene/instance-content';
import { MeshCache } from '../src/scene/mesh-cache';
import { SceneMeshes } from '../src/scene/scene-meshes';
import { buildObjectMesh } from '../src/meshes/mesh-factory';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
const loc = (line: number) => ({ filePath: '/ws/rack.assembly.js', line, column: 1 });

const tri = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };

/** A solid as the engine sends it whole: its key and payload ahead of its type, as `toRenderedShape` lists them. */
function solid(key: string | undefined, shapeId: string): any {
  return {
    shapeId, ...(key ? { meshKey: key } : {}),
    vertices: [0, 0, 0], faceVertices: [[0]],
    meshes: [{ ...tri, label: 'solid-faces', faceMapping: [0] }],
    shapeType: 'solid',
  };
}

/**
 * One render of a two-part rack: a shelf (with a connector) inserted twice,
 * a post once — the ids carry the render's number, as AssemblyCompare
 * re-mints them; `buildMs` and the source lines change too.
 */
function render(n: number, keys: { shelf?: string; post?: string } = {}, shapeIds = (name: string) => `shape-${name}`): { rows: SceneObjectRender[]; assembly: SerializedAssembly } {
  const shelfKey = 'shelf' in keys ? keys.shelf : 'k-shelf/vf';
  const postKey = 'post' in keys ? keys.post : 'k-post/vf';
  const row = (id: string, parentId: string | null, type: string, extra: Record<string, unknown> = {}): SceneObjectRender => ({
    id, name: type, parentId, isContainer: type === 'part', type, uniqueType: type, visible: true,
    object: {}, sceneShapes: [], ownShapes: [], fromCache: n > 1, buildDurationMs: n * 1.5, sourceLocation: loc(n),
    ...extra,
  } as unknown as SceneObjectRender);
  const shelf = `shelf-${n}`;
  const post = `post-${n}`;
  const instance = (instanceId: string, partId: string, z: number) => ({
    instanceId, partId, partName: partId.split('-')[0], name: instanceId, grounded: true,
    position: { x: 0, y: 0, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
  });
  return {
    rows: [
      row(shelf, null, 'part', { object: { name: 'Shelf', appearance: 'oak' } }),
      row(`${shelf}/body`, shelf, 'extrude', { sceneShapes: [solid(shelfKey, shapeIds('shelf'))] }),
      row(`${shelf}/top`, shelf, 'connector', {
        name: 'top',
        object: {
          name: 'top', origin: { x: 0, y: 0, z: 1 }, xDirection: { x: 1, y: 0, z: 0 }, yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
          hostShapeIds: [shapeIds('shelf')],
        },
      }),
      row(post, null, 'part', { object: { name: 'Post' } }),
      row(`${post}/body`, post, 'extrude', { sceneShapes: [solid(postKey, shapeIds('post'))] }),
    ],
    assembly: { instances: [instance('i1', shelf, 0), instance('i2', shelf, 10), instance('i3', post, 0)], mates: [] } as SerializedAssembly,
  };
}

function controller(): AssemblyController {
  const renderer = { domElement: document.createElement('canvas') } as unknown as WebGLRenderer;
  return new AssemblyController(renderer, camera, () => {}, () => new Raycaster());
}

function userDataIn(root: Object3D, key: string): unknown[] {
  const values: unknown[] = [];
  root.traverse((o) => {
    if (o.userData[key] !== undefined) {
      values.push(o.userData[key]);
    }
  });
  return values;
}

function connectorIdsIn(root: Object3D): string[] {
  const ids: string[] = [];
  root.traverse((o) => {
    if (typeof o.userData.connectorId === 'string') {
      ids.push(o.userData.connectorId);
    }
  });
  return ids;
}

afterEach(() => {
  window.localStorage.removeItem(MeshCache.OFF_FLAG);
});

describe('keeping unchanged assembly instances across renders', () => {
  it('keeps every group whose part draws the same content, its connector ids moved to the new rows', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 0, rebuilt: 3, removed: 0 });
    const groups = ['i1', 'i2', 'i3'].map(id => c.getInstanceGroup(id));
    expect(connectorIdsIn(groups[0]!)).toEqual(['shelf-1/top']);

    const second = render(2);
    c.update(second.rows, second.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 3, rebuilt: 0, removed: 0 });
    expect(['i1', 'i2', 'i3'].map(id => c.getInstanceGroup(id))).toEqual(groups);
    expect(connectorIdsIn(groups[0]!)).toEqual(['shelf-2/top']);
    expect(connectorIdsIn(groups[1]!)).toEqual(['shelf-2/top']);
  });

  it('keeps the groups of a template rebuilt into the same meshes (another detail tier), its shape ids moved', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const group = c.getInstanceGroup('i1')!;
    expect(userDataIn(group, 'shapeId')).toEqual(['shape-shelf']);
    expect(userDataIn(group, 'hostShapeIds')).toEqual([['shape-shelf']]);

    // New wrappers, new shape ids — the same mesh keys.
    const rebuilt = render(2, {}, (name) => `shape-${name}-2`);
    c.update(rebuilt.rows, rebuilt.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 3, rebuilt: 0, removed: 0 });
    expect(c.getInstanceGroup('i1')).toBe(group);
    expect(userDataIn(group, 'shapeId')).toEqual(['shape-shelf-2']);
    expect(userDataIn(group, 'hostShapeIds')).toEqual([['shape-shelf-2']]);
    expect(connectorIdsIn(group)).toEqual(['shelf-2/top']);
  });

  it('keeps a group whose shape came whole one render and by reference the next', () => {
    const meshes = new SceneMeshes(new MeshCache(), async () => null);
    const c = controller();
    const first = render(1);
    meshes.prepare({ result: first.rows });
    c.update(first.rows, first.assembly);
    // The next render as a page with a mesh cache gets it: every payload by reference.
    const second = render(2);
    for (const row of second.rows) {
      row.sceneShapes = row.sceneShapes.map(({ meshes: _m, vertices: _v, faceVertices: _f, meshKey, ...rest }: any) => ({ ...rest, meshRef: meshKey }));
    }
    expect(meshes.prepare({ result: second.rows }).missing).toEqual([]);
    c.update(second.rows, second.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 3, rebuilt: 0, removed: 0 });
  });

  it('rebuilds only the instances whose part drew another mesh', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const post = c.getInstanceGroup('i3');
    const shelf = c.getInstanceGroup('i1');

    const wider = render(2, { shelf: 'k-shelf-wide/vf' });
    c.update(wider.rows, wider.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 1, rebuilt: 2, removed: 0 });
    expect(c.getInstanceGroup('i3')).toBe(post);
    expect(c.getInstanceGroup('i1')).not.toBe(shelf);
    expect(connectorIdsIn(c.getInstanceGroup('i1')!)).toEqual(['shelf-2/top']);
  });

  it('rebuilds when anything drawn besides the meshes changed', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const second = render(2);
    (second.rows[0].object as Record<string, unknown>).appearance = 'walnut';
    c.update(second.rows, second.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 1, rebuilt: 2, removed: 0 });
  });

  it('rebuilds every render when the payloads carry no key (an engine before mesh keys)', () => {
    const c = controller();
    const first = render(1, { shelf: undefined, post: undefined });
    c.update(first.rows, first.assembly);
    const second = render(2, { shelf: undefined, post: undefined });
    c.update(second.rows, second.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 0, rebuilt: 3, removed: 0 });
  });

  it('keeps nothing with the mesh cache switched off', () => {
    window.localStorage.setItem(MeshCache.OFF_FLAG, '0');
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const second = render(2);
    c.update(second.rows, second.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 0, rebuilt: 3, removed: 0 });
  });

  it('a group kept mid-drag over a changed part is rebuilt by the render after the drag', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const group = c.getInstanceGroup('i3')!;
    // The post is being dragged while a render brings it changed: kept as it is.
    (c as any).externalDrag = { instanceId: 'i3' };
    const changed = render(1, { post: 'k-post-tall/vf' });
    changed.rows.forEach(row => { (row as any).fromCache = row.id.startsWith('shelf'); });
    c.update(changed.rows, changed.assembly);
    expect(c.getInstanceGroup('i3')).toBe(group);
    (c as any).externalDrag = null;

    const after = render(2, { post: 'k-post-tall/vf' });
    c.update(after.rows, after.assembly);
    expect(c.getInstanceGroup('i3')).not.toBe(group);
    expect(c.getLastUpdateStats()).toEqual({ kept: 2, rebuilt: 1, removed: 0 });
  });

  it('takes the instance highlight\'s tint off a kept group', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const group = c.getInstanceGroup('i3')!;
    let tinted: any = null;
    group.traverse((o: any) => {
      if (!tinted && o.material?.color) {
        tinted = o;
      }
    });
    const original = tinted.material.color.getHex();
    tinted.userData.assemblyOriginalColor = original;
    tinted.material.color.setHex(0xff0000);

    const second = render(2);
    c.update(second.rows, second.assembly);
    expect(c.getInstanceGroup('i3')).toBe(group);
    expect(tinted.material.color.getHex()).toBe(original);
    expect(tinted.userData.assemblyOriginalColor).toBeUndefined();
  });
});

describe('freeing what a dropped instance group drew', () => {
  /** The geometries and materials under `group`, each noting its own `dispose()` in `freed`. */
  function resourcesOf(group: Object3D, freed: Set<unknown>): { geometries: unknown[]; materials: unknown[] } {
    const geometries = new Set<any>();
    const materials = new Set<any>();
    group.traverse((o: any) => {
      if (o.geometry) {
        geometries.add(o.geometry);
      }
      for (const material of [o.material].flat()) {
        if (material) {
          materials.add(material);
        }
      }
    });
    for (const resource of [...geometries, ...materials]) {
      resource.addEventListener('dispose', () => freed.add(resource));
    }
    return { geometries: [...geometries], materials: [...materials] };
  }

  it('disposes a rebuilt or removed group\'s geometry and materials, and nothing a kept group draws with', () => {
    const c = controller();
    const first = render(1);
    c.update(first.rows, first.assembly);
    const freed = new Set<unknown>();
    const shelf = resourcesOf(c.getInstanceGroup('i1')!, freed);
    const post = resourcesOf(c.getInstanceGroup('i3')!, freed);
    expect(shelf.geometries.length).toBeGreaterThan(0);

    // The shelf drew another mesh: its groups are rebuilt, the post's kept.
    const wider = render(2, { shelf: 'k-shelf-wide/vf' });
    c.update(wider.rows, wider.assembly);
    expect(c.getLastUpdateStats()).toEqual({ kept: 1, rebuilt: 2, removed: 0 });
    expect(shelf.geometries.filter(g => !freed.has(g))).toEqual([]);
    expect(shelf.materials.filter(m => !freed.has(m))).toEqual([]);
    expect([...post.geometries, ...post.materials].some(r => freed.has(r))).toBe(false);

    // The post's insert is gone: its group, and what it drew with, go too.
    const without = render(3, { shelf: 'k-shelf-wide/vf' });
    without.assembly.instances = without.assembly.instances.filter(inst => inst.instanceId !== 'i3');
    c.update(without.rows, without.assembly);
    expect(c.getLastUpdateStats()).toMatchObject({ removed: 1 });
    expect(post.geometries.filter(g => !freed.has(g))).toEqual([]);
    expect(post.materials.filter(m => !freed.has(m))).toEqual([]);
  });
});

describe('instance content', () => {
  it('leaves the volatile fields and the payloads out, and names the rows in walk order', () => {
    const a = InstanceContent.of('shelf-1', render(1).rows)!;
    const b = InstanceContent.of('shelf-2', render(2).rows)!;
    expect(a.equals(b)).toBe(true);
    expect(b.rowIds).toEqual(['shelf-2', 'shelf-2/body', 'shelf-2/top']);
    // Ids named by their place, wherever they appear.
    expect(a.signature).not.toContain('shape-shelf');
    expect(InstanceContent.of('shelf-3', render(3, {}, (n) => `other-${n}`).rows)!.equals(a)).toBe(true);
    expect(a.signature).not.toContain('"vertices"');
    expect(a.signature).toContain('k-shelf/vf');
    expect(InstanceContent.of('missing', render(1).rows)).toBeNull();
  });

  it('the mesh builders stamp the subtree\'s row and shape ids under ID_KEYS only', () => {
    // Every row kind a part template draws, each id distinctive.
    const rows: SceneObjectRender[] = [
      ...render(7).rows.slice(0, 3),
      {
        id: 'ROWID-plane', name: 'plane', parentId: 'shelf-7', isContainer: false, type: 'plane', uniqueType: 'plane', visible: true,
        object: { normal: { x: 0, y: 0, z: 1 }, center: { x: 0, y: 0, z: 0 } }, ownShapes: [],
        sceneShapes: [{ shapeId: 'plane-q', shapeType: 'face', isMetaShape: true, meshes: [{ ...tri, label: 'plane' }] }],
      } as unknown as SceneObjectRender,
      {
        id: 'ROWID-axis', name: 'axis', parentId: 'shelf-7', isContainer: false, type: 'axis', uniqueType: 'axis', visible: true,
        object: {}, ownShapes: [],
        sceneShapes: [{ shapeId: 'axis-l', shapeType: 'edge', isMetaShape: true, meshes: [{ vertices: [0, 0, 0, 0, 0, 1], normals: [], indices: [0, 1] }] }],
      } as unknown as SceneObjectRender,
    ];
    const rowIds = new Set([
      ...rows.map(r => r.id),
      ...rows.flatMap(r => (r.sceneShapes as { shapeId?: string }[]).map(shape => shape.shapeId!)),
    ]);
    const tree = buildObjectMesh(rows[0], rows, null, camera, false);
    const stamped = new Set<string>();
    tree.traverse((o) => {
      for (const [key, value] of Object.entries(o.userData)) {
        const values = Array.isArray(value) ? value : [value];
        if (values.some(v => typeof v === 'string' && rowIds.has(v))) {
          stamped.add(key);
        }
      }
    });
    expect([...stamped].filter(key => !InstanceContent.ID_KEYS.includes(key))).toEqual([]);
    expect(stamped).toEqual(new Set(['connectorId', 'shapeId', 'hostShapeIds']));
  });
});
