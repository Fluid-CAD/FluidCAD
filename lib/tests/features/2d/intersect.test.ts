import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import shell from "../../../core/shell.js";
import { arc, intersect, line } from "../../../core/2d/index.js";
import { coincident } from "../../../core/constraints/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Shell } from "../../../features/shell.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Intersect } from "../../../features/2d/intersect.js";
import { Vertex } from "../../../common/vertex.js";
import { Edge } from "../../../common/edge.js";
import { testRect } from "../../helpers/profiles.js";

/** Solved stand-in for legacy `rect(w, h).centered().radius(r)`: four lines
 * and four CCW corner arcs around the origin, exact coordinates. */
function testRoundedRectCentered(w: number, h: number, r: number) {
  const x = w / 2;
  const y = h / 2;
  const segs = [
    line([-(x - r), -y], [x - r, -y]),
    arc([x - r, -y], [x, -(y - r)], [x - r, -(y - r)]),
    line([x, -(y - r)], [x, y - r]),
    arc([x, y - r], [x - r, y], [x - r, y - r]),
    line([x - r, y], [-(x - r), y]),
    arc([-(x - r), y], [-x, y - r], [-(x - r), y - r]),
    line([-x, y - r], [-x, -(y - r)]),
    arc([-x, -(y - r)], [-(x - r), -y], [-(x - r), -(y - r)]),
  ];
  for (let i = 0; i < segs.length; i++) {
    coincident(segs[i].end(), segs[(i + 1) % segs.length].start());
  }
}

describe("intersect", () => {
  setupOC();

  describe("intersect 3D shape with sketch plane", () => {
    it("should produce section edges from a box intersected by a sketch plane", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });

      const e = extrude(30) as Extrude;

      const s = sketch("xy", () => {
        intersect(e);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

  });
});
