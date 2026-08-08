import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import sketch from "../../../core/sketch.js";
import plane from "../../../core/plane.js";
import { slot, line, hLine, aLine } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Scene } from "../../../rendering/scene.js";

describe("slot from edge", () => {
  setupOC();

  // Build errors are recorded per-object, not thrown out of render() — a
  // sketch keeps its source shapes when the slot fails, so shape-count
  // assertions alone are false positives. Every case must also be error-free.
  const expectNoErrors = (scene: Scene) => {
    const errored = scene.getAllSceneObjects().filter(o => o.getError());
    expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
  };

  it("should create a slot from a horizontal line", () => {
    const s = sketch("xy", () => {
      const l = hLine(60);
      slot(l, 10);
    }) as Sketch;
    expectNoErrors(render());

    expect(s.getShapes().length).toBeGreaterThan(0);
  });

  it("should create a slot from an angled line", () => {
    const s = sketch("xy", () => {
      const l = aLine(45, 60);
      slot(l, 10);
    }) as Sketch;
    expectNoErrors(render());

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
  });

  // Regression: a straight segment has no curvature for
  // BRepOffsetAPI_MakeOffset to infer the offset plane from, so the build
  // must pass the sketch plane as the reference face — without it every
  // straight source failed with "Failed to offset wire" (the dialog's
  // default radius 2 included).
  it("creates a slot from a two-point line at the dialog's default radius", () => {
    const s = sketch("xy", () => {
      const l = line([0, 0], [40, 0]);
      slot(l, 2);
    }) as Sketch;
    expectNoErrors(render());

    expect(s.getShapes().length).toBeGreaterThan(0);
  });

  it("creates a slot on an offset plane", () => {
    const s = sketch(plane("xy", { offset: 25 }) as any, () => {
      const l = line([0, 0], [40, 20]);
      slot(l, 2);
    }) as Sketch;
    expectNoErrors(render());

    expect(s.getShapes().length).toBeGreaterThan(0);
  });

  it("should keep source line when deleteSource is false", () => {
    let removed: Sketch;
    let kept: Sketch;
    removed = sketch("xy", () => {
      const l = hLine(60);
      slot(l, 10);
    }) as Sketch;
    kept = sketch("xy", () => {
      const l = hLine(60);
      slot(l, 10, false);
    }) as Sketch;
    expectNoErrors(render());

    // The kept sketch carries the same slot outline plus the source edge.
    expect(kept!.getShapes().length).toBe(removed!.getShapes().length + 1);
    const lineObj = kept!.getChildren()[0];
    expect(lineObj.getShapes().length).toBeGreaterThan(0);
  });

  // Regression: createCopy must remap the source to its new-scene
  // counterpart (and declare it as a dependency) — a cached re-render
  // otherwise offsets the previous render's disposed shapes.
  it("survives a cached re-render", () => {
    const buildScene = () => {
      sketch("xy", () => {
        const l = line([0, 0], [40, 0]);
        slot(l, 2);
      });
    };
    buildScene();
    expectNoErrors(render());

    const mgr = getSceneManager()!;
    const previousScene = mgr.currentScene;
    const newScene = mgr.startScene();
    buildScene();
    SceneCompare.compare(previousScene, newScene);
    expectNoErrors(render());
  });
});
