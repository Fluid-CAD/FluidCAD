import { describe, it, expect } from "vitest";
import { SceneObject } from "../../common/scene-object.js";
import { Part } from "../../features/part.js";
import { Scene } from "../../rendering/scene.js";
import { SceneRenderer } from "../../rendering/render.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { setupOC } from "../setup.js";
import { InertObject, buildHeavyAssemblyScene } from "../fixtures/heavy-assembly/heavy-scene.js";

// The list scans the scene's structural index replaced, as reference semantics.
function enclosingPart(obj: SceneObject): Part | null {
  let current = obj.getParent();
  while (current) {
    if (current instanceof Part) {
      return current;
    }
    current = current.getParent();
  }
  return obj instanceof Part ? obj : null;
}

function scanPartScopedAll(all: SceneObject[], obj: SceneObject): SceneObject[] {
  const part = enclosingPart(obj);
  return part ? all.filter(o => enclosingPart(o) === part) : all;
}

function scanPartScopedUpTo(all: SceneObject[], obj: SceneObject): SceneObject[] {
  const upTo = all.slice(0, all.indexOf(obj));
  const part = enclosingPart(obj);
  return part ? upTo.filter(o => enclosingPart(o) === part) : upTo;
}

describe("scene structural index", () => {
  setupOC();

  for (const interleave of [false, true]) {
    it(`answers like the list scans — ${interleave ? "interleaved" : "contiguous"} parts`, () => {
      const scene = buildHeavyAssemblyScene({ parts: 5, polygonPoints: 6, interleave });
      const all = scene.getAllSceneObjects();
      if (interleave) {
        // The fixture really interleaves: some part's members are not one run.
        const first = all.find(o => o instanceof Part)!;
        const positions = scene.getPartScopedAllObjects(first).map(o => all.indexOf(o));
        expect(positions[positions.length - 1] - positions[0] + 1).toBeGreaterThan(positions.length);
      }
      for (const obj of all) {
        expect(scene.indexOf(obj)).toBe(all.indexOf(obj));
        expect(scene.findEnclosingPart(obj)).toBe(enclosingPart(obj));
        expect(scene.getPartScopedAllObjects(obj)).toEqual(scanPartScopedAll(all, obj));
        expect(scene.getPartScopedObjectsUpTo(obj)).toEqual(scanPartScopedUpTo(all, obj));
        expect(scene.getSceneObjectsUpTo(obj)).toEqual(all.slice(0, all.indexOf(obj)));
        expect(scene.getChildren(obj)).toEqual(all.filter(o => o.parentId === obj.id));
      }
    });
  }

  it("treats an object that is not in the scene like the scans did", () => {
    const scene = buildHeavyAssemblyScene({ parts: 2, polygonPoints: 2 });
    const all = scene.getAllSceneObjects();
    const part = all.find(o => o instanceof Part)!;
    const stray = new InertObject("stray");
    part.addChildObject(stray);
    expect(scene.indexOf(stray)).toBe(-1);
    expect(scene.getPartScopedObjectsUpTo(stray)).toEqual(scanPartScopedUpTo(all, stray));
    expect(scene.getSceneObjectsUpTo(stray)).toEqual(all.slice(0, -1));
  });

  it("follows adds, replacements and late adoption", () => {
    const scene = new Scene();
    const part = new Part("p");
    scene.addSceneObject(part);
    const a = new InertObject("a");
    part.addChildObject(a);
    scene.addSceneObject(a);
    expect(scene.getPartScopedAllObjects(a)).toEqual([part, a]);

    // Added first, adopted after — the index must not keep the orphan answer.
    const b = new InertObject("b");
    scene.addSceneObject(b);
    expect(scene.findEnclosingPart(b)).toBeNull();
    part.addChildObject(b);
    expect(scene.findEnclosingPart(b)).toBe(part);
    expect(scene.getPartScopedAllObjects(a)).toEqual([part, a, b]);
    expect(scene.getChildren(part)).toEqual([a, b]);

    const replacement = new InertObject("a2");
    part.addChildObject(replacement);
    scene.replaceSceneObject(a, replacement);
    expect(scene.indexOf(a)).toBe(-1);
    expect(scene.indexOf(replacement)).toBe(1);
    expect(scene.getPartScopedAllObjects(b)).toEqual([part, replacement, b]);

    scene.addSceneObject(replacement);
    expect(scene.getAllSceneObjects()).toHaveLength(3);
  });
});

/**
 * Scaling, not wall-clock: rendering a scene in which every object is a cache
 * hit builds nothing, so its cost is the renderer's bookkeeping — which must
 * grow with the scene, not with its square. n → 4n rows costs ~4x when linear
 * and ~16x when quadratic; the bound sits between the two.
 */
describe("an all-cached render scales linearly with scene size", () => {
  setupOC();

  function bestOf(runs: number, polygonPoints: number): { ms: number; rows: number } {
    let best = Infinity;
    let rows = 0;
    for (let i = 0; i < runs; i++) {
      const scene = buildHeavyAssemblyScene({ parts: 10, polygonPoints, interleave: true });
      rows = scene.getAllSceneObjects().length;
      const renderer = new SceneRenderer(DEFAULT_MESH_CONFIG);
      const log = console.log;
      console.log = () => {};
      const start = performance.now();
      try {
        renderer.render(scene);
      } finally {
        console.log = log;
      }
      best = Math.min(best, performance.now() - start);
    }
    return { ms: best, rows };
  }

  it("n → 4n rows costs well under 16x", () => {
    bestOf(1, 60);
    const small = bestOf(4, 60);
    const large = bestOf(4, 240);
    expect(large.rows).toBeGreaterThan(3.5 * small.rows);
    expect(large.ms / Math.max(small.ms, 0.05)).toBeLessThan(8);
  });
});
