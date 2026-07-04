import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import loft from "../../core/loft.js";
import local from "../../core/local.js";
import mirror from "../../core/mirror.js";
import { rect, circle, move, vLine, bezier, polygon } from "../../core/2d/index.js";
import { Loft } from "../../features/loft.js";
import { Sketch } from "../../features/2d/sketch.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { getOC } from "../../oc/init.js";

function volumeOf(l: Loft): number {
  const shapes = l.getShapes();
  expect(shapes).toHaveLength(1);
  return ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
}

/** Two identical circles (diameter 80) at z = 0 and z = 60. */
function circleProfiles() {
  const s1 = sketch("xy", () => {
    circle(80);
  });
  const s2 = sketch(plane("xy", { offset: 60 }), () => {
    circle(80);
  });
  return [s1, s2] as const;
}

describe("loft guides", () => {
  setupOC();

  describe("single guide", () => {
    it("reproduces a cylinder with a straight guide along the side", () => {
      const [s1, s2] = circleProfiles();
      // Straight rail touching both circles at (40, 0, z).
      const guide = sketch("xz", () => {
        move([40, 0]);
        vLine(60);
      });

      const l = loft(s1, s2).guides(guide) as Loft;

      render();

      const cylinder = Math.PI * 40 * 40 * 60;
      expect(Math.abs(volumeOf(l) - cylinder) / cylinder).toBeLessThan(0.02);
    });

    it("follows a bulged guide sideways", () => {
      const [s1, s2] = circleProfiles();
      // Rail bowing out to x ≈ 52.5 at mid-height.
      const guide = sketch("xz", () => {
        bezier([40, 0], [65, 30], [40, 60]);
      });

      const l = loft(s1, s2).guides(guide) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      // The section rides the rail: the mid of the solid shifts in +x,
      // so it must reach past the straight cylinder's x = 40 side.
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX).toBeGreaterThan(46);
      expect(bbox.minZ).toBeCloseTo(0, 0);
      expect(bbox.maxZ).toBeCloseTo(60, 0);

      // Riding a rail translates sections without distorting them, so the
      // volume stays near the straight cylinder's (and a broken sweep frame
      // would show up here as a degenerate or wildly wrong solid).
      const cylinder = Math.PI * 40 * 40 * 60;
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(volume).toBeGreaterThan(cylinder * 0.85);
      expect(volume).toBeLessThan(cylinder * 1.3);
    });

    it("consumes the guide sketch", () => {
      const [s1, s2] = circleProfiles();
      const guide = sketch("xz", () => {
        move([40, 0]);
        vLine(60);
      }) as Sketch;

      loft(s1, s2).guides(guide);

      render();

      expect(guide.getShapes()).toHaveLength(0);
    });

    it("classifies start and end faces", () => {
      const [s1, s2] = circleProfiles();
      const guide = sketch("xz", () => {
        move([40, 0]);
        vLine(60);
      });

      const l = loft(s1, s2).guides(guide) as Loft;
      const sf = l.startFaces();
      const ef = l.endFaces();
      addToScene(sf);
      addToScene(ef);

      render();

      expect(sf.getShapes()).toHaveLength(1);
      expect(ef.getShapes()).toHaveLength(1);
    });
  });

  describe("two guides", () => {
    it("accepts one sketch carrying two separate guide curves (mirror)", () => {
      // Square (corners at ±25√2 on the sketch axes) lofted to a circle,
      // steered by a bezier rail and its mirror sketched together.
      const p1 = sketch("top", () => {
        polygon(4, 50, "circumscribed");
      });
      const p2 = sketch(plane("top", 80), () => {
        circle(30);
      });
      const g1 = sketch("right", () => {
        bezier([Math.sqrt(2) * 25, 0], [50, 40], [15, 80]);
        mirror(local("y"));
      }).reusable();

      const l = loft(p1, p2).guides(g1) as Loft;
      const sides = l.sideFaces();
      addToScene(sides);

      render();

      expect(l.getError()).toBeNull();
      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);
      expect(ShapeProps.getProperties(shapes[0].getShape()).volumeMm3).toBeGreaterThan(0);

      // The square's corners must be real edges: one wall face per side.
      expect(sides.getShapes()).toHaveLength(4);

      // Both rails bow out past the square's corners (±25√2 ≈ ±35.36).
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(Math.max(bbox.maxX, bbox.maxY)).toBeGreaterThan(36);
      expect(Math.min(bbox.minX, bbox.minY)).toBeLessThan(-36);
      expect(bbox.maxZ).toBeCloseTo(80, 0);
    });

    it("keeps the railed corner edges exactly on both rails (vertex matching)", () => {
      const p1 = sketch("top", () => {
        polygon(4, 50, "circumscribed");
      });
      const p2 = sketch(plane("top", 80), () => {
        circle(30);
      });
      const g1 = sketch("right", () => {
        bezier([Math.sqrt(2) * 25, 0], [50, 40], [15, 80]);
        mirror(local("y"));
      }).reusable();

      const l = loft(p1, p2).guides(g1) as Loft;
      const sideEdges = l.sideEdges();
      addToScene(sideEdges);

      render();

      // Rail radius at height z for bezier [(25√2,0),(50,40),(15,80)] (z = 80t).
      const railRadius = (z: number) => {
        const t = z / 80;
        return (1 - t) * (1 - t) * Math.sqrt(2) * 25 + 2 * t * (1 - t) * 50 + t * t * 15;
      };

      // Exactly two corner edges (one per rail) must lie on the rails all
      // the way up — no sideways drift, no radial deviation. The two
      // un-railed corners taper straight and must not match.
      const oc = getOC();
      const point = new oc.gp_Pnt();
      let railedEdges = 0;
      for (const edge of sideEdges.getShapes()) {
        const raw = oc.TopoDS.Edge(edge.getShape());
        const info = oc.BRep_Tool.Curve(raw, 0, 1);

        let maxDeviation = 0;
        for (let i = 0; i <= 16; i++) {
          const t = info.First + ((info.Last - info.First) * i) / 16;
          info.returnValue.D0(t, point);
          const inPlane = Math.max(Math.abs(point.X()), Math.abs(point.Y()));
          const offPlane = Math.min(Math.abs(point.X()), Math.abs(point.Y()));
          maxDeviation = Math.max(
            maxDeviation,
            Math.abs(inPlane - railRadius(point.Z())),
            offPlane,
          );
        }
        if (maxDeviation < 0.1) {
          railedEdges++;
        }
      }
      point.delete();
      expect(railedEdges).toBe(2);
    });

    it("rides both rails, bulging both sides of a rectangular loft", () => {
      const s1 = sketch("xy", () => {
        rect(80, 40).centered();
      });
      const s2 = sketch(plane("xy", { offset: 60 }), () => {
        rect(80, 40).centered();
      });
      const right = sketch("xz", () => {
        bezier([40, 0], [55, 30], [40, 60]);
      });
      const left = sketch("xz", () => {
        bezier([-40, 0], [-55, 30], [-40, 60]);
      });

      const l = loft(s1, s2).guides(right, left) as Loft;

      render();

      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      const prism = 80 * 40 * 60;
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(volume).toBeGreaterThan(prism * 1.02);
      expect(volume).toBeLessThan(prism * 1.5);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX).toBeGreaterThan(42);
      expect(bbox.minX).toBeLessThan(-42);

      // The rails only pull in ±x — the section must not rotate or smear
      // into y (B-rep bounds overshoot control hulls, hence the slack).
      expect(bbox.maxY).toBeLessThan(26);
      expect(bbox.minY).toBeGreaterThan(-26);
    });
  });

  describe("guides with conditions", () => {
    function guidedSquareToCircle(withCondition: boolean) {
      const p1 = sketch("top", () => {
        polygon(4, 50, "circumscribed");
      });
      const p2 = sketch(plane("top", 80), () => {
        circle(30);
      });
      const g1 = sketch("right", () => {
        bezier([Math.sqrt(2) * 25, 0], [50, 40], [15, 80]);
        mirror(local("y"));
      }).reusable();

      // `.new()` — the two variants overlap almost everywhere; fusing two
      // nearly-coincident B-spline solids is exactly the boolean OCC hates.
      const l = loft(p1, p2).guides(g1).new() as Loft;
      if (withCondition) {
        l.startCondition("normal");
      }
      return l;
    }

    it("applies a start condition away from the guide contacts", () => {
      const plain = guidedSquareToCircle(false);
      render();
      expect(plain.getError()).toBeNull();
      const plainVolume = ShapeProps.getProperties(plain.getShapes()[0].getShape()).volumeMm3;

      const conditioned = guidedSquareToCircle(true);
      render();
      expect(conditioned.getError()).toBeNull();
      const shapes = conditioned.getShapes();
      expect(shapes).toHaveLength(1);

      // The normal takeoff swells the un-guided sides of the square, so the
      // conditioned loft encloses more material than the guided-only one —
      // while the rails still pin the bulge to the same overall envelope.
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(volume).toBeGreaterThan(plainVolume * 1.01);
      expect(volume).toBeLessThan(plainVolume * 1.5);
    });

    it("supports conditions on both ends alongside a guide", () => {
      const [s1, s2] = circleProfiles();
      const guide = sketch("xz", () => {
        move([40, 0]);
        vLine(60);
      });

      const l = loft(s1, s2)
        .guides(guide)
        .startCondition("tangent")
        .endCondition("tangent") as Loft;

      render();

      expect(l.getError()).toBeNull();
      const shapes = l.getShapes();
      expect(shapes).toHaveLength(1);

      // Straight rail + tangent bulge: more volume than the plain cylinder,
      // but the rail keeps its side straight so less than the free barrel.
      const cylinder = Math.PI * 40 * 40 * 60;
      const volume = ShapeProps.getProperties(shapes[0].getShape()).volumeMm3;
      expect(volume).toBeGreaterThan(cylinder * 1.05);
    });
  });

  describe("validation", () => {
    it("rejects calling guides() with no arguments", () => {
      const [s1, s2] = circleProfiles();
      expect(() => loft(s1, s2).guides()).toThrow(/at least one guide/);
    });

    it("rejects more than two guides", () => {
      const [s1, s2] = circleProfiles();
      const g1 = sketch("xz", () => { move([40, 0]); vLine(60); });
      const g2 = sketch("xz", () => { move([-40, 0]); vLine(60); });
      const g3 = sketch("yz", () => { move([40, 0]); vLine(60); });

      const l = loft(s1, s2).guides(g1, g2, g3) as Loft;

      render();

      expect(l.getError()).toContain("at most two guide curves");
    });

    it("rejects combining guides with thin mode", () => {
      const [s1, s2] = circleProfiles();
      const guide = sketch("xz", () => { move([40, 0]); vLine(60); });

      const l = loft(s1, s2).guides(guide).thin(-3) as Loft;

      render();

      expect(l.getError()).toContain("thin");
    });
  });
});
