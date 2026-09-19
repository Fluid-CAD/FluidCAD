import { describe, expect, it } from 'vitest';
import { setupOC, render } from '../setup.js';
import sketch from '../../core/sketch.js';
import plane from '../../core/plane.js';
import extrude from '../../core/extrude.js';
import part from '../../core/part.js';
import copy from '../../core/copy.js';
import mirror from '../../core/mirror.js';
import fillet from '../../core/fillet.js';
import { line, arc, bezier, project, offset, xAxis, yAxis } from '../../core/2d/index.js';
import { SceneObject } from '../../common/scene-object.js';
import { Shape } from '../../common/shape.js';
import { Scene } from '../../rendering/scene.js';
import { Sketch } from '../../features/2d/sketch.js';
import { topologyVertices } from '../../selection/vertex-pick.js';
import { SelectionResolver } from '../../selection/resolve-selection.js';
import { setLocation } from './pick-helpers.js';
import { testRect } from '../helpers/profiles.js';

function located<T>(object: T, at: number): T {
  setLocation(object, at);
  return object;
}
function pick(shape: Shape, index = 0) {
  return { shapeId: shape.id, sub: { type: 'vertex' as const, index } };
}
function points(scene: Scene, picks: ReturnType<typeof pick>[]) {
  const result = SelectionResolver.resolve(scene, { picks }, {});
  expect(result.ok).toBe(true);
  if (result.ok === false) {
    throw new Error(result.reason);
  }
  const synthesis = result.synthesized!;
  expect(synthesis.ok, synthesis.ok === false ? synthesis.reason : '').toBe(true);
  if (synthesis.ok === false) {
    throw new Error(synthesis.reason);
  }
  return synthesis;
}
function roundTrip(scene: Scene, shape: Shape, index = 0) {
  const synthesis = points(scene, [pick(shape, index)]);
  for (const form of [synthesis, ...synthesis.alternatives]) {
    const resolved = SelectionResolver.resolve(scene, { expression: form.expression });
    expect(resolved.ok, resolved.ok === false ? resolved.reason : form.expression).toBe(true);
    if (resolved.ok) {
      expect(resolved.matches).toHaveLength(1);
      expect(resolved.matches[0].summary.center).toEqual(topologyVertices(shape).slice(index * 3, index * 3 + 3)
        .map(value => Math.round(value * 1e3) / 1e3));
    }
  }
  return synthesis;
}

describe('vertex source synthesis', () => {
  setupOC();

  it('round-trips every box corner through ranked incident edge endpoints', () => {
    sketch('xy', () => testRect(30, 20));
    const e = located(extrude(10), 5) as unknown as SceneObject;
    const scene = render();
    const solid = e.getShapes()[0];
    for (let index = 0; index < 8; index++) {
      const synthesis = roundTrip(scene, solid, index);
      expect(synthesis.source).toMatch(/^e\..+\.(start|end)\(\)$/);
      expect(synthesis.parts[0].point?.kind).toBe('edge');
    }
  });

  it('uses a verified global edge filter when the producer cannot be bound', () => {
    sketch('xy', () => testRect(30, 20));
    const e = located(extrude(10), 5) as unknown as SceneObject;
    const scene = render();
    const result = SelectionResolver.resolve(scene, { picks: [pick(e.getShapes()[0])] }, { bindable: () => false });
    expect(result).toMatchObject({ ok: true, synthesized: { ok: true } });
    if (result.ok && result.synthesized?.ok) {
      expect(result.synthesized.expression).toContain('select(');
      expect(SelectionResolver.resolve(scene, { expression: result.synthesized.expression })).toMatchObject({ ok: true, count: 1 });
    }
  });

  it('chooses the earlier statement for both identities of a shared corner on an offset YZ sketch', () => {
    const s = located(sketch(plane('yz', { offset: 40 }), () => ({
      a: located(line([0, 0], [10, 0]), 2),
      b: located(line([10, 0], [10, 20]), 3),
    })), 1);
    const scene = render();
    const edges = [s.geometries.a, s.geometries.b].map(e => (e as unknown as SceneObject).getShapes()[0]);
    const a = roundTrip(scene, edges[0], 1);
    const b = roundTrip(scene, edges[1], 0);
    expect(a.source).toBe('s.geometries.l1.end()');
    expect(b.source).toBe(a.source);
    expect(a.exports).toMatchObject([{ part: 0, target: { line: 2, featureType: 'line', role: 'end' } }]);
  });

  it('retains point order and exports per point when several profiles are picked', () => {
    const a = located(sketch('xy', () => ({ l: located(line([0, 0], [10, 0]), 2) })), 1);
    const b = located(sketch(plane('xy', { offset: 40 }), () => ({ l: located(line([0, 0], [10, 0]), 5) })), 4);
    const scene = render();
    const shapes = [b.geometries.l, a.geometries.l].map(l => (l as unknown as SceneObject).getShapes()[0]);
    const result = points(scene, shapes.map(shape => pick(shape)));
    expect(result.exports?.map(ref => ref.sketch.line)).toEqual([4, 1]);
    expect(SelectionResolver.resolve(scene, { expression: result.expression })).toMatchObject({ ok: true, count: 2 });
  });

  it('keeps shared-corner attribution on profile geometry when a guide meets it', () => {
    const s = located(sketch('xy', () => {
      located(line([0, 0], [0, 10]).guide(), 2);
      return { side: located(line([0, 0], [20, 0]), 3) };
    }), 1);
    const scene = render();
    const shape = (s.geometries.side as unknown as SceneObject).getShapes()[0];
    expect(points(scene, [pick(shape)]).exports?.[0].target.line).toBe(3);
  });

  it('synthesizes consumed sketch endpoints at the edited statement boundary', () => {
    const s = located(sketch('xy', () => {
      const a = located(line([0, 0], [20, 0]), 2);
      const b = located(line([20, 0], [20, 20]), 3);
      const f = located(fillet(3, a, b), 4);
      return { a, f };
    }), 1);
    const scene = render();
    const shape = (s.geometries.a as unknown as SceneObject).getAddedShapes().find(shape => shape.isEdge())!;
    const before = scene.getAllSceneObjects().indexOf(s.geometries.f as unknown as SceneObject);
    expect(SelectionResolver.resolve(scene, { before, picks: [pick(shape)] }, {}))
      .toMatchObject({ ok: true, synthesized: { ok: true } });
  });

  it.each(['arc', 'bezier', 'project', 'copy', 'mirror'] as const)('round-trips %s entity endpoints', kind => {
    const original = located(sketch(plane('yz', { offset: 20 }), () => ({ l: located(line([3, 4], [12, 4]), 2) })), 1);
    const s = located(sketch(plane('yz', { offset: 50 }), () => {
      if (kind === 'arc') {
        return { target: located(arc([10, 0], [0, 10], [-10, 0]), 5) };
      }
      if (kind === 'bezier') {
        return { target: located(bezier([0, 0], [5, 10], [10, 0]), 5) };
      }
      if (kind === 'project') {
        return { target: located(project(original.geometries.l), 5) };
      }
      const l = located(line([10, 0], [20, 0]), 5);
      if (kind === 'copy') {
        return { target: located(copy('linear', xAxis(), { count: 2, offset: 30 }, l), 6) };
      }
      return { target: located(mirror(yAxis(), l), 6) };
    }), 4);
    const scene = render();
    expect(scene.getRenderedObjects().filter(object => object.hasError).map(object => object.errorMessage)).toEqual([]);
    const edge = (s.geometries.target as unknown as SceneObject).getShapes().find(shape => shape.isEdge())!;
    for (const index of [0, 1]) {
      const result = roundTrip(scene, edge, index);
      expect(result.exports?.[0].target.featureType).toBe(kind);
    }
  });

  it('refuses loop instances', () => {
    const s = located(sketch('xy', () => ({
      a: located(line([0, 0], [10, 0]), 2), b: located(line([0, 20], [10, 20]), 2),
    })), 1);
    const scene = render();
    const shape = (s.geometries.a as unknown as SceneObject).getShapes()[0];
    expect(SelectionResolver.resolve(scene, { picks: [pick(shape)] }, {}))
      .toMatchObject({ ok: true, synthesized: { ok: false, reason: expect.stringMatching(/loop\/helper/) } });
  });

  it('says a shared source line — not a loop — is why geometry cannot be named', () => {
    const s = located(sketch('xy', () => {
      const a = line([0, 0], [10, 0]);
      const b = line([0, 20], [10, 20]);
      (a as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 2, column: 2 });
      (b as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 2, column: 30 });
      return { a, b };
    }), 1);
    const scene = render();
    const shape = (s.geometries.a as unknown as SceneObject).getShapes()[0];
    expect(SelectionResolver.resolve(scene, { picks: [pick(shape)] }, {}))
      .toMatchObject({ ok: true, synthesized: { ok: false, reason: expect.stringMatching(/line 2 holds several statements/) } });
  });

  it('reports each point form split per part', () => {
    const base = located(sketch('xy', () => testRect(30, 20)), 1);
    const e = located(extrude(10, base), 8) as unknown as SceneObject;
    const scene = render();
    const synthesis = points(scene, [pick(e.getShapes()[0], 0), pick(e.getShapes()[0], 1)]);
    for (const form of [synthesis, ...synthesis.alternatives]) {
      expect(form.partSources).toHaveLength(2);
      expect(form.source).toBe(form.partSources!.join(', '));
    }
  });

  it('refuses vertices from different part scopes', () => {
    for (const [i, name] of ['a', 'b'].entries()) {
      part(name, () => { sketch('xy', () => testRect(30, 20)); located(extrude(10), 3 + i * 5); });
    }
    const scene = render();
    const solids = scene.getAllSceneObjects().filter(o => o.getType() === 'extrude').map(o => o.getShapes()[0]);
    const result = SelectionResolver.resolve(scene, { picks: solids.map(solid => pick(solid)) }, {});
    expect(result).toMatchObject({ ok: true, synthesized: { ok: false, reason: expect.stringContaining('different part() scopes') } });
    const mixed = SelectionResolver.resolve(scene, { picks: [pick(solids[0]), { shapeId: solids[0].id, sub: { type: 'face', index: 0 } }] }, {});
    expect(mixed).toMatchObject({ ok: true, synthesized: { ok: false, reason: expect.stringContaining('mix') } });
  });

  it.each(['offset', 'fillet'] as const)('names the unsupported %s operation in its refusal', kind => {
    const s = located(sketch('xy', () => {
      const a = located(line([0, 0], [20, 0]), 2);
      const b = located(line([20, 0], [20, 20]), 3);
      return { target: kind === 'offset' ? located(offset(3, a, b), 4) : located(fillet(3, a, b), 4) };
    }), 1);
    const scene = render();
    const shape = (s.geometries.target as unknown as SceneObject).getAddedShapes().find(shape => shape.isEdge())!;
    expect(shape).toBeDefined();
    expect(SelectionResolver.resolve(scene, { picks: [pick(shape)] }, {}))
      .toMatchObject({ ok: true, synthesized: { ok: false, reason: expect.stringContaining(kind) } });
  });
});
