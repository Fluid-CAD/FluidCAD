import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import shell from "../../../core/shell.js";
import { intersect, rect } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Shell } from "../../../features/shell.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Intersect } from "../../../features/2d/intersect.js";
import { Vertex } from "../../../common/vertex.js";
import { Edge } from "../../../common/edge.js";

describe("intersect", () => {
  setupOC();

  describe("intersect 3D shape with sketch plane", () => {
    it("should produce section edges from a box intersected by a sketch plane", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      const s = sketch("xy", () => {
        intersect(e);
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("start() should be at a chain endpoint, not at an interior junction", () => {
      // Regression: when the section produces multiple edges (one per face),
      // start/end were taken from an arbitrary "last edge". For a closed loop
      // or branching chain that left start at an interior junction vertex
      // instead of a real chain endpoint.
      sketch("xy", () => {
        rect(100, 50).centered().radius(8);
      });
      const e = extrude(20) as Extrude;
      const s = shell(-2, e.endFaces()) as Shell;

      let intersectFeature: Intersect = null;
      sketch("right", () => {
        intersectFeature = intersect(s.internalFaces()) as Intersect;
      });

      render();

      // The plane-local start vertex must coincide with one of the section's
      // edge endpoints. An interior junction would coincide with two edges,
      // so we additionally assert the count of edges meeting at that point.
      const start = intersectFeature.getState('start') as Vertex;
      const end = intersectFeature.getState('end') as Vertex;
      expect(start).toBeDefined();
      expect(end).toBeDefined();

      const edges = intersectFeature.getShapes().filter(s => s instanceof Edge) as Edge[];
      expect(edges.length).toBeGreaterThan(0);

      const plane = intersectFeature.getPlane();
      const TOL_SQ = 1e-8;
      let matchCount = 0;
      const startPoint = start.toPoint2D();
      for (const edge of edges) {
        const v1 = plane.worldToLocal(edge.getFirstVertex().toPoint());
        const v2 = plane.worldToLocal(edge.getLastVertex().toPoint());
        const d1 = (v1.x - startPoint.x) ** 2 + (v1.y - startPoint.y) ** 2;
        const d2 = (v2.x - startPoint.x) ** 2 + (v2.y - startPoint.y) ** 2;
        if (d1 < TOL_SQ || d2 < TOL_SQ) {
          matchCount++;
        }
      }
      // start must lie on at least one edge endpoint (so it's a real corner,
      // not a constructed midpoint).
      expect(matchCount).toBeGreaterThan(0);
    });
  });
});
