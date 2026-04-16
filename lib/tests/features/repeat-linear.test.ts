import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import { rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes } from "../utils.js";

describe("repeat linear", () => {
  setupOC();

  it("should repeat along x axis with offset", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    repeat("linear", "x", { count: 3, offset: 40 }, e);

    const scene = render();
    // Original (1) + 2 repeated = 3
    expect(countShapes(scene)).toBe(3);
  });

  it("should repeat along y axis", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    repeat("linear", "y", { count: 3, offset: 40 }, e);

    const scene = render();
    expect(countShapes(scene)).toBe(3);
  });

  it("should repeat along z axis", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    repeat("linear", "z", { count: 3, offset: 40 }, e);

    const scene = render();
    expect(countShapes(scene)).toBe(3);
  });

  it("should distribute instances by total length", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 4 instances over length 120 → offset = 120 / 3 = 40
    repeat("linear", "x", { count: 4, length: 120 }, e);

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should create a 2D grid with multiple axes", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3 along X × 2 along Y = 6 positions, minus origin = 5 clones
    repeat("linear", ["x", "y"], { count: [3, 2], offset: 30 }, e);

    const scene = render();
    // Original (1) + 5 repeated = 6
    expect(countShapes(scene)).toBe(6);
  });

  it("should use single count for all axes when count is a single-element array", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // count: [2] shared for both axes → 2×2 = 4 positions, minus origin = 3 clones
    repeat("linear", ["x", "y"], { count: [2], offset: 30 }, e);

    const scene = render();
    // Original (1) + 3 repeated = 4
    expect(countShapes(scene)).toBe(4);
  });

  it("should support per-axis length arrays", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // x: count=3, length=60 → offset=30; y: count=2, length=40 → offset=40
    repeat("linear", ["x", "y"], { count: [3, 2], length: [60, 40] }, e);

    const scene = render();
    // 3×2 = 6, minus origin = 5 clones + 1 original = 6
    expect(countShapes(scene)).toBe(6);
  });

  it("should center the pattern around the origin", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    repeat("linear", "x", { count: 5, offset: 20, centered: true }, e);

    const scene = render();
    // Original (1) + 4 repeated = 5
    expect(countShapes(scene)).toBe(5);
  });

  it("should center correctly with count 3", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // count: 3, centered → one clone on each side of the original
    repeat("linear", "x", { count: 3, offset: 25, centered: true }, e);

    const scene = render();
    // Original (1) + 2 repeated = 3
    expect(countShapes(scene)).toBe(3);
  });

  it("should center correctly in a multi-axis grid", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3×3 centered grid → 9 positions, 1 is the center (original) = 8 clones
    repeat("linear", ["x", "y"], { count: [3, 3], offset: 30, centered: true }, e);

    const scene = render();
    // Original (1) + 8 repeated = 9
    expect(countShapes(scene)).toBe(9);
  });

  it("should skip specified index", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3 instances, skip index [1]
    repeat("linear", "x", { count: 3, offset: 40, skip: [[1]] }, e);

    const scene = render();
    // Original (1) + 1 repeated (skipped index 1, kept index 2) = 2
    expect(countShapes(scene)).toBe(2);
  });

  it("should skip positions in a multi-axis grid", () => {
    sketch("xy", () => {
      rect(10, 10);
    });
    const e = extrude(10).new() as ExtrudeBase;

    // 3×2 grid, skip position [1,1]
    repeat("linear", ["x", "y"], { count: [3, 2], offset: 30, skip: [[1, 1]] }, e);

    const scene = render();
    // 6 positions - 1 origin - 1 skipped = 4 clones + 1 original = 5
    expect(countShapes(scene)).toBe(5);
  });

  it("should repeat multiple objects together", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e1 = extrude(10).new() as ExtrudeBase;

    sketch("xy", () => {
      rect(10, 10);
    });
    const e2 = extrude(5).new() as ExtrudeBase;

    repeat("linear", "x", { count: 3, offset: 40 }, e1, e2);

    const scene = render();
    // 2 originals + 2 × 2 repeated = 6
    expect(countShapes(scene)).toBe(6);
  });

  it("should use last object when no objects specified", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    extrude(10).new();

    repeat("linear", "x", { count: 3, offset: 40 });

    const scene = render();
    // Original (1) + 2 repeated = 3
    expect(countShapes(scene)).toBe(3);
  });
});
