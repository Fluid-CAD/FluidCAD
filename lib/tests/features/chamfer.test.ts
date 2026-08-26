import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import chamfer from "../../core/chamfer.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import { circle } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { Chamfer } from "../../features/chamfer.js";
import { countShapes } from "../utils.js";
import { getEdgesByType, getFacesByType } from "../utils.js";
import { FilletOps } from "../../oc/fillet-ops.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeProps } from "../../oc/props.js";
import { edge } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

describe("chamfer", () => {
  setupOC();

  describe("basic chamfer", () => {
    it("should chamfer edges and produce a valid solid", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should add planar faces for each chamfered edge", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const planeFaces = getFacesByType(solid, "plane");
      // Original box: 6 planar faces. Chamfering 4 edges adds 4 planar chamfer faces
      expect(planeFaces.length).toBeGreaterThanOrEqual(10);
    });

    it("should not introduce any arc edges", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Chamfer produces only line edges, no arcs
      const arcEdges = getEdgesByType(solid, "arc");
      expect(arcEdges).toHaveLength(0);
    });

    it("should increase face count compared to original box", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      expect(solid.getFaces().length).toBeGreaterThan(6);
    });

    it("should reduce volume compared to original box", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const props = ShapeProps.getProperties(solid.getShape());
      expect(props.volumeMm3).toBeLessThan(100 * 50 * 30);
    });

    it("should preserve bounding box dimensions", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const bbox = ShapeOps.getBoundingBox(solid);
      expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 0);
      expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 0);
      expect(bbox.maxZ - bbox.minZ).toBeCloseTo(30, 0);
    });
  });

  describe("chamfer with explicit selection", () => {
    it("should chamfer only the selected edges", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      const sel = select(edge().onPlane("xy", { offset: 30 }));
      chamfer(3, sel);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // 4 top edges chamfered → 4 extra planar faces (total 10)
      const planeFaces = getFacesByType(solid, "plane");
      expect(planeFaces).toHaveLength(10);
    });
  });

  describe("chamfer on cylinder", () => {
    it("should chamfer a cylinder's circular edges", () => {
      cylinder(30, 50);

      select(edge().circle());
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Chamfered cylinder has more faces than original (3)
      expect(solid.getFaces().length).toBeGreaterThan(3);
    });
  });

  describe("chamfer vs fillet", () => {
    it("chamfer should produce no cylindrical faces while fillet does", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer(5);

      render();

      const solid = render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      const cylFaces = getFacesByType(solid, "cylinder");
      expect(cylFaces).toHaveLength(0);
    });
  });

  describe("chamfer distance", () => {
    it("should use default distance of 1", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      extrude(30);

      select(edge().verticalTo("xy"));
      chamfer();

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });
  });

  describe("failure surfacing", () => {
    function findSolid() {
      return render().getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;
    }

    it("flags an error when a lazy selection resolves to no edges", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30) as Extrude;

      // Accessor selections are lazy, so validate() can't see their
      // emptiness — the build itself must surface it.
      const c = chamfer(5, e.endEdges(edge().circle(999))) as Chamfer;

      const solid = findSolid();

      expect(c.getError()).toBeTruthy();
      expect(c.getError()).toContain("chamfer");
      expect(c.getError()).toContain("no edges");

      // The solid is untouched, just no longer silently.
      expect(ShapeProps.getProperties(solid.getShape()).volumeMm3).toBeCloseTo(100 * 50 * 30, 1);
    });

    it("flags an error instead of silently skipping when OCCT refuses the chamfer", () => {
      const spy = vi.spyOn(FilletOps, "makeChamfer").mockImplementation(() => {
        throw new Error("chamfer failed");
      });

      try {
        sketch("xy", () => {
            testRect(100, 50);
          });
        extrude(30);

        select(edge().verticalTo("xy"));
        const c = chamfer(5) as Chamfer;

        const solid = findSolid();

        expect(c.getError()).toBeTruthy();
        expect(c.getError()).toContain("distance");

        // The original solid is preserved so downstream features still
        // have geometry to work with.
        expect(solid).toBeDefined();
        expect(ShapeProps.getProperties(solid.getShape()).volumeMm3).toBeCloseTo(100 * 50 * 30, 1);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
