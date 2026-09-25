import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import mirror from "../../../core/mirror.js";
import { line, xAxis, yAxis } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { AxisObjectBase } from "../../../features/axis-renderable-base.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";

// An axis datum inside a sketch is a transform input, consumed for display
// only like every axis: its dashed line stays readable after the mirror hid
// it, so the target-less walks and the curve readers must leave it out.
describe("2D mirror with axis datums", () => {
  setupOC();

  it("never mirrors an axis datum a previous mirror used", () => {
    const s = sketch("xy", () => {
      line([10, 10], [30, 10]);
      mirror(yAxis());
      mirror(xAxis());
    }) as unknown as Sketch;
    render();

    const axes = s.getChildren().filter(c => c instanceof AxisObjectBase);
    expect(axes).toHaveLength(2);
    // Four lines in all — the source, its mirror, and the mirrors of both.
    expect(s.getShapes().filter(sh => sh.isEdge())).toHaveLength(4);
    // The datums keep their own lines for readers; no mirror carries a copy.
    const mirrors = s.getChildren().filter(c => c instanceof MirrorShape2D);
    expect(mirrors).toHaveLength(2);
    for (const m of mirrors) {
      const metaEdges = m.getShapes({ excludeMeta: false }).filter(sh => sh.isMetaShape() && sh.isEdge());
      expect(metaEdges).toHaveLength(0);
    }

  });
});
