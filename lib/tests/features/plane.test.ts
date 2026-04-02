import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { face } from "../../filters/index.js";

describe("plane", () => {
  setupOC();

  describe("standard plane creation", () => {
    it("should create an XY plane", () => {
      const p = plane("xy") as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.normal.x).toBeCloseTo(0);
      expect(pl.normal.y).toBeCloseTo(0);
      expect(pl.normal.z).toBeCloseTo(1);
      expect(pl.origin.x).toBeCloseTo(0);
      expect(pl.origin.y).toBeCloseTo(0);
      expect(pl.origin.z).toBeCloseTo(0);
    });

    it("should create an XZ plane", () => {
      const p = plane("xz") as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.normal.x).toBeCloseTo(0);
      expect(Math.abs(pl.normal.y)).toBeCloseTo(1);
      expect(pl.normal.z).toBeCloseTo(0);
    });

    it("should create a YZ plane", () => {
      const p = plane("yz") as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(Math.abs(pl.normal.x)).toBeCloseTo(1);
      expect(pl.normal.y).toBeCloseTo(0);
      expect(pl.normal.z).toBeCloseTo(0);
    });

    it("should create a negated XY plane", () => {
      const p = plane("-xy") as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.normal.z).toBeCloseTo(-1);
    });
  });

  describe("plane with transform options", () => {
    it("should offset the plane along its normal", () => {
      const p = plane("xy", { offset: 25 }) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(25);
      expect(pl.normal.z).toBeCloseTo(1);
    });

    it("should rotate the plane", () => {
      // Rotate XY plane 90° around X → normal goes from Z to -Y
      const p = plane("xy", { rotateX: 90 }) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(Math.abs(pl.normal.y)).toBeCloseTo(1);
      expect(pl.normal.z).toBeCloseTo(0);
    });

    it("should combine offset and rotation", () => {
      const p = plane("xy", { offset: 10, rotateX: 90 }) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      // Offset is applied first along original normal (Z), then rotated
      expect(Math.abs(pl.normal.y)).toBeCloseTo(1);
    });
  });

  describe("plane from face", () => {
    it("should create a plane from an extrude end face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(40) as Extrude;

      const p = plane(e.endFace()) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(40);
      expect(Math.abs(pl.normal.z)).toBeCloseTo(1);
    });

    it("should create a plane from an extrude start face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(40) as Extrude;

      const p = plane(e.startFace()) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(0);
    });

    it("should create a plane from a face selection", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(40);

      const sel = select(face().onPlane("xy", 40));
      const p = plane(sel) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(40);
    });

    it("should apply transform options to plane from face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(40) as Extrude;

      const p = plane(e.endFace(), { offset: 10 }) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(50);
    });
  });

  describe("plane middle", () => {
    it("should create a plane midway between two standard planes", () => {
      const p1 = plane("xy") as PlaneObjectBase;
      const p2 = plane("xy", { offset: 40 }) as PlaneObjectBase;
      const mid = plane(p1, p2) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(pl.origin.z).toBeCloseTo(20);
      expect(pl.normal.z).toBeCloseTo(1);
    });

    it("should create a plane midway using shorthand strings", () => {
      const mid = plane("xy", "xy") as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      // Both at origin → midpoint is origin
      expect(pl.origin.z).toBeCloseTo(0);
      expect(pl.normal.z).toBeCloseTo(1);
    });

    it("should preserve direction from first plane", () => {
      const p1 = plane("xz") as PlaneObjectBase;
      const p2 = plane("xz", { offset: 60 }) as PlaneObjectBase;
      const mid = plane(p1, p2) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(Math.abs(pl.normal.y)).toBeCloseTo(1);
      expect(pl.normal.z).toBeCloseTo(0);
    });

    it("should create a plane midway between two face planes", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(60) as Extrude;

      const pStart = plane(e.startFace()) as PlaneObjectBase;
      const pEnd = plane(e.endFace()) as PlaneObjectBase;
      const mid = plane(pStart, pEnd) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(pl.origin.z).toBeCloseTo(30);
    });
  });
});
