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
import { Point } from "../../math/point.js";

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

      const p = plane(e.endFaces()) as PlaneObjectBase;

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

      const p = plane(e.startFaces()) as PlaneObjectBase;

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

      const p = plane(e.endFaces(), { offset: 10 }) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      expect(pl.origin.z).toBeCloseTo(50);
    });
  });

  describe("plane from edge", () => {
    type XYZ = { x: number; y: number; z: number };
    const expectSamePoint = (a: XYZ, b: XYZ) => {
      expect(a.x).toBeCloseTo(b.x);
      expect(a.y).toBeCloseTo(b.y);
      expect(a.z).toBeCloseTo(b.z);
    };

    it("should create a plane normal to an edge at its midpoint", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const p = plane(e.startEdges(0), "middle") as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      // A base-face edge lies in the z=0 plane, so its tangent — which becomes
      // the plane normal — is horizontal.
      expect(pl.origin.z).toBeCloseTo(0);
      expect(pl.normal.z).toBeCloseTo(0);
      // The normal is a unit vector.
      expect(Math.hypot(pl.normal.x, pl.normal.y, pl.normal.z)).toBeCloseTo(1);
    });

    it("should default to the start when no position is given", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const pStart = plane(e.startEdges(0), "start") as PlaneObjectBase;
      const pDefault = plane(e.startEdges(0)) as PlaneObjectBase;

      render();

      expectSamePoint(pDefault.getPlane().origin, pStart.getPlane().origin);
    });

    it("should place start/end at the endpoints with the midpoint between them", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const pStart = plane(e.startEdges(0), "start") as PlaneObjectBase;
      const pEnd = plane(e.startEdges(0), "end") as PlaneObjectBase;
      const pMid = plane(e.startEdges(0), "middle") as PlaneObjectBase;

      render();

      const s = pStart.getPlane().origin;
      const en = pEnd.getPlane().origin;
      const m = pMid.getPlane().origin;

      // Distinct endpoints…
      expect(s.distanceTo(en)).toBeGreaterThan(1);
      // …with the midpoint halfway between them (the edge is straight).
      expectSamePoint(m, new Point((s.x + en.x) / 2, (s.y + en.y) / 2, (s.z + en.z) / 2));
    });

    it("should treat the numeric position as a normalized 0–1 parameter", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const p0 = plane(e.startEdges(0), 0) as PlaneObjectBase;
      const pHalf = plane(e.startEdges(0), 0.5) as PlaneObjectBase;
      const p1 = plane(e.startEdges(0), 1) as PlaneObjectBase;
      const pStart = plane(e.startEdges(0), "start") as PlaneObjectBase;
      const pMid = plane(e.startEdges(0), "middle") as PlaneObjectBase;
      const pEnd = plane(e.startEdges(0), "end") as PlaneObjectBase;

      render();

      expectSamePoint(p0.getPlane().origin, pStart.getPlane().origin);
      expectSamePoint(pHalf.getPlane().origin, pMid.getPlane().origin);
      expectSamePoint(p1.getPlane().origin, pEnd.getPlane().origin);
    });

    it("should face outward at the start (cap convention)", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const pStart = plane(e.startEdges(0), "start") as PlaneObjectBase;
      const pMid = plane(e.startEdges(0), "middle") as PlaneObjectBase;
      const pEnd = plane(e.startEdges(0), "end") as PlaneObjectBase;

      render();

      const nStart = pStart.getPlane().normal;
      const nMid = pMid.getPlane().normal;
      const nEnd = pEnd.getPlane().normal;

      // A straight edge has a constant forward tangent. The middle and end keep
      // it; the start flips to face outward, so it's the negated tangent.
      expectSamePoint(nMid, nEnd);
      expectSamePoint(nStart, nEnd.negate());
    });

    it("should still treat a numeric argument on a face as a normal offset", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(40) as Extrude;

      const p = plane(e.endFaces(), 10) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      // Face path: the bare number is an offset along the normal (40 + 10).
      expect(pl.origin.z).toBeCloseTo(50);
      expect(Math.abs(pl.normal.z)).toBeCloseTo(1);
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

      const pStart = plane(e.startFaces()) as PlaneObjectBase;
      const pEnd = plane(e.endFaces()) as PlaneObjectBase;
      const mid = plane(pStart, pEnd) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(pl.origin.z).toBeCloseTo(30);
    });
  });
});
