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
