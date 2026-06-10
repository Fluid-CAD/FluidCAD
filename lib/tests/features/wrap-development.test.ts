import { describe, it, expect } from "vitest";
import { CylinderDevelopment, ConeDevelopment } from "../../oc/wrap-development.js";
import { Plane } from "../../math/plane.js";
import { Point, Point2D } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

// Pure-math tests for the wrap development mapping — no OCCT required.
describe("wrap development", () => {

  describe("cylinder", () => {
    const spec = {
      origin: new Point(0, 0, 0),
      axisDir: new Vector3d(0, 0, 1),
      radius: 25,
    };

    // Tangent plane at (25, 0, 0): local x is circumferential, local y is axial.
    const tangentPlane = new Plane(
      new Point(25, 0, 0),
      new Vector3d(0, 1, 0),
      new Vector3d(1, 0, 0),
    );

    it("maps the sketch origin to its radial projection on the surface", () => {
      const dev = new CylinderDevelopment(spec, tangentPlane);
      const uv = dev.toUV(new Point2D(0, 0));

      expect(uv.u).toBeCloseTo(0, 12);
      expect(uv.v).toBeCloseTo(0, 12);

      const anchor = dev.evalPoint(uv);
      expect(anchor.x).toBeCloseTo(25, 12);
      expect(anchor.y).toBeCloseTo(0, 12);
      expect(anchor.z).toBeCloseTo(0, 12);
    });

    it("preserves arc length around the surface", () => {
      const dev = new CylinderDevelopment(spec, tangentPlane);
      const uv = dev.toUV(new Point2D(10, 0));

      // 10 units of sketch length = 10 units of arc = 10/25 radians.
      expect(Math.abs(uv.u)).toBeCloseTo(10 / 25, 12);
      expect(uv.v).toBeCloseTo(0, 12);

      const point = dev.evalPoint(uv);
      const radial = Math.hypot(point.x, point.y);
      expect(radial).toBeCloseTo(25, 12);
      expect(point.z).toBeCloseTo(0, 12);
    });

    it("maps the axial sketch direction onto the surface axis", () => {
      const dev = new CylinderDevelopment(spec, tangentPlane);
      const point = dev.evalPoint(dev.toUV(new Point2D(0, 7)));

      expect(point.x).toBeCloseTo(25, 12);
      expect(point.y).toBeCloseTo(0, 12);
      expect(point.z).toBeCloseTo(7, 12);
    });

    it("is locally isometric in every direction", () => {
      const dev = new CylinderDevelopment(spec, tangentPlane);
      const delta = 0.01;
      for (const [dx, dy] of [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]]) {
        const a = dev.evalPoint(dev.toUV(new Point2D(5, 3)));
        const b = dev.evalPoint(dev.toUV(new Point2D(5 + dx * delta, 3 + dy * delta)));
        expect(a.distanceTo(b)).toBeCloseTo(delta, 6);
      }
    });

    it("rejects a sketch plane perpendicular to the axis", () => {
      const topPlane = new Plane(
        new Point(25, 0, 5),
        new Vector3d(1, 0, 0),
        new Vector3d(0, 0, 1),
      );
      expect(() => new CylinderDevelopment(spec, topPlane)).toThrow(/perpendicular to the target surface axis/);
    });

    it("rejects a sketch plane containing the axis", () => {
      const radialPlane = new Plane(
        new Point(25, 0, 0),
        new Vector3d(1, 0, 0),
        new Vector3d(0, 1, 0),
      );
      expect(() => new CylinderDevelopment(spec, radialPlane)).toThrow(/must not contain the target surface axis/);
    });

    it("rejects a sketch plane origin on the axis", () => {
      const centeredPlane = new Plane(
        new Point(0, 0, 0),
        new Vector3d(0, 1, 0),
        new Vector3d(1, 0, 0),
      );
      expect(() => new CylinderDevelopment(spec, centeredPlane)).toThrow(/must not lie on the target surface axis/);
    });

    it("measures distance to the surface", () => {
      const dev = new CylinderDevelopment(spec, tangentPlane);
      expect(dev.distanceTo(new Point(27, 0, 10))).toBeCloseTo(2, 12);
      expect(dev.distanceTo(new Point(20, 0, -4))).toBeCloseTo(5, 12);
    });
  });

  describe("cone", () => {
    const semiAngle = Math.PI / 6;
    const spec = {
      origin: new Point(0, 0, 0),
      axisDir: new Vector3d(0, 0, 1),
      refRadius: 20,
      semiAngle,
    };

    // Tangent plane at the anchor (20, 0, 0): local x is circumferential,
    // local y follows the meridian (away from the apex).
    const tangentPlane = new Plane(
      new Point(20, 0, 0),
      new Vector3d(0, 1, 0),
      new Vector3d(Math.cos(semiAngle), 0, -Math.sin(semiAngle)),
    );

    it("maps the sketch origin to its radial projection on the surface", () => {
      const dev = new ConeDevelopment(spec, tangentPlane);
      const uv = dev.toUV(new Point2D(0, 0));

      expect(uv.u).toBeCloseTo(0, 12);
      expect(uv.v).toBeCloseTo(0, 12);

      const anchor = dev.evalPoint(uv);
      expect(anchor.x).toBeCloseTo(20, 12);
      expect(anchor.y).toBeCloseTo(0, 12);
      expect(anchor.z).toBeCloseTo(0, 12);
    });

    it("preserves length along the meridian", () => {
      const dev = new ConeDevelopment(spec, tangentPlane);
      const point = dev.evalPoint(dev.toUV(new Point2D(0, 10)));

      // 10 units along the meridian: radius grows by 10·sin(α), height by 10·cos(α).
      const radial = Math.hypot(point.x, point.y);
      expect(radial).toBeCloseTo(20 + 10 * Math.sin(semiAngle), 12);
      expect(point.z).toBeCloseTo(10 * Math.cos(semiAngle), 12);

      const anchor = dev.evalPoint(dev.toUV(new Point2D(0, 0)));
      expect(anchor.distanceTo(point)).toBeCloseTo(10, 12);
    });

    it("is locally isometric in every direction", () => {
      const dev = new ConeDevelopment(spec, tangentPlane);
      const delta = 0.01;
      for (const [dx, dy] of [[1, 0], [0, 1], [Math.SQRT1_2, -Math.SQRT1_2]]) {
        const a = dev.evalPoint(dev.toUV(new Point2D(4, -2)));
        const b = dev.evalPoint(dev.toUV(new Point2D(4 + dx * delta, -2 + dy * delta)));
        expect(a.distanceTo(b)).toBeCloseTo(delta, 6);
      }
    });

    it("normalizes a negative half-angle to the same surface", () => {
      const flipped = new ConeDevelopment({ ...spec, semiAngle: -semiAngle }, tangentPlane);
      const anchor = flipped.evalPoint(flipped.toUV(new Point2D(0, 0)));

      expect(anchor.x).toBeCloseTo(20, 12);
      expect(anchor.y).toBeCloseTo(0, 12);
      expect(anchor.z).toBeCloseTo(0, 12);
    });

    it("rejects a sketch that reaches the apex", () => {
      const dev = new ConeDevelopment(spec, tangentPlane);
      // The apex develops to 40 units behind the anchor along the meridian.
      expect(() => dev.toUV(new Point2D(0, -40))).toThrow(/apex/);
    });

    it("measures distance to the surface", () => {
      const dev = new ConeDevelopment(spec, tangentPlane);
      // Surface radius at z = 0 is 20; a point 2 beyond it sits at
      // 2·cos(α) normal distance.
      expect(dev.distanceTo(new Point(22, 0, 0))).toBeCloseTo(2 * Math.cos(semiAngle), 12);
    });
  });
});
