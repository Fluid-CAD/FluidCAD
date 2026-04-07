import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import { move, rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes } from "../utils.js";

describe("repeat circular", () => {
  setupOC();

  it("should create repeated instances around z axis", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 4, angle: 360 }, e);

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should repeat around y axis", () => {
    sketch("xz", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "y", { count: 4, angle: 360 }, e);

    const scene = render();
    expect(countShapes(scene)).toBe(4);
  });

  it("should space instances over a partial angle", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    // 3 instances over 180° → offset = 90° each
    repeat("circular", "z", { count: 3, angle: 180 }, e);

    const scene = render();
    // Original (1) + 2 repeated = 3
    expect(countShapes(scene)).toBe(3);
  });

  it("should use explicit offset between instances", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 4, offset: 90 }, e);

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should center the pattern around the origin", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 5, angle: 360, centered: true }, e);

    const scene = render();
    // Original (1) + 4 repeated = 5
    expect(countShapes(scene)).toBe(5);
  });

  it("should skip specified indices", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 4, angle: 360, skip: [1] }, e);

    const scene = render();
    // Original (1) + 2 repeated (skipped index 1) = 3
    expect(countShapes(scene)).toBe(3);
  });

  it("should skip multiple indices", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e = extrude(10).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 6, angle: 360, skip: [1, 3] }, e);

    const scene = render();
    // Original (1) + 3 repeated (skipped indices 1 and 3) = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should repeat multiple objects together", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    const e1 = extrude(10).fuse("none") as ExtrudeBase;

    sketch("xy", () => {
      move([50, 20]);
      rect(10, 10);
    });
    const e2 = extrude(5).fuse("none") as ExtrudeBase;

    repeat("circular", "z", { count: 3, angle: 360 }, e1, e2);

    const scene = render();
    // 2 originals + 2 × 2 repeated = 6
    expect(countShapes(scene)).toBe(6);
  });

  it("should use last object when no objects specified", () => {
    sketch("xy", () => {
      move([50, 0]);
      rect(20, 20);
    });
    extrude(10).fuse("none");

    repeat("circular", "z", { count: 4, angle: 360 });

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });
});
