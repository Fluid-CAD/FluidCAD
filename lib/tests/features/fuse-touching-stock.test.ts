import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import translate from "../../core/translate.js";
import { circle, origin } from "../../core/2d/index.js";
import { coincident, diameter } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";

/**
 * An add fuses its tool into the stock it merges with, and only that. A
 * stock the tool merely touches — tangent along a line, meeting at a corner
 * — comes out of the kernel rebuilt (its faces split along the contact) yet
 * merged with nothing: the body it was. It stays with its holder, as a cut
 * that only lands on a face leaves its stock (GH #94: a repeat whose
 * instances touched the originals took them over, and translating the
 * repeat moved both rows).
 */

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().map(obj => obj.getError()).filter((e): e is string => !!e);
}

function solidsOf(obj: SceneObject) {
  return obj.getShapes({}, "solid");
}

/** Every solid the scene's objects hold, as centroids rounded to 0.01, sorted by x then y. */
function centroids(scene: Scene): [number, number][] {
  return scene.getAllSceneObjects()
    .filter(obj => !obj.isContainer())
    .flatMap(obj => solidsOf(obj))
    .map(solid => {
      const c = ShapeProps.getProperties(solid.getShape()).centroid;
      return [Math.round(c.x * 100) / 100 + 0, Math.round(c.y * 100) / 100 + 0] as [number, number];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe("a fuse hands back the stock its tool only touches", () => {
  setupOC();

  it("leaves a cylinder tangent to the new one with the extrude that built it", () => {
    const s1 = sketch("xy", () => {
      const c = circle([0, 0], 5);
      coincident(c.center(), origin());
      diameter(c, 10);
    });
    const first = extrude(20, s1) as unknown as SceneObject;
    const s2 = sketch("xy", () => {
      const c = circle([0, 10], 5);
      diameter(c, 10);
    });
    const second = extrude(20, s2) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(first)).toHaveLength(1);
    expect(solidsOf(second)).toHaveLength(1);
    expect(centroids(scene)).toEqual([[0, 0], [0, 10]]);
  });

  it("leaves a box the new one meets along one edge with its holder", () => {
    sketch("xy", () => testRect(10, 10));
    const first = extrude(20) as unknown as SceneObject;
    sketch("xy", () => testRect(10, 10, { at: [10, 10] }));
    const second = extrude(20) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(first)).toHaveLength(1);
    expect(solidsOf(second)).toHaveLength(1);
    expect(centroids(scene)).toEqual([[5, 5], [15, 15]]);
  });

  it("still merges a box the new one shares a face with", () => {
    sketch("xy", () => testRect(10, 10));
    const first = extrude(20) as unknown as SceneObject;
    sketch("xy", () => testRect(10, 10, { at: [0, 10] }));
    const second = extrude(20) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(first)).toHaveLength(0);
    expect(solidsOf(second)).toHaveLength(1);
    expect(centroids(scene)).toEqual([[5, 10]]);
  });

  it("still merges a cylinder overlapping the new one", () => {
    const s1 = sketch("xy", () => {
      const c = circle([0, 0], 5);
      coincident(c.center(), origin());
      diameter(c, 10);
    });
    const first = extrude(20, s1) as unknown as SceneObject;
    const s2 = sketch("xy", () => {
      const c = circle([0, 8], 5);
      diameter(c, 10);
    });
    const second = extrude(20, s2) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(first)).toHaveLength(0);
    expect(solidsOf(second)).toHaveLength(1);
    expect(centroids(scene)).toEqual([[0, 4]]);
  });

  /** GH #94: a row of posts, repeated into a second row `offset` away, the second row then slid 5 along x. */
  function staggeredRows(offset: number) {
    const s = sketch("xy", () => {
      const c = circle([0, 0], 5);
      coincident(c.center(), origin());
      diameter(c, 10);
    });
    const e = extrude(20, s) as unknown as SceneObject;
    const row1 = repeat("linear", "x", { count: 3, offset: 15 }, e) as unknown as SceneObject;
    const row2 = repeat("linear", "y", { count: 2, offset }, row1) as unknown as SceneObject;
    const stagger = translate(5, 0, 0, row2) as unknown as SceneObject;
    return { stagger, scene: render() };
  }

  it("translating a repeat whose instances touch the originals moves the instances alone", () => {
    const { stagger, scene } = staggeredRows(10);

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(stagger)).toHaveLength(3);
    expect(centroids(scene)).toEqual([
      [0, 0], [5, 10], [15, 0], [20, 10], [30, 0], [35, 10],
    ]);
  });

  it("translating a repeat whose instances stand clear of the originals moves the instances alone", () => {
    const { stagger, scene } = staggeredRows(10.1);

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(stagger)).toHaveLength(3);
    expect(centroids(scene)).toEqual([
      [0, 0], [5, 10.1], [15, 0], [20, 10.1], [30, 0], [35, 10.1],
    ]);
  });

  it("translating a repeat whose instances merged into the originals moves the merged bodies", () => {
    const { stagger, scene } = staggeredRows(8);

    expect(errorsOf(scene)).toEqual([]);
    // Each instance fused into the post below it: the repeat's bodies are
    // the merged columns, and the translate moves those.
    expect(solidsOf(stagger)).toHaveLength(3);
    expect(centroids(scene)).toEqual([[5, 4], [20, 4], [35, 4]]);
  });
});
