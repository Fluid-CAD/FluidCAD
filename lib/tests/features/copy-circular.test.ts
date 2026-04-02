import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import { move, rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { countShapes } from "../utils.js";

describe("copy circular", () => {
  setupOC();

  it("should create copies around an axis", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    copy("circular", "z", { count: 4, angle: 360 }, e);

    const scene = render();

    // Original + 3 copies = 4 shapes
    expect(countShapes(scene)).toBe(4);
  });

  it("should space copies evenly over the given angle", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    // 3 copies over 180° → 60° each
    const c = copy("circular", "z", { count: 3, angle: 180 }, e) as SceneObject;

    render();

    const shapes = c.getShapes();
    expect(shapes).toHaveLength(2);
  });

  it("should skip specified indices", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    copy("circular", "z", { count: 4, angle: 360, skip: [1] }, e);

    const scene = render();

    // Original (1) + 2 copies (skipped index 1) = 3
    expect(countShapes(scene)).toBe(3);
  });
});
