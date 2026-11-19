// `.labelAt(u, v)` on the dimension statements: where the value is drawn.
// Display-only — it rides the serialize payload to the sketcher and stays
// out of the solver, the spec and the cache comparison, so moving a label
// never rebuilds the sketch (or anything downstream of it).

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import { SceneObject } from "../../../common/scene-object.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, circle } from "../../../core/2d/index.js";
import {
  coincident, horizontal, vertical, fix, distance, radius, diameter, angle, offsetFrom,
} from "../../../core/constraints/index.js";
import { Scene } from "../../../rendering/scene.js";
import type { ISolvedCircle } from "../../../core/interfaces.js";

type DimensionPayload = { kind: string; label?: [number, number]; spec: unknown; value?: number };

function byUniqueType(scene: Scene, uniqueType: string): SceneObject[] {
  return scene.getSceneObjects().filter(o => o.getUniqueType() === uniqueType);
}

function rendered(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

/** A 100×50 box whose width dimension's label is parked at `label`. */
function declareBox(label: [number, number] | null) {
  sketch('xy', () => {
    const b = line([0, 0], [100, 0]);
    const r = line([100, 0], [100, 50]);
    const t = line([100, 50], [0, 50]);
    const l = line([0, 50], [0, 0]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    fix(b.start());
    const d = distance(b.start(), b.end(), 100);
    if (label) {
      d.labelAt(label[0], label[1]);
    }
    distance(r.start(), r.end(), 50);
  });
  extrude(30);
}

describe("dimension label placement (.labelAt)", () => {
  setupOC();

  it("ships the placement in the payload of every dimension kind", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const b = line([0, 0], [30, 30]);
      const c = circle([100, 0], 10) as unknown as ISolvedCircle;
      const c2 = circle([200, 0], 10) as unknown as ISolvedCircle;
      const o = line([0, -10], [50, -10]);
      fix(a.start());
      distance(a.start(), a.end(), 50).labelAt(4, -12);
      angle(a, b, 45).labelAt(18, 2.5);
      radius(c, 10).labelAt(-6, 6);
      diameter(c2, 20).labelAt(0, 15);
      offsetFrom(o, a, 10).labelAt(1, 2);
    });
    const scene = render();

    const labelOf = (uniqueType: string) =>
      (rendered(scene, uniqueType)[0].object as DimensionPayload).label;
    expect(labelOf('constraint-distance')).toEqual([4, -12]);
    expect(labelOf('constraint-angle')).toEqual([18, 2.5]);
    expect(labelOf('constraint-radius')).toEqual([-6, 6]);
    expect(labelOf('constraint-diameter')).toEqual([0, 15]);
    expect(labelOf('constraint-offsetFrom')).toEqual([1, 2]);
    for (const uniqueType of ['constraint-distance', 'constraint-angle', 'constraint-radius',
      'constraint-diameter', 'constraint-offsetFrom']) {
      expect(rendered(scene, uniqueType)[0].hasError).toBeFalsy();
    }
  });

  it("leaves the payload untouched without a placement", () => {
    declareBox(null);
    const scene = render();
    for (const dim of rendered(scene, 'constraint-distance')) {
      expect(dim.object as DimensionPayload).not.toHaveProperty('label');
    }
  });

  it("chains with the tangency condition in either order", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const c = circle([25, 40], 10) as unknown as ISolvedCircle;
      const c2 = circle([25, -40], 10) as unknown as ISolvedCircle;
      fix(a.start());
      distance(a, c, 50).max().labelAt(3, 4);
      distance(a, c2, 50).labelAt(5, 6).max();
    });
    const scene = render();

    const dims = rendered(scene, 'constraint-distance').map(d => d.object as DimensionPayload);
    expect(dims.map(d => d.label)).toEqual([[3, 4], [5, 6]]);
    expect(dims.map(d => (d.spec as { tangency?: string }).tangency)).toEqual(['max', 'max']);
  });

  it("reports a malformed placement on the statement instead of throwing", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      fix(a.start());
      (distance(a.start(), a.end(), 50) as any).labelAt(4);
      (distance(a.start(), a.end(), 50) as any).labelAt('left', 2);
      distance(a.start(), a.end(), 50).labelAt(Number.NaN, 0);
    });
    const scene = render();

    const dims = rendered(scene, 'constraint-distance');
    expect(dims).toHaveLength(3);
    for (const dim of dims) {
      expect(dim.hasError).toBe(true);
      expect(dim.errorMessage).toContain('labelAt()');
      expect(dim.object as DimensionPayload).not.toHaveProperty('label');
    }
  });

  it("moving a label keeps the whole scene cached and serializes the new spot", () => {
    declareBox([0, -12]);
    render();
    const previousScene = getSceneManager().currentScene;
    const previousIds = previousScene.getSceneObjects().map(o => o.id);

    const newScene = getSceneManager().startScene();
    declareBox([20, 8]);
    SceneCompare.compare(previousScene, newScene);

    // Every object — the sketch subtree AND the extrude after it — takes its
    // previous build: a label is not an input of anything.
    expect(newScene.getSceneObjects().map(o => o.id)).toEqual(previousIds);
    for (const obj of newScene.getSceneObjects()) {
      expect(newScene.isCached(obj)).toBe(true);
    }
    const [width, height] = byUniqueType(newScene, 'constraint-distance')
      .map(o => o.serialize() as DimensionPayload);
    expect(width.label).toEqual([20, 8]);
    expect(height).not.toHaveProperty('label');
  });

  it("dropping the placement keeps the cache and returns to the automatic layout", () => {
    declareBox([0, -12]);
    render();
    const previousScene = getSceneManager().currentScene;

    const newScene = getSceneManager().startScene();
    declareBox(null);
    SceneCompare.compare(previousScene, newScene);

    const width = byUniqueType(newScene, 'constraint-distance')[0];
    expect(newScene.isCached(width)).toBe(true);
    expect(width.serialize() as DimensionPayload).not.toHaveProperty('label');
  });

  it("a copy of the statement carries the placement", () => {
    declareBox([7, 9]);
    render();
    const width = byUniqueType(getSceneManager().currentScene, 'constraint-distance')[0];
    const copy = width.createCopy(new Map());
    expect(copy.constructor).toBe(width.constructor);
    expect((copy.serialize() as DimensionPayload).label).toEqual([7, 9]);
  });
});
