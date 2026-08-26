import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import extrude from "../../core/extrude.js";
import { circle } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { countShapes } from "../utils.js";
import { ShapeProps } from "../../oc/props.js";
import { testRect } from "../helpers/profiles.js";

/** Volume of the loft's single solid. */
function volumeOf(l: Loft): number {
  const shapes = l.getShapes();
  expect(shapes).toHaveLength(1);
  return ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
}

function circlePair(diameter1: number, diameter2: number, height: number) {
  const s1 = sketch("xy", () => {
      circle([0, 0], diameter1);
    });
  const s2 = sketch(plane("xy", { offset: height }), () => {
      circle([0, 0], diameter2);
    });
  return [s1, s2] as const;
}

describe("loft start/end conditions", () => {
  setupOC();

  describe("normal condition", () => {
    it("reproduces an exact cylinder for identical stacked circles", () => {
      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).startCondition("normal").endCondition("normal") as Loft;

      render();

      // Perpendicular takeoff + identical profiles ⇒ straight sides.
      const expected = Math.PI * 40 * 40 * 50;
      expect(Math.abs(volumeOf(l) - expected) / expected).toBeLessThan(1e-4);
    });

    it("reproduces an exact box for identical stacked rectangles", () => {
      const s1 = sketch("xy", () => {
          testRect(100, 50, { at: [-50, -25] });
        });
      const s2 = sketch(plane("xy", { offset: 40 }), () => {
          testRect(100, 50, { at: [-50, -25] });
        });
      const l = loft(s1, s2).startCondition("normal").endCondition("normal") as Loft;
      const sides = l.sideFaces();
      addToScene(sides);

      render();

      const expected = 100 * 50 * 40;
      expect(Math.abs(volumeOf(l) - expected) / expected).toBeLessThan(1e-4);

      // Profile corners split the wall into one face per side, so the
      // corners are real edges (renderable, selectable, filletable).
      expect(sides.getShapes()).toHaveLength(4);
    });

    it("bulges a tapered loft outward compared to the unconstrained loft", () => {
      const [p1, p2] = circlePair(80, 40, 50);
      const plain = loft(p1, p2) as Loft;
      render();
      const plainVolume = volumeOf(plain);

      const [c1, c2] = circlePair(80, 40, 50);
      const conditioned = loft(c1, c2).startCondition("normal").endCondition("normal") as Loft;
      render();

      // Perpendicular takeoff at both ends swells the taper's waist.
      expect(volumeOf(conditioned)).toBeGreaterThan(plainVolume * 1.02);
    });
  });

  describe("tangent condition", () => {
    it("turns identical stacked circles into a barrel", () => {
      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).startCondition("tangent").endCondition("tangent") as Loft;

      render();

      const cylinder = Math.PI * 40 * 40 * 50;
      const volume = volumeOf(l);
      expect(volume).toBeGreaterThan(cylinder * 1.1);
      expect(volume).toBeLessThan(cylinder * 2.0);
    });

    it("bulges more with a larger magnitude", () => {
      const [s1, s2] = circlePair(80, 80, 50);
      const smaller = loft(s1, s2).startCondition("tangent", 0.5).endCondition("tangent", 0.5) as Loft;
      render();
      const smallerVolume = volumeOf(smaller);

      const [b1, b2] = circlePair(80, 80, 50);
      const bigger = loft(b1, b2).startCondition("tangent", 1.5).endCondition("tangent", 1.5) as Loft;
      render();

      expect(volumeOf(bigger)).toBeGreaterThan(smallerVolume * 1.05);
    });

    it("pinches inward with a negative magnitude", () => {
      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).startCondition("tangent", -1).endCondition("tangent", -1) as Loft;

      render();

      const cylinder = Math.PI * 40 * 40 * 50;
      expect(volumeOf(l)).toBeLessThan(cylinder * 0.9);
    });
  });

  describe("single-ended and mixed conditions", () => {
    it("supports a start condition alone", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      const l = loft(s1, s2).startCondition("normal") as Loft;

      render();

      expect(volumeOf(l)).toBeGreaterThan(0);
    });

    it("supports an end condition alone", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      const l = loft(s1, s2).endCondition("tangent") as Loft;

      render();

      expect(volumeOf(l)).toBeGreaterThan(0);
    });

    it("resets a condition with 'none'", () => {
      const [p1, p2] = circlePair(80, 80, 50);
      const plain = loft(p1, p2) as Loft;
      render();
      const plainVolume = volumeOf(plain);

      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).startCondition("tangent").startCondition("none") as Loft;
      render();

      expect(Math.abs(volumeOf(l) - plainVolume) / plainVolume).toBeLessThan(1e-3);
    });
  });

  describe("mixed profile kinds", () => {
    it("lofts a rectangle to a circle with conditions (polynomial fallback)", () => {
      const s1 = sketch("xy", () => {
          testRect(60, 60, { at: [-30, -30] });
        });
      const s2 = sketch(plane("xy", { offset: 50 }), () => {
          circle([0, 0], 60);
        });
      const l = loft(s1, s2).startCondition("normal").endCondition("normal") as Loft;

      render();

      const volume = volumeOf(l);
      // Between the two prisms the shape must live inside.
      expect(volume).toBeGreaterThan(Math.PI * 30 * 30 * 50 * 0.5);
      expect(volume).toBeLessThan(60 * 60 * 50 * 1.5);
    });

    it("lofts through three profiles with end conditions", () => {
      const s1 = sketch("xy", () => {
          circle([0, 0], 60);
        });
      const s2 = sketch(plane("xy", { offset: 25 }), () => {
          circle([0, 0], 100);
        });
      const s3 = sketch(plane("xy", { offset: 50 }), () => {
          circle([0, 0], 60);
        });
      const l = loft(s1, s2, s3).startCondition("normal").endCondition("normal") as Loft;

      render();

      expect(volumeOf(l)).toBeGreaterThan(0);
    });
  });

  describe("classification and scene interplay", () => {
    it("classifies start, end and side faces", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      const l = loft(s1, s2).startCondition("normal").endCondition("normal") as Loft;
      const sf = l.startFaces();
      const ef = l.endFaces();
      const sidf = l.sideFaces();
      addToScene(sf);
      addToScene(ef);
      addToScene(sidf);

      render();

      expect(sf.getShapes()).toHaveLength(1);
      expect(ef.getShapes()).toHaveLength(1);
      expect(sidf.getShapes().length).toBeGreaterThan(0);
    });

    it("fuses with existing scene geometry", () => {
      const base = sketch("xy", () => {
          testRect(200, 200, { at: [-100, -100] });
        });
      extrude(-20, base);

      const [s1, s2] = circlePair(80, 40, 50);
      loft(s1, s2).startCondition("tangent") as Loft;

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("cuts with remove mode", () => {
      const base = sketch("xy", () => {
          testRect(200, 200, { at: [-100, -100] });
        });
      extrude(50, base);

      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).startCondition("normal").endCondition("normal").remove() as Loft;

      render();

      // Normal-normal between identical circles is an exact cylinder, so the
      // cut leaves the box volume minus the cylinder.
      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      const remaining = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      const expected = 200 * 200 * 50 - Math.PI * 40 * 40 * 50;
      expect(Math.abs(remaining - expected) / expected).toBeLessThan(1e-3);
    });
  });

  describe("thin loft with conditions", () => {
    it("builds a thin square-to-circle transition without booleans", () => {
      const p1 = sketch("xy", () => {
          testRect(70, 70, { at: [-35, -35] });
        });
      const p2 = sketch(plane("xy", { offset: 80 }), () => {
          circle([0, 0], 30);
        });

      const l = loft(p1, p2).startCondition("normal", 1).thin(2) as Loft;
      const sides = l.sideFaces();
      const caps = l.startFaces();
      addToScene(sides);
      addToScene(caps);

      render();

      expect(l.getError()).toBeNull();
      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      // A ~2mm wall over an ~80-tall transition: far less material than the
      // filled loft, far more than nothing. (The walls + ring caps are
      // assembled directly — a boolean between the two shells used to take
      // seconds.)
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(volume).toBeGreaterThan(10000);
      expect(volume).toBeLessThan(60000);

      // The outward offset rounds the outer wall's corners into arcs; the
      // line→arc curvature jumps must still split faces (8 outer: 4 flats +
      // 4 corner bands) alongside the sharp inner wall's 4 — otherwise the
      // outer corners render smeared with no edges to select.
      expect(sides.getShapes()).toHaveLength(12);
      expect(caps.getShapes()).toHaveLength(1);
    });

    it("builds a thin-walled barrel", () => {
      const [s1, s2] = circlePair(80, 80, 50);
      const l = loft(s1, s2).thin(-4).startCondition("tangent").endCondition("tangent") as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      const solidBarrelUpperBound = Math.PI * 40 * 40 * 50 * 2;
      expect(volume).toBeGreaterThan(0);
      expect(volume).toBeLessThan(solidBarrelUpperBound * 0.5);
    });
  });

  describe("validation", () => {
    it("rejects a magnitude with 'none'", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      expect(() => loft(s1, s2).startCondition("none", 2)).toThrow(/magnitude has no effect/);
    });

    it("rejects unknown condition types", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      expect(() => loft(s1, s2).startCondition("smooth" as any)).toThrow(/expected 'none', 'normal' or 'tangent'/);
    });

    it("rejects a zero magnitude", () => {
      const [s1, s2] = circlePair(80, 40, 50);
      expect(() => loft(s1, s2).endCondition("normal", 0)).toThrow(/non-zero/);
    });
  });
});
