import { describe, expect, it } from 'vitest';
import { setupOC, render } from '../setup.js';
import { getSceneManager } from '../../scene-manager.js';
import { sketch, plane, extrude, cut, part, insert, line, project } from '../../core/index.js';
import { coincident, horizontal, distance } from '../../core/constraints/index.js';
import { SceneCompare } from '../../rendering/scene-compare.js';
import { AssemblyCompare } from '../../rendering/assembly-compare.js';
import { AssemblyScene } from '../../rendering/assembly-scene.js';
import { SceneObject } from '../../common/scene-object.js';
import { Sketch } from '../../features/2d/sketch.js';
import { PointResolver } from '../../features/point-resolver.js';
import { SelectionResolver } from '../../selection/resolve-selection.js';
import { topologyVertices } from '../../selection/vertex-pick.js';
import { Point } from '../../math/point.js';
import { testRect } from '../helpers/profiles.js';
import { setLocation } from './pick-helpers.js';

function model(assembly: boolean) {
  const manager = getSceneManager();
  const scene = assembly ? manager.startAssemblyScene() : manager.startScene();
  let profile!: ReturnType<typeof declareProfile>;
  function declareProfile() {
    sketch('xy', () => testRect(20, 20));
    const base = extrude(10);
    const s = sketch(plane(base.endFaces(), 20), () => {
      const p = project(base.endFaces()).guide();
      const l = line([2, 3], [8, 3]);
      setLocation(p, 10);
      setLocation(l, 11);
      coincident(l.start(), p.ref(0).start());
      horizontal(l);
      distance(l.start(), l.end(), 4);
      return { p, l };
    });
    setLocation(s, 9);
    // Consume the projection's solid after the profile was solved. A late
    // projection evaluation no longer sees that earlier face.
    sketch(base.endFaces(), () => testRect(5, 5, { at: [2, 2] }));
    cut(1);
    return s;
  }
  const definition = part('cached-reference', () => { profile = declareProfile(); });
  if (assembly) {
    insert(definition);
  } else {
    scene.materializeLeftoverDefinitions();
  }
  return { scene, profile };
}

describe('cached sketch vertex references', () => {
  setupOC();

  it.each([false, true])('retains solved endpoints and projection records after cached rebuilds (assembly=%s)', assembly => {
    let previous = model(assembly);
    render();
    const expected = PointResolver.toWorld(previous.profile.geometries.l.start());
    const projected = PointResolver.toWorld(previous.profile.geometries.p.ref(0).start());
    expect(expected.distanceTo(projected)).toBeLessThan(1e-6);
    const snapshot = structuredClone((previous.profile as unknown as Sketch).serialize().solver);

    for (let pass = 0; pass < 2; pass++) {
      const next = model(assembly);
      if (previous.scene instanceof AssemblyScene && next.scene instanceof AssemblyScene) {
        AssemblyCompare.compare(previous.scene, next.scene);
      } else {
        SceneCompare.compare(previous.scene, next.scene);
      }
      const rendered = render();
      expect(next.scene.isCached(next.profile as unknown as SceneObject)).toBe(true);
      const shape = (next.profile.geometries.l as unknown as SceneObject).getAddedShapes()[0];
      for (const index of [0, 1]) {
        const result = SelectionResolver.resolve(rendered, {
          picks: [{ shapeId: shape.id, sub: { type: 'vertex', index } }],
        }, {});
        expect(result).toMatchObject({ ok: true, synthesized: { ok: true } });
        const point = index === 0 ? next.profile.geometries.l.start() : next.profile.geometries.l.end();
        const drawn = Point.fromArray(topologyVertices(shape).slice(index * 3, index * 3 + 3) as [number, number, number]);
        expect(PointResolver.toWorld(point).distanceTo(drawn)).toBeLessThan(1e-6);
      }
      expect(PointResolver.toWorld(next.profile.geometries.l.start()).distanceTo(expected)).toBeLessThan(1e-6);
      expect(PointResolver.toWorld(next.profile.geometries.p.ref(0).start()).distanceTo(projected)).toBeLessThan(1e-6);
      expect((next.profile as unknown as Sketch).serialize().solver).toEqual(snapshot);
      previous = next;
    }
  });
});
