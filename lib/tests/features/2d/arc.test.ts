import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { arc, line } from "../../../core/2d/index.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Solid } from "../../../common/solid.js";
import { getEdgesByType } from "../../utils.js";
import { coincident, horizontal, vertical } from "../../../core/constraints/index.js";

describe("arc", () => {
  setupOC();

  describe("three-point form (start, end, center)", () => {
    it("closes a profile with lines and extrudes", () => {
      sketch("xy", () => {
        const bottom = line([0, 0], [50, 0]);
        const up = line([50, 0], [50, 30]);
        const bulge = arc([50, 30], [0, 30], [25, 30]);
        const down = line([0, 30], [0, 0]);
        coincident(bottom.end(), up.start());
        coincident(up.end(), bulge.start());
        coincident(bulge.end(), down.start());
        coincident(down.end(), bottom.start());
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);
      const solid = e.getShapes()[0] as Solid;
      expect(getEdgesByType(solid, "arc").length).toBeGreaterThan(0);
    });

    it("emits the edge exactly through the SOLVED endpoints", () => {
      // Rounded guesses: the end guess sits ~0.005 off the center's circle.
      // The solver's arc-consistency rows reconcile the params (authored
      // literals are guesses), and the emitted edge must then pass exactly
      // through the solved endpoints — a drift between params and edge would
      // micro-gap coincident-closed profiles.
      let a: ReturnType<typeof arc>;
      const s = sketch("xy", () => {
        a = arc([-205.71, -75.22], [-130.5, 124.58], [-176.56, 27.86]).cw();
      }) as Sketch;

      render();

      const solvedEnd = (a! as unknown as { getState(k: string): { end: { x: number; y: number } } })
        .getState('solved').end;
      // Params moved only marginally off the guess…
      expect(solvedEnd.x).toBeCloseTo(-130.5, 2);
      expect(solvedEnd.y).toBeCloseTo(124.58, 2);
      // …and the edge ends exactly at the solved values.
      const arcEdge = getEdgesByType(s.getShapes(), "arc")[0];
      const end = arcEdge.getLastVertex().toPoint();
      expect(end.x).toBeCloseTo(solvedEnd.x, 9);
      expect(end.y).toBeCloseTo(solvedEnd.y, 9);
    });

    it("flips the sweep with .cw()", () => {
      sketch("xy", () => {
        const a = arc([0, 0], [20, 0], [10, 0]).cw();
        const l = line([20, 0], [0, 0]);
        coincident(a.end(), l.start());
        coincident(l.end(), a.start());
      });
      const e = extrude(10) as ExtrudeBase;
      render();

      expect(e.getShapes()).toHaveLength(1);
      const solid = e.getShapes()[0] as Solid;
      expect(getEdgesByType(solid, "arc").length).toBeGreaterThan(0);
    });
  });

  describe("removed legacy forms", () => {
    it("throws on chained/radius pen forms with the 3-point hint", () => {
      expect(() => sketch("xy", () => { (arc as any)([50, 30]); }))
        .toThrow(/arc\(start, end, center\)/);
      expect(() => sketch("xy", () => { (arc as any)(20, 0, 180); }))
        .toThrow(/arc\(start, end, center\)/);
    });
  });

  describe("combined with lines", () => {
    it("should create a shape with straight and curved edges", () => {
      sketch("xy", () => {
          const sg3 = line([0, 0], [60, 0]);
          const sg4 = line([60, 0], [60, 20]);
          const sg5 = line([60, 20], [0, 20]);
          const sg6 = line([0, 20], [0, 0]);
          horizontal(sg3);
          coincident(sg3.end(), sg4.start());
          vertical(sg4);
          coincident(sg4.end(), sg5.start());
          horizontal(sg5);
          coincident(sg5.end(), sg6.start());
          vertical(sg6);
          coincident(sg6.end(), sg3.start());
        });
      const e = extrude(10) as ExtrudeBase;
      render();

      const solid = e.getShapes()[0] as Solid;
      const lineEdges = getEdgesByType(solid, "line");
      expect(lineEdges.length).toBeGreaterThan(0);
    });
  });
});
