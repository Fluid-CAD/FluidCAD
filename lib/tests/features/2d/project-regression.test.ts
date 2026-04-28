import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import cylinder from "../../../core/cylinder.js";
import { project, rect, circle } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Cylinder } from "../../../features/cylinder.js";
import { Shape } from "../../../common/shape.js";
import { Edge } from "../../../common/edge.js";
import { EdgeOps } from "../../../oc/edge-ops.js";

// Asserts no two projected edges share a midpoint within tolerance — a strong
// signal that overlap-dedup ran and removed coincident projections.
function assertNoDuplicateEdges(shapes: Shape[], tol = 1e-5) {
  const mids = shapes
    .filter((s): s is Edge => s instanceof Edge)
    .map(e => EdgeOps.getEdgeMidPoint(e));
  for (let i = 0; i < mids.length; i++) {
    for (let j = i + 1; j < mids.length; j++) {
      const d = mids[i].distanceTo(mids[j]);
      expect(d, `edges ${i} and ${j} share a midpoint (distance ${d})`).toBeGreaterThan(tol);
    }
  }
}

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

    // endFaces() returns top + bottom (both rectangles); they project to the
    // same 4-edge rectangle. Dedup must collapse 8 edges down to 4.
    const edges = shapes.filter(s => s instanceof Edge);
    expect(edges.length).toBe(4);
    assertNoDuplicateEdges(shapes);
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

    assertNoDuplicateEdges(shapes);
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

    assertNoDuplicateEdges(shapes);
  });

  it("dedupes when the same source is projected twice", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30) as Extrude;
    const ef = e.endFaces();

    const s = sketch("xy", () => {
      project(ef, ef);
    }) as Sketch;
    render();

    // Two endFaces × projected twice = 16 raw edges → 4 unique after dedup.
    const edges = s.getShapes().filter(x => x instanceof Edge);
    expect(edges.length).toBe(4);
    assertNoDuplicateEdges(s.getShapes());
  });
});
