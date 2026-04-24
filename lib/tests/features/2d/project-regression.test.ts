import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import cylinder from "../../../core/cylinder.js";
import { project, rect, circle } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Cylinder } from "../../../features/cylinder.js";
import { Edge } from "../../../common/edge.js";
import { EdgeOps } from "../../../oc/edge-ops.js";

describe("project — regression: all projected edges land on sketch plane", () => {
  setupOC();

  it("projects endFaces of a plain extrude onto z=0 (the sketch plane)", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30) as Extrude;

    const s = sketch("xy", () => {
      project(e.endFaces());
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);

    // Every projected edge midpoint should lie on z=0.
    for (const shape of shapes) {
      if (shape instanceof Edge) {
        const mid = EdgeOps.getEdgeMidPoint(shape);
        expect(mid.z).toBeCloseTo(0, 4);
      }
    }
  });

  it("projects endFaces of an extrude fused with a cylinder onto z=0", () => {
    // Mirrors the user's scenario: complex shape built by fusing an extrude
    // with an existing cylinder, then projecting faces back onto the sketch plane.
    cylinder(15, 40) as Cylinder;

    sketch("xy", () => {
      rect(80, 40);
    });
    const e = extrude(20) as Extrude;

    const s = sketch("xy", () => {
      project(e.endFaces());
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);

    for (const shape of shapes) {
      if (shape instanceof Edge) {
        const mid = EdgeOps.getEdgeMidPoint(shape);
        expect(mid.z).toBeCloseTo(0, 4);
      }
    }
  });

  it("projects sideFaces including a cylindrical one onto z=0", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    const e = extrude(30) as Extrude;

    const s = sketch("xy", () => {
      project(e.sideFaces());
    }) as Sketch;
    render();

    const shapes = s.getShapes();
    expect(shapes.length).toBeGreaterThan(0);

    for (const shape of shapes) {
      if (shape instanceof Edge) {
        const mid = EdgeOps.getEdgeMidPoint(shape);
        expect(mid.z).toBeCloseTo(0, 4);
      }
    }
  });
});
