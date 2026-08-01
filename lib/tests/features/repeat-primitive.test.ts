import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import cylinder from "../../core/cylinder.js";
import sphere from "../../core/sphere.js";
import repeat from "../../core/repeat.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";

function buildErrors(scene: Scene): { type: string; err: string | null }[] {
  return scene.getSceneObjects()
    .map(o => ({ type: o.getType(), err: o.getError() }))
    .filter(e => e.err);
}

function solidCentroids(scene: Scene): { x: number; y: number; z: number }[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => {
      const c = ShapeProps.getProperties(sh.getShape()).centroid;
      return { x: Math.round(c.x) + 0, y: Math.round(c.y) + 0, z: Math.round(c.z) + 0 };
    });
}

describe("repeat of primitives", () => {
  setupOC();

  it("linear-repeats a cylinder", () => {
    const c = cylinder(10, 30);
    repeat("linear", "x", { count: 2, offset: 60 }, c as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const centroids = solidCentroids(scene).sort((a, b) => a.x - b.x);
    expect(centroids).toEqual([
      { x: 0, y: 0, z: 15 },
      { x: 60, y: 0, z: 15 },
    ]);
  });

  it("circular-repeats a translated cylinder, applying the rotation after the translate", () => {
    const c = cylinder(5, 20).translate(30, 0, 0);
    repeat("circular", "z", { count: 4, angle: 360 }, c as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const centroids = solidCentroids(scene)
      .sort((a, b) => (a.x - b.x) || (a.y - b.y));
    expect(centroids).toEqual([
      { x: -30, y: 0, z: 10 },
      { x: 0, y: -30, z: 10 },
      { x: 0, y: 30, z: 10 },
      { x: 30, y: 0, z: 10 },
    ]);
  });

  it("marks repeat containers as hide-children with their clones following in scene order", () => {
    const c = cylinder(10, 30);
    repeat("linear", "x", { count: 3, offset: 60 }, c as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const rendered = scene.getRenderedObjects();
    const repeatIndex = rendered.findIndex(r => r.type === "repeat-linear");
    expect(repeatIndex).toBeGreaterThan(-1);

    const repeatRender = rendered[repeatIndex];
    expect(repeatRender.hideChildren).toBe(true);
    expect(rendered.filter(r => r.type !== "repeat-linear").every(r => !r.hideChildren)).toBe(true);

    // The timeline maps a click on the repeat row to a rollback at its last
    // descendant, which relies on clones being emitted after the container.
    const cloneIndexes = rendered
      .map((r, i) => (r.parentId === repeatRender.id ? i : -1))
      .filter(i => i !== -1);
    expect(cloneIndexes.length).toBe(2);
    expect(Math.min(...cloneIndexes)).toBeGreaterThan(repeatIndex);
  });

  it("renders every repeat kind as a single 'Repeat' row hiding its clones", () => {
    const a = cylinder(5, 10);
    repeat("linear", "x", { count: 2, offset: 40 }, a as unknown as SceneObject);
    const b = cylinder(5, 10).translate(0, 60, 0);
    repeat("circular", "z", { count: 3, angle: 360 }, b as unknown as SceneObject);
    const c = sphere(5).translate(0, 0, 60);
    repeat("mirror", "yz", c as unknown as SceneObject);
    const d = sphere(5).translate(0, -60, 0);
    repeat("rotate", "z", 90, d as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const kinds = ["repeat-linear", "repeat-circular", "mirror", "repeat-matrix"];
    const containers = scene.getRenderedObjects().filter(r => kinds.includes(r.type!));
    expect(containers.map(r => r.type)).toEqual(kinds);
    // The kind lives in the statement; every row reads "Repeat" and folds the
    // generated instances away.
    expect(containers.map(r => r.name)).toEqual(kinds.map(() => "Repeat"));
    expect(containers.map(r => r.hideChildren)).toEqual(kinds.map(() => true));

    // The plane the mirror spells inline serves that build alone — internal,
    // so it gets no timeline row beside the Repeat it belongs to.
    const planes = scene.getRenderedObjects().filter(r => r.type === "plane");
    expect(planes.map(r => r.internal)).toEqual([true]);
  });

  it("mirror-repeats a sphere", () => {
    const s = sphere(8).translate(20, 0, 0);
    repeat("mirror", "yz", s as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const centroids = solidCentroids(scene).sort((a, b) => a.x - b.x);
    expect(centroids).toEqual([
      { x: -20, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
    ]);
  });
});
