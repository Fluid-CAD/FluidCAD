import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import draft from "../../core/draft.js";
import select from "../../core/select.js";
import { rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { SelectSceneObject } from "../../features/select.js";
import { countShapes } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { face } from "../../filters/index.js";

describe("draft", () => {
  setupOC();

  describe("draft with implicit selection", () => {
    it("should apply draft to the last selected face", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      select(face().onPlane("front"));
      draft(5);

      const scene = render();
      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid).toBeDefined();
    });

    it("should change the bounding box when drafting a side face", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      select(face().onPlane("front"));
      draft(5);

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      // 5 deg draft over 80mm height: tan(5°) * 80 ≈ 7mm extension
      expect(bbox.maxY - bbox.minY).toBeGreaterThan(103);
    });

    it("should change volume compared to original box", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      select(face().onPlane("front"));
      draft(5);

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const props = ShapeProps.getProperties(solid.getShape());
      const originalVolume = 100 * 100 * 80;
      expect(Math.abs(props.volumeMm3 - originalVolume)).toBeGreaterThan(1000);
    });
  });

  describe("draft with explicit selection", () => {
    it("should apply draft using e.sideFaces()", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(80) as Extrude;

      draft(5, e.sideFaces());

      const scene = render();
      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid).toBeDefined();
    });

    it("should apply draft using explicit select()", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      const sel = select(face().onPlane("front"));
      draft(5, sel);

      const scene = render();
      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("draft angle effect", () => {
    it("should produce larger extension with 10 degrees than 3 degrees", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      select(face().onPlane("front"));
      draft(10);

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      // tan(10°) * 80 ≈ 14.1mm
      expect(bbox.maxY - bbox.minY).toBeGreaterThan(110);
    });

    it("should produce smaller extension with 3 degrees", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      select(face().onPlane("front"));
      draft(3);

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      // tan(3°) * 80 ≈ 4.2mm
      expect(bbox.maxY - bbox.minY).toBeGreaterThan(103);
      expect(bbox.maxY - bbox.minY).toBeLessThan(110);
    });
  });

  describe("draft removes selection shapes", () => {
    it("should remove the face selection after drafting", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      extrude(80);

      const sel = select(face().onPlane("front")) as SelectSceneObject;
      draft(5, sel);

      render();

      expect(sel.getShapes()).toHaveLength(0);
    });
  });

  describe("draft on multiple faces", () => {
    it("should draft all four side faces via sideFaces()", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(80) as Extrude;

      draft(5, e.sideFaces());

      const scene = render();

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      // All four sides drafted — bounding box should extend in both X and Y
      expect(bbox.maxX - bbox.minX).toBeGreaterThan(103);
      expect(bbox.maxY - bbox.minY).toBeGreaterThan(103);
    });
  });
});
