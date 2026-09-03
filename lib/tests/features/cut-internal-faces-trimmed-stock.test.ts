import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { circle, line } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Face } from "../../common/face.js";

describe("cut internalFaces excludes trimmed stock faces", () => {
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
});
