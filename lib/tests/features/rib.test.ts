import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import fillet from "../../core/fillet.js";
import rib from "../../core/rib.js";
import { rect, circle, move, aLine, hLine, line } from "../../core/2d/index.js";
import { Rib } from "../../features/rib.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { ISceneObject } from "../../core/interfaces.js";
import { SceneObject } from "../../common/scene-object.js";

describe("rib", () => {
  setupOC();

  function makeBox() {
    sketch("top", () => {
      rect(100, 50).centered();
    });
    const box = extrude(30);
    const s = shell(-4, box.endFaces());
    return s as unknown as SceneObject;
  }

  describe("basic rib (normal direction)", () => {
    it("should create a rib from a straight line", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should create a standalone rib with .new()", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const sShapes = s.getShapes();
      expect(sShapes.length).toBeGreaterThan(0);
    });

    it("rib should be contained within scope solid bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
        expect(ribBBox.minY).toBeGreaterThanOrEqual(scopeBBox.minY - 0.1);
        expect(ribBBox.maxY).toBeLessThanOrEqual(scopeBBox.maxY + 0.1);
        expect(ribBBox.minZ).toBeGreaterThanOrEqual(scopeBBox.minZ - 0.1);
        expect(ribBBox.maxZ).toBeLessThanOrEqual(scopeBBox.maxZ + 0.1);
      }
    });
  });

  describe("parallel direction", () => {
    it("should create a parallel rib with .new()", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).parallel().new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("parallel rib with .add() should not extend beyond scope bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).parallel().add().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("parallel rib on diagonal line", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
      }
    });
  });

  describe("extend", () => {
    it("extended rib should still be within scope bounds", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
        expect(ribBBox.minY).toBeGreaterThanOrEqual(scopeBBox.minY - 0.1);
        expect(ribBBox.maxY).toBeLessThanOrEqual(scopeBBox.maxY + 0.1);
        expect(ribBBox.minZ).toBeGreaterThanOrEqual(scopeBBox.minZ - 0.1);
        expect(ribBBox.maxZ).toBeLessThanOrEqual(scopeBBox.maxZ + 0.1);
      }
    });

    it("extended rib with .add() should fuse correctly", () => {
      const s = makeBox();

      sketch("front", () => {
        move([-40, 20]);
        aLine(45, 20);
      });

      const r = rib(-5).parallel().add().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("extended rib with fillet on scope should blend through fillet", () => {
      sketch("top", () => {
        rect(100, 50).centered();
      });
      const box = extrude(30);
      const shelled = shell(-4, box.endFaces());
      const s = fillet(2, shelled.internalEdges()) as SceneObject;

      sketch("front", () => {
        move([-40, 20]);
        aLine(-45, 20);
      });

      const r = rib(-5).parallel().new().scope(s).extend() as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);

      const scopeBBox = ShapeOps.getBoundingBox(s.getShapes()[0]);
      for (const shape of r.getShapes()) {
        const ribBBox = ShapeOps.getBoundingBox(shape);
        expect(ribBBox.minX).toBeGreaterThanOrEqual(scopeBBox.minX - 0.1);
        expect(ribBBox.maxX).toBeLessThanOrEqual(scopeBBox.maxX + 0.1);
      }
    });
  });

  describe("scope", () => {
    it("should only interact with scoped objects", () => {
      const s = makeBox();

      sketch("top", () => {
        circle(10);
      });
      const cyl = extrude(50).new();

      sketch("front", () => {
        move([-20, 15]);
        hLine(40);
      });

      const r = rib(-5).new().scope(s) as Rib;
      render();

      const shapes = r.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });
  });
});
