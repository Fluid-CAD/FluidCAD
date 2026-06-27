import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Explorer } from "../../oc/explorer.js";
import { Edge } from "../../common/edge.js";
import { LazySelectionSceneObject } from "../../features/lazy-scene-object.js";
import type { ClassifiedSelection } from "../../selection/selection-explainer.js";

/**
 * Build a plain extruded cylinder and return the rendered solid plus its
 * ordinal edge list (the same enumeration the viewport pick index uses).
 */
function buildExtrudedCylinder() {
  sketch("xy", () => {
    circle(50);
  });
  const e = extrude(10) as Extrude;
  render();

  const solid = e.getAddedShapes().find(s => s.isSolid())!;
  const edges = Explorer.findEdgesWrapped(solid);
  return { e, solid, edges };
}

/** Global ordinal index of `target` in the solid's explorer edge order. */
function globalIndexOf(edges: Edge[], target: Edge): number {
  return edges.findIndex(edge => edge.isSame(target));
}

describe("SelectionExplainer.explainSelection", () => {
  setupOC();

  it("attributes a clicked end edge to endEdges with a round-tripping index", () => {
    const { e, solid, edges } = buildExtrudedCylinder();
    const scene = getCurrentScene()!;

    // The construction-relative truth: the extrude's end-edges bucket.
    const endBucket = e.getState("end-edges") as Edge[];
    expect(endBucket.length).toBeGreaterThan(0);

    // Simulate a viewport click on the first end edge: find its ordinal index.
    const pickedEdge = endBucket[0];
    const pickIndex = globalIndexOf(edges, pickedEdge);
    expect(pickIndex).toBeGreaterThanOrEqual(0);

    const explanation = getSceneManager()!.explainSelection(scene, solid.id, {
      type: "edge",
      index: pickIndex,
    });

    expect(explanation.kind).toBe("classified");
    const classified = explanation as ClassifiedSelection;
    expect(classified.accessor).toBe("endEdges");
    expect(classified.shapeType).toBe("edge");
    expect(classified.featureType).toContain("extrude");

    // Generate-and-test: the synthesized `e.endEdges(index)` must re-resolve to
    // exactly the clicked edge through the real accessor path.
    const selection = e.endEdges(classified.index) as LazySelectionSceneObject;
    selection.build();
    const resolved = selection.getShapes();
    expect(resolved).toHaveLength(1);
    expect(resolved[0].isSame(pickedEdge)).toBe(true);
  });

  it("attributes a clicked side edge to sideEdges", () => {
    const { e, solid, edges } = buildExtrudedCylinder();
    const scene = getCurrentScene()!;

    const sideBucket = e.getState("side-edges") as Edge[];
    expect(sideBucket.length).toBeGreaterThan(0);

    const pickedEdge = sideBucket[0];
    const pickIndex = globalIndexOf(edges, pickedEdge);

    const explanation = getSceneManager()!.explainSelection(scene, solid.id, {
      type: "edge",
      index: pickIndex,
    });

    const classified = explanation as ClassifiedSelection;
    expect(classified.kind).toBe("classified");
    expect(classified.accessor).toBe("sideEdges");

    const selection = e.sideEdges(classified.index) as LazySelectionSceneObject;
    selection.build();
    expect(selection.getShapes()[0].isSame(pickedEdge)).toBe(true);
  });

  it("attributes a clicked end face to endFaces", () => {
    const { e, solid } = buildExtrudedCylinder();
    const scene = getCurrentScene()!;

    const endFaces = e.getState("end-faces") as { isSame: (o: unknown) => boolean }[];
    const faces = Explorer.findFacesWrapped(solid);
    const pickIndex = faces.findIndex(f => endFaces.some(ef => ef.isSame(f)));
    expect(pickIndex).toBeGreaterThanOrEqual(0);

    const explanation = getSceneManager()!.explainSelection(scene, solid.id, {
      type: "face",
      index: pickIndex,
    });

    expect((explanation as ClassifiedSelection).accessor).toBe("endFaces");
  });

  it("returns kind 'none' for an out-of-range pick index", () => {
    const { solid } = buildExtrudedCylinder();
    const scene = getCurrentScene()!;
    const explanation = getSceneManager()!.explainSelection(scene, solid.id, {
      type: "edge",
      index: 9999,
    });
    expect(explanation.kind).toBe("none");
  });

  it("returns kind 'none' for an unknown shape id", () => {
    buildExtrudedCylinder();
    const scene = getCurrentScene()!;
    const explanation = getSceneManager()!.explainSelection(scene, "does-not-exist", {
      type: "edge",
      index: 0,
    });
    expect(explanation.kind).toBe("none");
  });
});
