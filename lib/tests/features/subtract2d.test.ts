import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import subtract from "../../core/subtract.js";
import { circle, rect } from "../../core/2d/index.js";
import { Sketch } from "../../features/2d/sketch.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { ShapeOps } from "../../oc/shape-ops.js";

describe("subtract2d", () => {
  setupOC();

  it("should subtract one circle from another", () => {
    sketch("xy", () => {
      const c1 = circle(60);
      const c2 = circle([30, 0], 40);
      subtract(c1, c2);
    });

    const e = extrude(20) as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getType()).toBe("solid");

    // Result should be narrower than the base circle
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    const width = bbox.maxX - bbox.minX;
    expect(width).toBeLessThan(120);
  });

  it("should subtract a rect from a circle", () => {
    sketch("xy", () => {
      const c1 = circle(60);
      const r1 = rect([0, 0], 40, 40);
      subtract(c1, r1);
    });

    const e = extrude(20) as ExtrudeBase;

    render();

    const shapes = e.getShapes();
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getType()).toBe("solid");
  });

  it("should remove original edges from both operands", () => {
    const s = sketch("xy", () => {
      const c1 = circle(60);
      const c2 = circle([30, 0], 40);
      subtract(c1, c2);
    }) as Sketch;

    render();

    // Original circles should have their edges removed
    const c1Shapes = (s.getChildren()[0] as any).getShapes();
    const c2Shapes = (s.getChildren()[1] as any).getShapes();
    expect(c1Shapes).toHaveLength(0);
    expect(c2Shapes).toHaveLength(0);
  });

  it("should not modify shapes when there is no overlap", () => {
    sketch("xy", () => {
      const c1 = circle(40);
      const c2 = circle([200, 0], 40);
      subtract(c1, c2);
    });

    const e = extrude(20) as ExtrudeBase;

    render();

    // Base circle remains since tool doesn't overlap
    const shapes = e.getShapes();
    expect(shapes).toHaveLength(1);
  });
});
