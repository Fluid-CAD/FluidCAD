import { describe, expect, it } from 'vitest';
import { setupOC, render } from '../setup.js';
import sketch from '../../core/sketch.js';
import plane from '../../core/plane.js';
import extrude from '../../core/extrude.js';
import part from '../../core/part.js';
import insert from '../../core/insert.js';
import { getSceneManager } from '../../scene-manager.js';
import { expandTangentChain } from '../../selection/expand.js';
import { listSelectionGroups } from '../../selection/selection-groups.js';
import { SceneObject } from '../../common/scene-object.js';
import { Explorer } from '../../oc/explorer.js';
import { SelectionResolver } from '../../selection/resolve-selection.js';
import { topologyVertices } from '../../selection/vertex-pick.js';
import { testRect } from '../helpers/profiles.js';

describe('topological vertex picks', () => {
  setupOC();

  it('serializes a box as eight vertices in exactly the resolver index order', () => {
    const s = sketch('xy', () => testRect(30, 20));
    const e = extrude(10, s) as unknown as SceneObject;
    const scene = render();
    const shape = e.getShapes()[0];
    const payload = scene.getRenderedObjects().flatMap(object => object.sceneShapes).find(p => p.shapeId === shape.id)!;
    expect(payload.vertices).toHaveLength(24);
    const vertices = Explorer.findVerticesWrapped(shape);
    try {
      expect(payload.vertices).toEqual(vertices.flatMap(vertex => vertex.toPoint().toArray()));
      const result = SelectionResolver.resolve(scene, {
        picks: vertices.map((_, index) => ({ shapeId: shape.id, sub: { type: 'vertex', index } })),
      }, {});
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.matches).toHaveLength(8);
      for (const [i, match] of result.matches.entries()) {
        expect(match.kind).toBe('vertex');
        expect(match.summary).toEqual({ form: 'vertex', center: vertices[i].toPoint().toArray() });
      }
      expect(result.synthesized).toMatchObject({ ok: false });
    } finally {
      for (const vertex of vertices) {
        vertex.dispose();
      }
    }
  });

  it('resolves endpoints of sketch edges in world coordinates', () => {
    const s = sketch(plane('yz', { offset: 40 }), () => testRect(30, 20)) as unknown as SceneObject;
    const scene = render();
    const child = s.getChildren().find(object => object.getType() === 'line') ?? s.getChildren()[0];
    const edge = child.getShapes().find(shape => shape.isEdge())!;
    const points = topologyVertices(edge);
    expect(points).toHaveLength(6);
    const result = SelectionResolver.resolve(scene, { picks: [{ shapeId: edge.id, sub: { type: 'vertex', index: 0 } }] });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.matches[0].summary.center).toEqual(points.slice(0, 3));
    expect(result.matches[0].summary.center[0]).toBe(40);
  });

  it('honours statement boundaries for consumed sketch vertices', () => {
    const s = sketch('xy', () => testRect(30, 20)) as unknown as SceneObject;
    const e = extrude(10, s) as unknown as SceneObject;
    const scene = render();
    const edge = s.getChildren().flatMap(object => object.getAddedShapes()).find(shape => shape.isEdge())!;
    const pick = { shapeId: edge.id, sub: { type: 'vertex' as const, index: 0 } };
    expect(SelectionResolver.resolve(scene, { picks: [pick] })).toMatchObject({ ok: false, code: 'unresolved-pick' });
    expect(SelectionResolver.resolve(scene, { picks: [pick], before: scene.getAllSceneObjects().indexOf(e) }))
      .toMatchObject({ ok: true, count: 1 });
  });

  it('rejects invalid indices and vertices outside the requested part', () => {
    for (const name of ['a', 'b']) {
      part(name, () => { sketch('xy', () => testRect(30, 20)); extrude(10); });
    }
    const scene = render();
    const object = scene.getAllSceneObjects().find(object => object.getType() === 'extrude')!;
    const shape = object.getShapes()[0];
    for (const index of [-1, 8, 0.5]) {
      expect(SelectionResolver.resolve(scene, { picks: [{ shapeId: shape.id, sub: { type: 'vertex', index } }] }))
        .toMatchObject({ ok: false, code: 'unresolved-pick' });
    }
    expect(SelectionResolver.resolve(scene, {
      picks: [{ shapeId: shape.id, sub: { type: 'vertex', index: 0 } }], scope: { part: 'b' },
    })).toMatchObject({ ok: false, code: 'out-of-scope' });
  });

  it('resolves assembly vertices at the instance pose and keeps unsupported edge operations out', () => {
    const scene = getSceneManager().startAssemblyScene();
    const box = part('box', () => { sketch('xy', () => testRect(20, 20)); extrude(10); });
    insert(box).translate(30, 0, 0);
    render();
    const instanceId = scene.getSerializedInstances()[0].instanceId;
    const solid = scene.getAllSceneObjects().find(object => object.getType() === 'extrude')!.getShapes()[0];
    const local = topologyVertices(solid).slice(0, 3);
    const pick = { shapeId: solid.id, sub: { type: 'vertex' as const, index: 0 } };
    const result = SelectionResolver.resolve(scene, { picks: [pick], scope: { instanceId } });
    expect(result).toMatchObject({ ok: true, matches: [{ instanceId, summary: { form: 'vertex', center: [local[0] + 30, local[1], local[2]] } }] });
    expect(expandTangentChain(scene, pick)).toMatchObject({ ok: false });
    expect(listSelectionGroups(scene, pick)).toEqual({ ok: true, groups: [] });
  });
});
