import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import color from "../../core/color.js";
import select from "../../core/select.js";
import cut from "../../core/cut.js";
import { circle } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";

describe("cut().symmetric() regression", () => {
  setupOC();

  it("through-all symmetric cut on a cylinder with hole", () => {
    sketch("xy", () => {
      circle([0, 0], 80);
    });
    const e = extrude(50) as Extrude;

    select(face().circle());
    color("red");

    sketch(e.endFaces(), () => {
      circle([0, 0], 40);
    });

    cut();

    sketch("right", () => {
      circle(20);
    });

    const c = cut().symmetric() as Extrude;
    render();

    const shapes = c.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes[0].getType()).toBe("solid");
  });
});
