import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import helix from "../../core/helix.js";
import sweep from "../../core/sweep.js";
import cylinder from "../../core/cylinder.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { circle, hLine } from "../../core/2d/index.js";
import { Helix } from "../../features/helix.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Edge } from "../../common/edge.js";

// Bounding boxes are computed from the triangulated mesh of the helix edge,
// so they're slightly larger than the analytic extents (~0.2 mm typical).
const MESH_TOL = 0.5;

describe("helix", () => {
  setupOC();

  describe("axis input", () => {
    it("should create a helix wire with default radius and height", () => {
      const h = helix("z").pitch(5).turns(4) as Helix;
      render();
      const shapes = h.getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0]).toBeInstanceOf(Edge);
    });

    it("should produce a helix whose axial extent equals pitch * turns", () => {
      const h = helix("z").pitch(5).turns(4) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(20 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(20 + MESH_TOL);
    });

    it("should use the provided .radius() for cylindrical helix", () => {
      const h = helix("z").radius(15).pitch(5).turns(4) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(30 + MESH_TOL);
      expect(bbox.maxY - bbox.minY).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxY - bbox.minY).toBeLessThanOrEqual(30 + MESH_TOL);
    });

    it("should default radius to 20 when not specified", () => {
      const h = helix("z").pitch(5).turns(4) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(40 - MESH_TOL);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(40 + MESH_TOL);
    });

    it("should default height to 50 when only turns is given", () => {
      const h = helix("z").turns(4) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(50 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(50 + MESH_TOL);
    });

    it("should respect explicit .height() over pitch * turns", () => {
      const h = helix("z").pitch(5).turns(4).height(30) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(30 + MESH_TOL);
    });

    it("should produce a conical helix when endRadius differs from radius", () => {
      const h = helix("z").radius(20).endRadius(10).turns(4).height(30) as Helix;
      render();
      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      // The helix curve is bounded by the cone's start radius (20) at the base;
      // its diameter is at most 40 and strictly greater than the end diameter (20).
      const diameterX = bbox.maxX - bbox.minX;
      expect(diameterX).toBeGreaterThan(20);
      expect(diameterX).toBeLessThanOrEqual(40 + MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(30 + MESH_TOL);
    });
  });

  describe("offsets", () => {
    it("should extend the helix axially by .endOffset()", () => {
      const base = helix("z").pitch(5).turns(4) as Helix;
      render();
      const baseHeight = ShapeOps.getBoundingBox(base.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(base.getShapes()[0]).minZ;

      const extended = helix("z").pitch(5).turns(4).endOffset(10) as Helix;
      render();
      const extendedHeight = ShapeOps.getBoundingBox(extended.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(extended.getShapes()[0]).minZ;

      expect(extendedHeight - baseHeight).toBeGreaterThanOrEqual(10 - MESH_TOL);
      expect(extendedHeight - baseHeight).toBeLessThanOrEqual(10 + MESH_TOL);
    });

    it("should trim the helix start by positive .startOffset()", () => {
      const base = helix("z").pitch(5).turns(4) as Helix;
      render();
      const baseHeight = ShapeOps.getBoundingBox(base.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(base.getShapes()[0]).minZ;

      const trimmed = helix("z").pitch(5).turns(4).startOffset(5) as Helix;
      render();
      const trimmedHeight = ShapeOps.getBoundingBox(trimmed.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(trimmed.getShapes()[0]).minZ;

      expect(baseHeight - trimmedHeight).toBeGreaterThanOrEqual(5 - MESH_TOL);
      expect(baseHeight - trimmedHeight).toBeLessThanOrEqual(5 + MESH_TOL);
    });

    it("should extend the helix start by negative .startOffset()", () => {
      const base = helix("z").pitch(5).turns(4) as Helix;
      render();
      const baseHeight = ShapeOps.getBoundingBox(base.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(base.getShapes()[0]).minZ;

      const extended = helix("z").pitch(5).turns(4).startOffset(-10) as Helix;
      render();
      const extendedHeight = ShapeOps.getBoundingBox(extended.getShapes()[0]).maxZ
        - ShapeOps.getBoundingBox(extended.getShapes()[0]).minZ;

      expect(extendedHeight - baseHeight).toBeGreaterThanOrEqual(10 - MESH_TOL);
      expect(extendedHeight - baseHeight).toBeLessThanOrEqual(10 + MESH_TOL);
    });
  });

  describe("cylindrical face input", () => {
    it("should derive axis, radius, and height from a cylinder face", () => {
      cylinder(15, 60);
      const sel = select(face().cylinder());
      const h = helix(sel).turns(6) as Helix;
      render();

      const shapes = h.getShapes();
      expect(shapes).toHaveLength(1);

      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(30 + MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(60 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(60 + MESH_TOL);
    });

    it("should extend below/above the cylinder with offsets", () => {
      cylinder(15, 60);
      const sel = select(face().cylinder());
      const h = helix(sel).turns(6).startOffset(-10).endOffset(10) as Helix;
      render();

      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      // Cylinder is 0..60 in Z; offsets extend by 10 on each side.
      expect(bbox.minZ).toBeGreaterThanOrEqual(-10 - MESH_TOL);
      expect(bbox.minZ).toBeLessThanOrEqual(-10 + MESH_TOL);
      expect(bbox.maxZ).toBeGreaterThanOrEqual(70 - MESH_TOL);
      expect(bbox.maxZ).toBeLessThanOrEqual(70 + MESH_TOL);
    });
  });

  describe("conical face input", () => {
    it("should follow a cone surface with the face's natural taper", async () => {
      const { default: extrude } = await import("../../core/extrude.js");
      sketch("xy", () => {
        circle(60); // radius 30
      });
      extrude(50).draft(10); // 10° draft → top radius widens
      const sel = select(face().cone());
      const h = helix(sel).turns(6) as Helix;
      render();

      const shapes = h.getShapes();
      expect(shapes).toHaveLength(1);
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // Cone widens from r=30 at z=0 to r=~38.8 at z=50 (10° draft).
      // Max helix diameter = ~77.6.
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(60);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(78 + MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(50 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(50 + MESH_TOL);
    });

    it("should extend the helix following the cone's natural taper with offsets", async () => {
      const { default: extrude } = await import("../../core/extrude.js");
      sketch("xy", () => {
        circle(60); // radius 30 at z=0
      });
      extrude(50).draft(10); // cone widens toward top (tanθ = tan(10°) ≈ 0.176)
      const sel = select(face().cone());
      const h = helix(sel).turns(6).startOffset(-10).endOffset(10) as Helix;
      render();

      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      // Z extends 10 below (z=-10) and 10 above (z=60) the cone.
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(70 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(70 + MESH_TOL);
      // At z=60 (top extension), radius extrapolates: r = 30 + 60*tan(10°) ≈ 40.6
      // Max diameter ≈ 81.2 — strictly larger than the un-offset top diameter (~77.6).
      expect(bbox.maxX - bbox.minX).toBeGreaterThan(78);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(82 + MESH_TOL);
    });
  });

  describe("line edge input", () => {
    it("should treat a line edge as the helix axis and derive height from length", () => {
      const s = sketch("xz", () => {
        hLine(40);
      });
      const h = helix(s).turns(4) as Helix;
      render();

      const shapes = h.getShapes();
      expect(shapes).toHaveLength(1);
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      // Line is along world X (in the xz plane, hLine = X). Height ≈ 40 in X.
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(40 - MESH_TOL);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(40 + MESH_TOL);
    });
  });

  describe("circular edge input", () => {
    it("should derive axis from circle normal and use circle radius", () => {
      const s = sketch("xy", () => {
        circle(30);
      });
      const h = helix(s).turns(4) as Helix;
      render();

      const shapes = h.getShapes();
      expect(shapes).toHaveLength(1);
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect(bbox.maxX - bbox.minX).toBeGreaterThanOrEqual(30 - MESH_TOL);
      expect(bbox.maxX - bbox.minX).toBeLessThanOrEqual(30 + MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(50 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(50 + MESH_TOL);
    });

    it("should respect .height() override on circular edge", () => {
      const s = sketch("xy", () => {
        circle(30);
      });
      const h = helix(s).turns(4).height(80) as Helix;
      render();

      const bbox = ShapeOps.getBoundingBox(h.getShapes()[0]);
      expect(bbox.maxZ - bbox.minZ).toBeGreaterThanOrEqual(80 - MESH_TOL);
      expect(bbox.maxZ - bbox.minZ).toBeLessThanOrEqual(80 + MESH_TOL);
    });
  });

  describe("validation", () => {
    it("should record an error when pitch is zero", () => {
      const h = helix("z").pitch(0).turns(4) as Helix;
      render();
      expect(h.getError()).toMatch(/pitch/i);
    });

    it("should record an error when turns is zero", () => {
      const h = helix("z").pitch(5).turns(0) as Helix;
      render();
      expect(h.getError()).toMatch(/turns/i);
    });

    it("should record an error when source has no faces or edges", () => {
      const s = sketch("xy", () => {
        // empty sketch
      });
      const h = helix(s).turns(2) as Helix;
      render();
      expect(h.getError()).toBeTruthy();
    });
  });

  describe("sweep integration", () => {
    it("should be sweepable by a small profile to build a spring", () => {
      const profile = sketch("xz", () => {
        circle(2);
      });
      const path = helix("z").radius(15).pitch(5).turns(4) as Helix;
      const spring = sweep(path, profile);
      render();

      const shapes = (spring as any).getShapes();
      expect(shapes).toHaveLength(1);
      expect(shapes[0].getType()).toBe("solid");
    });
  });
});
