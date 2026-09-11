import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { circle } from "../../core/2d/index.js";
import { Edge } from "../../common/edge.js";
import { edge } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { LazySelectionSceneObject } from "../../features/lazy-scene-object.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { testL, testRect } from "../helpers/profiles.js";

function isVertical(e: Edge): boolean {
  const a = EdgeOps.getVertexPoint(EdgeOps.getFirstVertex(e));
  const b = EdgeOps.getVertexPoint(EdgeOps.getLastVertex(e));
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

describe("convexity filters", () => {
  setupOC();

  it("separates the inner corner of an L extrusion from its outer corners", () => {
    sketch("xy", () => {
        testL();
      });
    const e = extrude(30) as Extrude;
    const inner = select(edge().concave()) as SelectSceneObject;
    const outerVertical = select(edge().convex().verticalTo("xy")) as SelectSceneObject;
    const innerSide = e.sideEdges(edge().concave()) as unknown as LazySelectionSceneObject;
    render();

    const concave = inner.getShapes() as Edge[];
    expect(concave).toHaveLength(1);
    expect(isVertical(concave[0])).toBe(true);
    expect(EdgeOps.getEdgeMidPoint(concave[0]).x).toBeCloseTo(20, 6);
    expect(EdgeOps.getEdgeMidPoint(concave[0]).y).toBeCloseTo(20, 6);

    expect(outerVertical.getShapes()).toHaveLength(5);

    innerSide.build();
    expect(innerSide.getShapes()).toHaveLength(1);
  });

  it("classifies a fused boss's junction as concave and its rim as convex", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(30);
    sketch("xy", () => {
        circle([50, 25], 10);
      });
    extrude(40);
    const junction = select(edge().circle().concave()) as SelectSceneObject;
    const rim = select(edge().circle().convex()) as SelectSceneObject;
    render();

    const inner = junction.getShapes() as Edge[];
    expect(inner).toHaveLength(1);
    expect(EdgeOps.getEdgeMidPoint(inner[0]).z).toBeCloseTo(30, 6);
    const outer = rim.getShapes() as Edge[];
    expect(outer).toHaveLength(1);
    expect(EdgeOps.getEdgeMidPoint(outer[0]).z).toBeCloseTo(40, 6);
  });

  it("finds a fillet's tangent boundaries as smooth", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(30);
    select(edge().verticalTo("xy"));
    fillet(5);
    const smooth = select(edge().smooth()) as SelectSceneObject;
    const sharpVertical = select(edge().notSmooth().verticalTo("xy")) as SelectSceneObject;
    render();

    const boundaries = smooth.getShapes() as Edge[];
    expect(boundaries).toHaveLength(8);
    expect(boundaries.every(isVertical)).toBe(true);
    expect(sharpVertical.getShapes()).toHaveLength(0);
  });
});
