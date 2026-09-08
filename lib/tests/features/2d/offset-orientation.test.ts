import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import shell from "../../../core/shell.js";
import select from "../../../core/select.js";
import { circle, offset, project, origin } from "../../../core/2d/index.js";
import { coincident, diameter } from "../../../core/constraints/index.js";
import { edge } from "../../../filters/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Offset } from "../../../features/2d/offset.js";
import { Extrude } from "../../../features/extrude.js";
import { Edge } from "../../../common/edge.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { testRect } from "../../helpers/profiles.js";

/**
 * A closed wire's offset sign means outward (+) / inward (-) no matter which
 * way the wire runs. BRepOffsetAPI_MakeOffset offsets relative to the
 * direction of travel, so before WireOps.offsetWireOnPlane normalized the
 * direction a clockwise wire offset to the wrong side: a projected hole loop
 * (clockwise on its face) offset by -1 grew instead of shrinking, and a
 * clockwise hand-drawn rectangle did the same.
 */
describe("offset direction independence", () => {
  setupOC();

  it("shrinks a clockwise rectangle with a negative distance", () => {
    let o: Offset;
    sketch("xy", () => {
      // Negative width draws the same square clockwise.
      testRect(-40, 40, { at: [40, 0] });
      o = offset(-5) as unknown as Offset;
    });

    render();

    const boxes = o!.getShapes().map(sh => ShapeOps.getBoundingBox(sh));
    expect(boxes).toHaveLength(4);
    expect(Math.min(...boxes.map(b => b.minX))).toBeCloseTo(5, 0);
    expect(Math.max(...boxes.map(b => b.maxX))).toBeCloseTo(35, 0);
    expect(Math.min(...boxes.map(b => b.minY))).toBeCloseTo(5, 0);
    expect(Math.max(...boxes.map(b => b.maxY))).toBeCloseTo(35, 0);
  });

  it("shrinks a projected hole loop with a negative distance", () => {
    sketch("xy", () => {
      const c = circle([0, 0], 30);
      coincident(c.center(), origin());
      diameter(c, 30);
    });
    const body = extrude(20) as Extrude;
    shell(-2, body.endFaces());
    const rim = select(edge().onPlane(body.endFaces()).circle(26));
    let o: Offset;
    const s = sketch(body.endFaces(), () => {
      const guide = project(rim).guide();
      o = offset(-1, guide) as unknown as Offset;
    }) as unknown as Sketch;

    render();

    expect(s.getError()).toBeNull();
    const edges = o!.getShapes().filter((sh): sh is Edge => sh instanceof Edge);
    expect(edges).toHaveLength(1);
    expect(EdgeQuery.getCircleDataFromEdge(edges[0]).radius).toBeCloseTo(12, 5);
  });
});
