import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import axis from "../../core/axis.js";
import { rect } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { AxisObjectBase } from "../../features/axis-renderable-base.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";

describe("axis", () => {
  setupOC();

  describe("standard axis creation", () => {
    it("should create an X axis", () => {
      const a = axis("x") as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.origin.x).toBeCloseTo(0);
      expect(ax.origin.y).toBeCloseTo(0);
      expect(ax.origin.z).toBeCloseTo(0);
      expect(ax.direction.x).toBeCloseTo(1);
      expect(ax.direction.y).toBeCloseTo(0);
      expect(ax.direction.z).toBeCloseTo(0);
    });

    it("should create a Y axis", () => {
      const a = axis("y") as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.direction.x).toBeCloseTo(0);
      expect(ax.direction.y).toBeCloseTo(1);
      expect(ax.direction.z).toBeCloseTo(0);
    });

    it("should create a Z axis", () => {
      const a = axis("z") as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.direction.x).toBeCloseTo(0);
      expect(ax.direction.y).toBeCloseTo(0);
      expect(ax.direction.z).toBeCloseTo(1);
    });
  });

  describe("axis with transform options", () => {
    it("should offset the axis origin", () => {
      const a = axis("z", { offsetX: 10, offsetY: 20, offsetZ: 30 }) as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.origin.x).toBeCloseTo(10);
      expect(ax.origin.y).toBeCloseTo(20);
      expect(ax.origin.z).toBeCloseTo(30);
      // Direction should still be Z
      expect(ax.direction.z).toBeCloseTo(1);
    });

    it("should rotate the axis direction", () => {
      // Rotate X axis by 90° around Z → should become Y axis
      const a = axis("x", { rotateZ: Math.PI / 2 }) as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.direction.x).toBeCloseTo(0);
      expect(ax.direction.y).toBeCloseTo(1);
      expect(ax.direction.z).toBeCloseTo(0);
    });
  });

  describe("axis from edge", () => {
    it("should extract axis from a single edge of an extrusion", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const a = axis(e.startEdges(0)) as AxisObjectBase;

      render();

      const ax = a.getAxis();
      // Edge is on the XY plane at z=0
      expect(ax.origin.z).toBeCloseTo(0);
      // Direction should be along X or Y (a line edge of the rect)
      const isHorizontalOrVertical =
        Math.abs(ax.direction.z) < 0.01;
      expect(isHorizontalOrVertical).toBe(true);
    });

    it("should extract axis from an end edge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const a = axis(e.endEdges(0)) as AxisObjectBase;

      render();

      const ax = a.getAxis();
      // Edge is on the end face at z=30
      expect(ax.origin.z).toBeCloseTo(30);
    });

    it("should apply transform options to extracted axis", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30) as Extrude;

      const a = axis(e.startEdges(0), { offsetZ: 15 }) as AxisObjectBase;

      render();

      const ax = a.getAxis();
      expect(ax.origin.z).toBeCloseTo(15);
    });
  });

  describe("axis middle", () => {
    it("should create axis midway between two parallel axes", () => {
      const a1 = axis("z", { offsetX: 0 }) as AxisObjectBase;
      const a2 = axis("z", { offsetX: 100 }) as AxisObjectBase;
      const mid = axis(a1, a2) as AxisObjectBase;

      render();

      const ax = mid.getAxis();
      expect(ax.origin.x).toBeCloseTo(50);
      expect(ax.direction.z).toBeCloseTo(1);
    });

    it("should compute midpoint in all dimensions", () => {
      const a1 = axis("z", { offsetX: 10, offsetY: 20 }) as AxisObjectBase;
      const a2 = axis("z", { offsetX: 50, offsetY: 80 }) as AxisObjectBase;
      const mid = axis(a1, a2) as AxisObjectBase;

      render();

      const ax = mid.getAxis();
      expect(ax.origin.x).toBeCloseTo(30);
      expect(ax.origin.y).toBeCloseTo(50);
    });

    it("should preserve direction from first axis", () => {
      const a1 = axis("x", { offsetY: 0 }) as AxisObjectBase;
      const a2 = axis("x", { offsetY: 40 }) as AxisObjectBase;
      const mid = axis(a1, a2) as AxisObjectBase;

      render();

      const ax = mid.getAxis();
      expect(ax.direction.x).toBeCloseTo(1);
      expect(ax.direction.y).toBeCloseTo(0);
      expect(ax.origin.y).toBeCloseTo(20);
    });

    it("should apply transform options to middle axis", () => {
      const a1 = axis("z", { offsetX: 0 }) as AxisObjectBase;
      const a2 = axis("z", { offsetX: 100 }) as AxisObjectBase;
      const mid = axis(a1, a2, { offsetY: 25 }) as AxisObjectBase;

      render();

      const ax = mid.getAxis();
      expect(ax.origin.x).toBeCloseTo(50);
      expect(ax.origin.y).toBeCloseTo(25);
    });

    it("should work with standard axis shorthand", () => {
      const mid = axis("x", "x") as AxisObjectBase;

      render();

      const ax = mid.getAxis();
      // Both are X-axis at origin → midpoint is origin
      expect(ax.origin.x).toBeCloseTo(0);
      expect(ax.direction.x).toBeCloseTo(1);
    });
  });
});
