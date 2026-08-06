import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import copy from "../../core/copy.js";
import fuse from "../../core/fuse.js";
import subtract from "../../core/subtract.js";
import { circle, rect } from "../../core/2d/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Copy2DBase } from "../../features/copy2d-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";

describe("copy 2D instance() accessor", () => {
  setupOC();

  it("fuses two overlapping instances, leaving other geometry alone", () => {
    sketch("xy", () => {
      const c = circle(50);
      const cp = copy("linear", "x", { count: 2, offset: 40 }, c);
      circle([200, 0], 50);
      fuse(cp.instance(0), cp.instance(1));
    });

    const e = extrude(10).new() as ExtrudeBase;

    render();

    // Fused overlapping pair = 1 solid, far circle = 1 solid.
    expect(e.getShapes()).toHaveLength(2);
  });

  it("numbers linear slots in grid order, original included", () => {
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const c = circle(20);
      cpRef = copy("linear", "x", { count: 3, offset: 40 }, c) as unknown as Copy2DBase;
      // Keep the lazies in the scene so they build with the sketch.
      cpRef.instance(0);
      cpRef.instance(2);
    });

    render();

    // Not centered: the original is slot 0, copies walk +x in slot order.
    const centerX = (edges: Edge[]) => {
      const box = ShapeOps.getBoundingBox(edges[0]);
      return (box.minX + box.maxX) / 2;
    };
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(1);
    expect(centerX(cpRef!.getInstanceEdges(0))).toBeCloseTo(0, 3);
    expect(centerX(cpRef!.getInstanceEdges(1))).toBeCloseTo(40, 3);
    expect(centerX(cpRef!.getInstanceEdges(2))).toBeCloseTo(80, 3);
  });

  it("keeps the centered original at its own grid slot", () => {
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const c = circle(20);
      cpRef = copy("linear", "x", { count: 3, offset: 40, centered: true }, c) as unknown as Copy2DBase;
    });

    render();

    const centerX = (edges: Edge[]) => {
      const box = ShapeOps.getBoundingBox(edges[0]);
      return (box.minX + box.maxX) / 2;
    };
    // Centered count 3: slots 0..2 left-to-right, the original in the middle.
    expect(centerX(cpRef!.getInstanceEdges(0))).toBeCloseTo(-40, 3);
    expect(centerX(cpRef!.getInstanceEdges(1))).toBeCloseTo(0, 3);
    expect(centerX(cpRef!.getInstanceEdges(2))).toBeCloseTo(40, 3);
  });

  it("fuses two instances of a multi-edge geometry (rect)", () => {
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const r = rect(20, 20);
      cpRef = copy("linear", "x", { count: 3, offset: 15 }, r) as unknown as Copy2DBase;
      fuse(cpRef.instance(0), cpRef.instance(1));
    });

    render();

    // Slots 0 and 1 overlap (offset 15 < width 20): the fuse consumes both
    // 4-edge blocks and re-emits one merged outline; slot 2 stays owned by
    // the copy untouched.
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(1)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(2)).toHaveLength(4);
  });

  it("fuses instances of a CACHED copy statement (apply-time incremental render)", () => {
    // First render: the file before the apply — circle + copy only.
    sketch("xy", () => {
      const c = circle(50);
      copy("linear", "x", { count: 3, offset: 40 }, c);
    });
    render();
    const previousScene = getSceneManager()!.currentScene;

    // The apply's re-render: the same statements (matched prefix → cached,
    // build skipped, state transferred) plus the new fuse of two instances.
    getSceneManager()!.startScene();
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const c = circle(50);
      cpRef = copy("linear", "x", { count: 3, offset: 40 }, c) as unknown as Copy2DBase;
      fuse(cpRef.instance(0), cpRef.instance(1));
    });
    SceneCompare.compare(previousScene, getSceneManager()!.currentScene);
    render();

    // The scenario is only real if the copy WAS reused (build skipped).
    expect(getSceneManager()!.currentScene.isCached(cpRef!)).toBe(true);

    // The fuse must land on the FIRST incremental render, not only after a
    // full recompute: slots 0+1 consumed, slot 2 untouched.
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(1)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(2)).toHaveLength(1);
  });

  it("numbers circular slots by rotation step and supports subtract", () => {
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const c = circle([30, 0], 25);
      cpRef = copy("circular", [0, 0], { count: 3, offset: 30 }, c) as unknown as Copy2DBase;
      subtract(cpRef.instance(0), cpRef.instance(1));
    });

    render();

    // Steps of 30°: slot 1 overlaps slot 0 (chord ≈ 15.5 < ⌀25), so the
    // subtract consumes both and emits the cut outline; slot 2 survives.
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(1)).toHaveLength(0);
    expect(cpRef!.getInstanceEdges(2)).toHaveLength(1);
  });
});
