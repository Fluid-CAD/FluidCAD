import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, line } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { testRect } from "../helpers/profiles.js";

describe("cut classification excludes trimmed stock geometry", () => {
  setupOC();

  it("a bottom ring split by a coplanar-bottom skirt cut stays a stock face", () => {
    // Tube: outer r=42.5, inner r=38, z 0..90.
    sketch("xy", () => {
      circle([0, 0], 85);
      circle([0, 0], 76);
    });
    const e = extrude(90) as Extrude;

    // Skirt cut on yz with its bottom edge on world z=0 (coplanar with the
    // tube's bottom), symmetric through both walls along X.
    sketch("yz", () => {
      line([-25, 0], [25, 0]);
      line([25, 0], [25, 30]);
      line([25, 30], [-25, 30]);
      line([-25, 30], [-25, 0]);
    });
    const c = cut().symmetric() as Extrude;
    const inf = c.internalFaces();
    addToScene(inf);

    render();

    const faces = inf.getShapes() as Face[];
    // The cut carves 3 walls per side (two verticals + a top) through both
    // tube walls: 6 planar faces. The bottom ring remnants are stock faces.
    for (const f of faces) {
      const n = f.calculateNormal();
      const c0 = f.center();
      const isBottomRing = Math.abs(Math.abs(n.z) - 1) < 1e-6 && Math.abs(c0.z) < 1e-6;
      expect(isBottomRing, `bottom ring face at ${JSON.stringify(c0)} classified as internal`).toBe(false);
    }
    expect(faces.length).toBe(6);
    void e;
  });

  it("a rim edge notched by the cut is not a section edge either", () => {
    sketch("xy", () => {
      testRect(100, 50);
    });
    extrude(30);

    // Rebate along the x = 0 top edge (testRect is corner-anchored): both
    // long top-rim edges get trimmed, the top face shrinks to x ∈ [20, 100].
    sketch("xz", () => {
      testRect(20, 10, { at: [0, 25] });
    });
    const c = cut(100) as Extrude;
    const section = c.edges();
    addToScene(section);

    render();

    const edges = section.getShapes() as Edge[];
    const topEdges = edges.filter(ed => Math.abs(EdgeOps.getEdgeMidPoint(ed).z - 30) < 1e-6);
    // Only the rebate's rim edge at x = 20 is cut-created at z = 30; the two
    // trimmed long rim edges descend from the extrude.
    expect(edges).toHaveLength(7);
    expect(topEdges).toHaveLength(1);
    expect(Math.abs(EdgeOps.getEdgeMidPoint(topEdges[0]).x - 20)).toBeLessThan(1e-6);
  });
});
