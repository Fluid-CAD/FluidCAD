import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import { bezier, rect } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { PlaneObjectBase } from "../../features/plane-renderable-base.js";
import { SceneObject } from "../../common/scene-object.js";
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

    it("should apply transform options to a plane from an edge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const pStart = plane(e.startEdges(0)) as PlaneObjectBase;
      const pOffset = plane(e.startEdges(0), { offset: 10 }) as PlaneObjectBase;

      render();

      const base = pStart.getPlane();
      const moved = pOffset.getPlane();
      // The offset moves the origin along the plane normal (the edge tangent).
      const expected = base.origin.add(base.normal.multiply(10));
      expectSamePoint(moved.origin, expected);
      expectSamePoint(moved.normal, base.normal);
    });

    it("should apply rotation options to a plane from an edge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const pStart = plane(e.startEdges(0)) as PlaneObjectBase;
      const pRot = plane(e.startEdges(0), { rotateX: 90 }) as PlaneObjectBase;

      render();

      const base = pStart.getPlane();
      const rot = pRot.getPlane();
      // A 90° rotation around the plane's own X axis turns the normal
      // perpendicular to itself; the origin stays put.
      expectSamePoint(rot.origin, base.origin);
      expect(rot.normal.dot(base.normal)).toBeCloseTo(0);
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

    it("should take a single-curve sketch as the edge source", () => {
      // A sketch drawing one curve resolves to a single edge, so the whole
      // sketch reads as the edge — what the Plane dialog writes when a bare
      // sketch curve is picked in the viewport.
      const s = sketch("xy", () => {
        bezier([0, 0], [38.78, 52.5], [127.59, 51.17], [128.31, 88.4]);
      });

      const p = plane(s, 0.5) as PlaneObjectBase;

      render();

      const pl = p.getPlane();
      // The plane sits on the curve at its midpoint, normal to the tangent —
      // which, for a curve drawn on XY, lies in that plane.
      expect(pl.origin.z).toBeCloseTo(0);
      expect(pl.normal.z).toBeCloseTo(0);
      expect(Math.hypot(pl.normal.x, pl.normal.y, pl.normal.z)).toBeCloseTo(1);
      // Between the curve's endpoints rather than at either one.
      expect(pl.origin.distanceTo(new Point(0, 0, 0))).toBeGreaterThan(1);
      expect(pl.origin.distanceTo(new Point(128.31, 88.4, 0))).toBeGreaterThan(1);
    });

    it("should leave a sketch consumable after deriving a plane from it", () => {
      // The edge path only *references* its source — the sketch stays
      // available to the feature that consumes it.
      const s = sketch("xy", () => {
        bezier([0, 0], [38.78, 52.5], [127.59, 51.17], [128.31, 88.4]);
      }) as SceneObject;
      plane(s, 0.5);

      render();

      expect(s.getShapes({ excludeGuide: false })).toHaveLength(1);
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

    it("should consume the two source planes", () => {
      const p1 = plane("xy") as PlaneObjectBase;
      const p2 = plane("xy", { offset: 40 }) as PlaneObjectBase;
      const mid = plane(p1, p2) as PlaneObjectBase;

      render();

      // Plane faces are meta shapes, so the filter has to admit them.
      const filter = { excludeMeta: false, excludeGuide: false };

      // Only the mid plane survives — the originals were consumed.
      expect(p1.getShapes(filter).length).toBe(0);
      expect(p2.getShapes(filter).length).toBe(0);
      expect(mid.getShapes(filter).length).toBe(1);
    });

    it("should mark the mid plane face as a meta shape, like any other plane", () => {
      const ref = plane("xy") as PlaneObjectBase;
      const p1 = plane("xy") as PlaneObjectBase;
      const p2 = plane("xy", { offset: 40 }) as PlaneObjectBase;
      const m = plane(p1, p2) as PlaneObjectBase;

      render();

      // A plane's face is reference geometry, so it stays out of the default
      // (meta-excluding) shape view — the mid plane is no different.
      expect(ref.getShapes().length).toBe(0);
      expect(m.getShapes().length).toBe(0);
      expect(m.getShapes({ excludeMeta: false, excludeGuide: false }).length).toBe(1);
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

    it("should offset a mid plane along its normal", () => {
      const p1 = plane("xy") as PlaneObjectBase;
      const p2 = plane("xy", { offset: 40 }) as PlaneObjectBase;
      const mid = plane(p1, p2, { offset: 5 }) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(pl.origin.z).toBeCloseTo(25);
      expect(pl.normal.z).toBeCloseTo(1);
    });

    it("should rotate a mid plane", () => {
      const p1 = plane("xy") as PlaneObjectBase;
      const p2 = plane("xy", { offset: 40 }) as PlaneObjectBase;
      const mid = plane(p1, p2, { rotateX: 90 }) as PlaneObjectBase;

      render();

      const pl = mid.getPlane();
      expect(pl.origin.z).toBeCloseTo(20);
      // XY normal (Z) rotated 90° around the plane's X axis lands on ±Y.
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

  // A sketch builds itself a plane when it isn't handed one. That object
  // carries the SKETCH call's source location, so it stands for no statement
  // of its own — it is marked internal, and the timeline leaves it out
  // instead of showing a plane feature the code never wrote.
  describe("internal planes", () => {
    const planesOf = (scene: ReturnType<typeof render>) =>
      scene.getRenderedObjects().filter(r => r.type === "plane");

    it("marks the plane a sketch builds for itself", () => {
      sketch("xy", () => {
        rect(100, 50);
      });

      const planes = planesOf(render());
      expect(planes).toHaveLength(1);
      expect(planes[0].internal).toBe(true);
    });

    it("marks the plane a sketch derives from a face", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(60) as Extrude;
      sketch(e.endFaces(), () => {
        rect(10, 10);
      });

      const planes = planesOf(render());
      expect(planes.every(p => p.internal === true)).toBe(true);
    });

    it("leaves a plane() statement alone, and the sketch that consumes it", () => {
      const p = plane("xy", 20) as PlaneObjectBase;
      sketch(p, () => {
        rect(100, 50);
      });

      // Only the statement's own plane object exists — the sketch reuses it
      // rather than building one — and it stays a feature row.
      const planes = planesOf(render());
      expect(planes).toHaveLength(1);
      expect(planes[0].internal).toBeUndefined();
    });
  });
});
