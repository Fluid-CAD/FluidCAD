import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, circle, ellipse, extrude, loft, fillet, plane, select } from "../../core/index.js";
import { edge } from "../../filters/index.js";
import { SelectSceneObject } from "../../features/select.js";
import { Edge } from "../../common/edge.js";
import { EdgeQuery } from "../../oc/edge-query.js";
import { testRect } from "../helpers/profiles.js";

/**
 * A loft rebuilds its section edges as B-splines — the straight segments and
 * the R4 corners of a rounded rectangle alike. line() / arc(r) / circle(d)
 * classify by geometry, so those edges still answer to them, while a
 * B-spline that stands for no line or circle (an ellipse's arcs) does not.
 */
describe("line/arc/circle filters on B-spline edges", () => {
  setupOC();

  const z0 = 0;
  const z1 = 20;

  function roundedRectToEllipse() {
    const base = sketch(plane("xy", z0), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
    const top = sketch(plane("xy", z1), () => {
      ellipse([0, 0], 5, 7);
    });
    return loft(base, top).startCondition("normal");
  }

  it("the loft's section edges are B-splines", () => {
    roundedRectToEllipse();
    const base = select(edge().onPlane("xy", z0)) as SelectSceneObject;
    render();
    const edges = base.getShapes() as Edge[];
    expect(edges).toHaveLength(8);
    for (const e of edges) {
      expect(EdgeQuery.getEdgeCurveType(e)).toBe("other");
    }
  });

  it("line() and arc(r) recover the rounded rectangle's segments", () => {
    roundedRectToEllipse();
    const lines = select(edge().onPlane("xy", z0).line()) as SelectSceneObject;
    const longLines = select(edge().onPlane("xy", z0).line(14)) as SelectSceneObject;
    const arcs = select(edge().onPlane("xy", z0).arc(4)) as SelectSceneObject;
    const notArcs = select(edge().onPlane("xy", z0).notArc(4)) as SelectSceneObject;
    const chained = select(edge().onPlane("xy", z0).notArc(4).line()) as SelectSceneObject;
    const wrongRadius = select(edge().onPlane("xy", z0).arc(5)) as SelectSceneObject;
    render();
    expect(lines.getShapes()).toHaveLength(4);
    expect(longLines.getShapes()).toHaveLength(2);
    expect(arcs.getShapes()).toHaveLength(4);
    expect(notArcs.getShapes()).toHaveLength(4);
    expect(chained.getShapes()).toHaveLength(4);
    expect(wrongRadius.getShapes()).toHaveLength(0);
  });

  it("an ellipse's B-spline arcs are neither lines nor arcs", () => {
    roundedRectToEllipse();
    const lines = select(edge().onPlane("xy", z1).line()) as SelectSceneObject;
    const arcs = select(edge().onPlane("xy", z1).arc()) as SelectSceneObject;
    const circles = select(edge().onPlane("xy", z1).circle()) as SelectSceneObject;
    const any = select(edge().onPlane("xy", z1)) as SelectSceneObject;
    render();
    expect(any.getShapes().length).toBeGreaterThan(0);
    expect(lines.getShapes()).toHaveLength(0);
    expect(arcs.getShapes()).toHaveLength(0);
    expect(circles.getShapes()).toHaveLength(0);
  });

  it("circle(d) matches a lofted circular section that stayed one edge", () => {
    const base = sketch(plane("xy", z0), () => {
      circle([0, 0], 20);
    });
    const top = sketch(plane("xy", z1), () => {
      circle([0, 0], 10);
    });
    loft(base, top);
    const bottom = select(edge().onPlane("xy", z0).circle(20)) as SelectSceneObject;
    const upper = select(edge().onPlane("xy", z1).circle(10)) as SelectSceneObject;
    const wrong = select(edge().onPlane("xy", z0).circle(10)) as SelectSceneObject;
    render();
    expect(bottom.getShapes()).toHaveLength(1);
    expect(upper.getShapes()).toHaveLength(1);
    expect(wrong.getShapes()).toHaveLength(0);
  });

  it("a circular section the loft split into arcs answers to arc(r)", () => {
    const base = sketch(plane("xy", z0), () => {
      circle([0, 0], 20);
    });
    const top = sketch(plane("xy", z1), () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    loft(base, top);
    const all = select(edge().onPlane("xy", z0)) as SelectSceneObject;
    const arcs = select(edge().onPlane("xy", z0).arc(10)) as SelectSceneObject;
    const circles = select(edge().onPlane("xy", z0).circle()) as SelectSceneObject;
    render();
    expect(all.getShapes().length).toBeGreaterThan(1);
    expect(arcs.getShapes()).toHaveLength(all.getShapes().length);
    expect(circles.getShapes()).toHaveLength(0);
  });

  it("native edges keep their exact matching", () => {
    sketch("xy", () => {
      testRect(30, 20);
    });
    extrude(5);
    const lines = select(edge().line()) as SelectSceneObject;
    const long = select(edge().line(30)) as SelectSceneObject;
    render();
    expect(lines.getShapes()).toHaveLength(12);
    expect(long.getShapes()).toHaveLength(4);
  });
});
