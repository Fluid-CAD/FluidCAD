import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { slot, hLine, aLine } from "../../../core/2d/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { getEdgesByType } from "../../utils.js";

describe("slot from edge", () => {
  setupOC();

  it("should create a slot from a horizontal line", () => {
    const s = sketch("xy", () => {
      const l = hLine(60);
      slot(l, 10);
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
  });

  it("should create a slot from an angled line", () => {
    const s = sketch("xy", () => {
      const l = aLine(60, 45);
      slot(l, 10);
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
  });

  it("should keep source line when deleteSource is false", () => {
    const s = sketch("xy", () => {
      const l = hLine(60);
      slot(l, 10, false);
    }) as Sketch;
    render();

    const children = s.getChildren();
    const lineObj = children[0];
    expect(lineObj.getShapes().length).toBeGreaterThan(0);
  });
});
