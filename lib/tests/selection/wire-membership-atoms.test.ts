import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import loft from "../../core/loft.js";
import fillet from "../../core/fillet.js";
import { circle } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { Extrude } from "../../features/extrude.js";
import { Loft } from "../../features/loft.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { testRect } from "../helpers/profiles.js";
import { edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

/**
 * The top face of a filleted thin loft has two loops of 8 edges each — 4
 * trimmed section lines and 4 fillet arcs apiece. The loops share plane,
 * convexity, curve classes and adjacent face families; only per-edge
 * constants (line length, arc radius) tell them apart, and the induction
 * builds conjunctions only, so no geometric conjunction names a whole loop.
 * The loop predicate does, by topology alone.
 */
function twistedVase() {
  const s = sketch("xy", () => testRect(50, 50, { at: [-25, -25] }));
  const s2 = sketch(plane("xy", { offset: 80 }), () => testRect(30, 30, { at: [-15, -15] }));
  const lf = loft(s, s2).connect(s.geometries.b.end(), s2.geometries.b.start())
    .startCondition("normal").endCondition("normal").thin(-4) as Loft;
  setLocation(lf, 45);
  const outer = fillet(6, lf.sideEdges(edge().convex()));
  setLocation(outer, 46);
  const inner = fillet(4, lf.sideEdges(edge().concave()));
  setLocation(inner, 47);
  return render();
}

const onTop = (m: { z: number }) => Math.abs(m.z - 80) < 1e-6;
const outerRing = (m: { x: number; y: number; z: number }) => onTop(m) && Math.max(Math.abs(m.x), Math.abs(m.y)) > 12.5;

describe("loop atoms: outerOf / holeOf", () => {
  setupOC();

  it("names the outer rim of a reshaped loft end through its loop", () => {
    const scene = twistedVase();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, outerRing);
    expect(refs).toHaveLength(8);
    const result = synthesizeApplyFeature(scene, refs, "chamfer", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("chamfer(1, select(edge().outerOf(lf.endFaces())))");
    }
  });

  it("names the inner rim through the hole loop", () => {
    const scene = twistedVase();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => onTop(m) && !outerRing(m));
    expect(refs).toHaveLength(8);
    const result = synthesizeApplyFeature(scene, refs, "chamfer", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("chamfer(1, select(edge().holeOf(lf.endFaces())))");
    }
  });

  it("a plain box's end rim still goes through the bucket accessor", () => {
    sketch("xy", () => {
      testRect(40, 30);
    });
    const e = extrude(20) as Extrude;
    setLocation(e, 5);
    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 20) < 1e-6);
    expect(refs).toHaveLength(4);
    const result = synthesizeApplyFeature(scene, refs, "chamfer", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("chamfer(1, e.endEdges())");
    }
  });

  it("a bore rim still goes through the cut's own accessor", () => {
    sketch("xy", () => {
      testRect(60, 40);
    });
    const plate = extrude(10) as Extrude;
    setLocation(plate, 5);
    sketch(plate.endFaces(), () => {
      circle([30, 20], 24);
    });
    const bore = cut() as Extrude;
    setLocation(bore, 9);
    const rim = fillet(3, plate.endEdges());
    setLocation(rim, 10);
    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6
      && Math.abs(Math.hypot(m.x - 30, m.y - 20) - 12) < 1e-3);
    expect(refs).toHaveLength(1);
    const result = synthesizeApplyFeature(scene, refs, "chamfer", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      // Tier 0 outranks every filter: the loop atom is only reached when no
      // accessor names the picks.
      expect(result.preview).toBe("chamfer(1, c.startEdges())");
    }
  });
});
