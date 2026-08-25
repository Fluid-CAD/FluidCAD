import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import sketch from "../../core/sketch.js";
import copy from "../../core/copy.js";
import { circle, rect, offset } from "../../core/2d/index.js";
import { Copy2DBase } from "../../features/copy2d-base.js";
import { Offset } from "../../features/2d/offset.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";

const centerX = (edges: Edge[]) => {
  const box = ShapeOps.getBoundingBox(edges[0]);
  return (box.minX + box.maxX) / 2;
};

describe("copy 2D instance() accessor", () => {
  setupOC();

  it("resolves a single grid slot, leaving other geometry alone", () => {
    let o: Offset;
    let cpRef: Copy2DBase;
    let src: { getShapes(): unknown[] };
    sketch("xy", () => {
      const c = circle(50);
      src = c as unknown as { getShapes(): unknown[] };
      cpRef = copy("linear", "x", { count: 2, offset: 80 }, c) as unknown as Copy2DBase;
      circle([200, 0], 50);
      o = offset(5, cpRef.instance(1)) as unknown as Offset;
    });

    render();

    // Only slot 1's circle is offset: one new perimeter centered on its slot.
    const offsetEdges = o!.getGeometries();
    expect(offsetEdges).toHaveLength(1);
    expect(centerX(offsetEdges)).toBeCloseTo(80, 1);
    // The accessor never consumes: both slots keep their edges.
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(1);
    expect(cpRef!.getInstanceEdges(1)).toHaveLength(1);
    // Ownership: the original stays with its source statement — the copy
    // owns only the stamped duplicate.
    expect(src!.getShapes()).toHaveLength(1);
    expect(cpRef!.getShapes()).toHaveLength(1);
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

    // Centered count 3: slots 0..2 left-to-right, the original in the middle.
    expect(centerX(cpRef!.getInstanceEdges(0))).toBeCloseTo(-40, 3);
    expect(centerX(cpRef!.getInstanceEdges(1))).toBeCloseTo(0, 3);
    expect(centerX(cpRef!.getInstanceEdges(2))).toBeCloseTo(40, 3);
  });

  it("resolves all edges of a multi-edge geometry's slot (rect)", () => {
    let o: Offset;
    let cpRef: Copy2DBase;
    sketch("xy", () => {
      const r = rect(20, 20);
      cpRef = copy("linear", "x", { count: 3, offset: 40 }, r) as unknown as Copy2DBase;
      o = offset(2, cpRef.instance(1)) as unknown as Offset;
    });

    render();

    // The whole 4-edge block of slot 1 feeds the offset (a closed outline
    // comes back out); every slot keeps its own 4 edges.
    expect(o!.getGeometries().length).toBeGreaterThan(0);
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(4);
    expect(cpRef!.getInstanceEdges(1)).toHaveLength(4);
    expect(cpRef!.getInstanceEdges(2)).toHaveLength(4);
  });

  it("resolves instances of a CACHED copy statement (apply-time incremental render)", () => {
    // First render: the file before the apply — circle + copy only.
    sketch("xy", () => {
      const c = circle(50);
      copy("linear", "x", { count: 3, offset: 40 }, c);
    });
    render();
    const previousScene = getSceneManager()!.currentScene;

    // The apply's re-render: the same statements (matched prefix → cached,
    // build skipped, state transferred) plus the new offset of an instance.
    getSceneManager()!.startScene();
    let cpRef: Copy2DBase;
    let o: Offset;
    sketch("xy", () => {
      const c = circle(50);
      cpRef = copy("linear", "x", { count: 3, offset: 40 }, c) as unknown as Copy2DBase;
      o = offset(5, cpRef.instance(1)) as unknown as Offset;
    });
    SceneCompare.compare(previousScene, getSceneManager()!.currentScene);
    render();

    // The scenario is only real if the copy WAS reused (build skipped).
    expect(getSceneManager()!.currentScene.isCached(cpRef!)).toBe(true);

    // The offset must land on the FIRST incremental render, not only after a
    // full recompute: it resolved slot 1's edge off the transferred state.
    const offsetEdges = o!.getGeometries();
    expect(offsetEdges).toHaveLength(1);
    expect(centerX(offsetEdges)).toBeCloseTo(40, 1);
  });

  it("numbers circular slots by rotation step", () => {
    let o: Offset;
    let cpRef: Copy2DBase;
    let src: { getShapes(): unknown[] };
    sketch("xy", () => {
      const c = circle([30, 0], 25);
      src = c as unknown as { getShapes(): unknown[] };
      cpRef = copy("circular", [0, 0], { count: 3, offset: 30 }, c) as unknown as Copy2DBase;
      o = offset(2, cpRef.instance(1)) as unknown as Offset;
    });

    render();

    // Steps of 30° about the origin: slot 1 sits at 30° → x = 30·cos(30°).
    const offsetEdges = o!.getGeometries();
    expect(offsetEdges).toHaveLength(1);
    expect(centerX(offsetEdges)).toBeCloseTo(30 * Math.cos(Math.PI / 6), 1);
    expect(cpRef!.getInstanceEdges(0)).toHaveLength(1);
    expect(cpRef!.getInstanceEdges(2)).toHaveLength(1);
    // Ownership: the original (slot 0) stays with its source statement.
    expect(src!.getShapes()).toHaveLength(1);
    expect(cpRef!.getShapes()).toHaveLength(2);
  });
});
