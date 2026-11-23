import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import cylinder from "../../core/cylinder.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import type { Extrude } from "../../features/extrude.js";
import { Scene } from "../../rendering/scene.js";
import { SceneBounds } from "../../validation/scene-bounds.js";

function assertClean(scene: Scene): void {
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
}

describe("SceneBounds — part files", () => {
  setupOC();

  it("bounds every solid the scene renders, exactly on a curved body", () => {
    sketch("xy", () => {
      testRect(20, 30);
    });
    extrude(10);
    cylinder(5, 40).translate(50, 0, 0);
    const scene = render();
    assertClean(scene);
    // The mesh of a cylinder stops short of its radius; these do not.
    expect(SceneBounds.of(scene)).toEqual({ min: [0, -5, 0], max: [55, 30, 40] });
    expect(getSceneManager().getRenderedBounds(scene)).toEqual({ min: [0, -5, 0], max: [55, 30, 40] });
  });

  it("leaves out a solid a later cut consumed, and is null without a solid", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    const box = extrude(30) as Extrude;
    // Cut the top 20 away over the whole footprint: what renders is 10 tall.
    sketch(box.endFaces(), () => {
      testRect(20, 20);
    });
    cut(20);
    const scene = render();
    assertClean(scene);
    expect(SceneBounds.of(scene)).toEqual({ min: [0, 0, 0], max: [20, 20, 10] });

    getSceneManager().startScene();
    sketch("xy", () => {
      testRect(5, 5);
    });
    expect(SceneBounds.of(render())).toBeNull();
  });
});

describe("SceneBounds — assemblies", () => {
  setupOC();

  it("bounds each instance where it is placed, a turned one included", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("bar", () => {
      sketch("xy", () => {
        testRect(40, 10);
      });
      extrude(5);
    });
    insert(def);
    insert(def).rotate("z", 90).translate(100, 0, 0);
    render();
    assertClean(scene);
    // The second bar stands on end along Y: x from 90 to 100, y from 0 to 40.
    expect(SceneBounds.of(scene)).toEqual({ min: [0, 0, 0], max: [100, 40, 5] });
  });
});
