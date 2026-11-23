// @vitest-environment jsdom
// The viewer solves the instances in the render's record order — the order
// the engine's own solve reads them in — whatever its group map looks like.
// A render rebuilds only the instances whose part changed, which moves them
// to the end of the controller's map; the solver picks an ungrounded
// component's root by input order, so a solve that followed the map would
// settle the same assembly differently from the engine, and differently
// from one session to the next.
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, type WebGLRenderer } from 'three';
import { AssemblyController } from '../src/scene/assembly-controller';
import type { SolverOutput } from '../../lib/assembly-solver/index.js';
import type { SceneObjectRender, SerializedAssembly } from '../src/types';

const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
const tri = { vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };

function solid(key: string, shapeId: string): any {
  return {
    shapeId, meshKey: key,
    vertices: [0, 0, 0], faceVertices: [[0]],
    meshes: [{ ...tri, label: 'solid-faces', faceMapping: [0] }],
    shapeType: 'solid',
  };
}

/** A shelf inserted twice and a post once, all free; `shelfKey` names what the shelf draws. */
function render(n: number, shelfKey: string): { rows: SceneObjectRender[]; assembly: SerializedAssembly } {
  const row = (id: string, parentId: string | null, type: string, extra: Record<string, unknown> = {}): SceneObjectRender => ({
    id, name: type, parentId, isContainer: type === 'part', type, uniqueType: type, visible: true,
    object: {}, sceneShapes: [], ownShapes: [], fromCache: n > 1,
    ...extra,
  } as unknown as SceneObjectRender);
  const shelf = `shelf-${n}`;
  const post = `post-${n}`;
  const instance = (instanceId: string, partId: string, z: number) => ({
    instanceId, partId, partName: partId.split('-')[0], name: instanceId, grounded: false,
    position: { x: 0, y: 0, z }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
  });
  return {
    rows: [
      row(shelf, null, 'part', { object: { name: 'Shelf' } }),
      row(`${shelf}/body`, shelf, 'extrude', { sceneShapes: [solid(shelfKey, 'shape-shelf')] }),
      row(post, null, 'part', { object: { name: 'Post' } }),
      row(`${post}/body`, post, 'extrude', { sceneShapes: [solid('k-post/vf', 'shape-post')] }),
    ],
    assembly: { instances: [instance('i1', shelf, 0), instance('i2', shelf, 10), instance('i3', post, 20)], mates: [] } as SerializedAssembly,
  };
}

describe('the viewer solves in record order', () => {
  it('keeps the render\'s instance order after a render rebuilt only some of the groups', () => {
    const renderer = { domElement: document.createElement('canvas') } as unknown as WebGLRenderer;
    const controller = new AssemblyController(renderer, camera, () => {}, () => new Raycaster());
    const solves: SolverOutput[] = [];
    controller.setSolverUpdateHandler(out => solves.push(out));

    const first = render(1, 'k-shelf/vf');
    controller.update(first.rows, first.assembly);
    expect(solves.at(-1)!.bodies.map(b => b.instanceId)).toEqual(['i1', 'i2', 'i3']);

    // The shelf changed and the post did not: both shelf groups are rebuilt.
    const second = render(2, 'k-shelf-edited/vf');
    controller.update(second.rows, second.assembly);
    expect(controller.getLastUpdateStats()).toEqual({ kept: 1, rebuilt: 2, removed: 0 });
    expect(solves.at(-1)!.bodies.map(b => b.instanceId)).toEqual(['i1', 'i2', 'i3']);
  });
});
