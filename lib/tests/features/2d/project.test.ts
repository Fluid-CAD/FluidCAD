import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { project, rect } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";

describe("project", () => {
  setupOC();

  describe("project 3D shape onto sketch plane", () => {
    it("should project a box onto the current sketch plane", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const e = extrude(30) as Extrude;

      const s = sketch("xy", () => {
        project(e.sideFaces(0));
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
