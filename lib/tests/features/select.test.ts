import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import cylinder from "../../core/cylinder.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { SelectSceneObject } from "../../features/select.js";
import { face, edge } from "../../filters/index.js";

describe("select", () => {
  setupOC();

  describe("face filters", () => {
    describe("onPlane / notOnPlane", () => {
      it("should select faces on a specific plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });

        extrude(30);

        const sel = select(face().onPlane("xy")) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        // Box has 1 face on XY (bottom)
        expect(shapes).toHaveLength(1);
        expect(shapes[0].getType()).toBe("face");
      });

      it("should select faces on an offset plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        const sel = select(face().onPlane("xy", 30)) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(1);
      });

      it("should select faces NOT on a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        const onXY = select(face().onPlane("xy")) as SelectSceneObject;
        const notOnXY = select(face().notOnPlane("xy")) as SelectSceneObject;

        render();

        const onShapes = onXY.getShapes();
        const notOnShapes = notOnXY.getShapes();
        // Box has 1 face on XY (bottom), 5 not on XY (top + 4 sides)
        expect(onShapes).toHaveLength(1);
        expect(notOnShapes).toHaveLength(5);
        // No overlap
        for (const s of onShapes) {
          expect(notOnShapes.some(ns => ns.isSame(s))).toBe(false);
        }
      });
    });

    describe("parallelTo / notParallelTo", () => {
      it("should select faces parallel to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Top and bottom faces are parallel to XY
        const sel = select(face().parallelTo("xy")) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });

      it("should select faces not parallel to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // 4 side faces are not parallel to XY
        const sel = select(face().notParallelTo("xy")) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(4);
      });
    });

    describe("circle / notCircle", () => {
      it("should select circular faces", () => {
        cylinder(30, 50);

        const sel = select(face().circle()) as SelectSceneObject;

        render();

        // Cylinder has 2 circular faces (top and bottom)
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });

      it("should select circular faces with specific diameter", () => {
        cylinder(30, 50);

        const sel = select(face().circle(60)) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });

      it("should not match circles with wrong diameter", () => {
        cylinder(30, 50);

        const sel = select(face().circle(1998)) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(0);
      });

      it("should select non-circular faces", () => {
        cylinder(30, 50);

        const sel = select(face().notCircle()) as SelectSceneObject;

        render();

        // The cylindrical side face is not circular
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(1);
      });
    });

    describe("cylinder / notCylinder", () => {
      it("should select cylindrical faces", () => {
        cylinder(30, 50);

        const sel = select(face().cylinder()) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(1);
      });

      it("should select cylindrical faces with specific diameter", () => {
        cylinder(30, 50);

        const sel = select(face().cylinder(60)) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(1);
      });

      it("should select non-cylindrical faces", () => {
        cylinder(30, 50);

        const sel = select(face().notCylinder()) as SelectSceneObject;

        render();

        // Top and bottom circular faces are not cylindrical surfaces
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });
    });

    describe("cone / notCone", () => {
      it("should select conical faces from a drafted extrusion", () => {
        sketch("xy", () => {
          circle(60);
        });
        extrude(50).draft(10);

        const sel = select(face().cone()) as SelectSceneObject;

        render();

        // Drafted cylinder has 1 conical side face
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(1);
      });

      it("should select non-conical faces", () => {
        sketch("xy", () => {
          circle(60);
        });
        extrude(50).draft(10);

        const sel = select(face().notCone()) as SelectSceneObject;

        render();

        // 2 non-conical faces (top and bottom circles)
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });
    });
  });

  describe("edge filters", () => {
    describe("onPlane / notOnPlane", () => {
      it("should select edges on a specific plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        const sel = select(edge().onPlane("xy")) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(4);
        for (const s of shapes) {
          expect(s.getType()).toBe("edge");
        }
      });

      it("should select edges on an offset plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        const sel = select(edge().onPlane("xy", 30)) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });

      it("should select edges NOT on a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Box has 12 edges total, 4 on xy, 4 on xy+30, 4 vertical
        const sel = select(edge().notOnPlane("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });
    });

    describe("parallelTo / notParallelTo", () => {
      it("should select edges parallel to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Edges parallel to XY = all horizontal edges (top + bottom = 8)
        const sel = select(edge().parallelTo("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });

      it("should select edges not parallel to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // 4 vertical edges are not parallel to XY
        const sel = select(edge().notParallelTo("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });
    });

    describe("verticalTo / notVerticalTo", () => {
      it("should select edges vertical to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Vertical edges aligned with XY normal (Z direction) = 4
        const sel = select(edge().verticalTo("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });

      it("should select edges not vertical to a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // 8 horizontal edges
        const sel = select(edge().notVerticalTo("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });
    });

    describe("line / notLine", () => {
      it("should select straight edges", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        const sel = select(edge().line()) as SelectSceneObject;

        render();

        // All 12 edges of a box are lines
        expect(sel.getShapes()).toHaveLength(12);
      });

      it("should select non-line edges from a cylinder", () => {
        cylinder(30, 50);

        const sel = select(edge().notLine()) as SelectSceneObject;

        render();

        // Cylinder has 2 circular edges (top and bottom)
        expect(sel.getShapes()).toHaveLength(2);
      });
    });

    describe("circle / notCircle", () => {
      it("should select circular edges", () => {
        cylinder(30, 50);

        const sel = select(edge().circle()) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(2);
      });

      it("should select circular edges with specific diameter", () => {
        cylinder(30, 50);

        const sel = select(edge().circle(60)) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(2);
      });
    });
  });

  describe("AND logic (chained filters)", () => {
    it("should match faces satisfying all chained filters", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Parallel to XY AND on plane at z=30 → just the top face
      const sel = select(face().parallelTo("xy").onPlane("xy", 30)) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(1);
    });

    it("should return empty when AND conditions are contradictory", () => {
      cylinder(30, 50);

      // circle AND cylinder is impossible (different surface types)
      const sel = select(face().circle().cylinder()) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(0);
    });

    it("should chain edge filters with AND logic", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Lines on the bottom face (z=0)
      const sel = select(edge().line().onPlane("xy")) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(4);
    });
  });

  describe("OR logic (multiple builders)", () => {
    it("should match faces satisfying any builder", () => {
      cylinder(30, 50);

      // Circle faces OR cylindrical faces → all 3 faces
      const sel = select(face().circle(), face().cylinder()) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(3);
    });

    it("should deduplicate results across builders", () => {
      cylinder(30, 50);

      // Both builders match the same circular faces
      const sel = select(face().circle(), face().circle()) as SelectSceneObject;

      render();

      // Should still return 2, not 4
      expect(sel.getShapes()).toHaveLength(2);
    });

    it("should combine edge filters with OR logic", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Edges on bottom OR edges on top
      const sel = select(edge().onPlane("xy"), edge().onPlane("xy", 30)) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(8);
    });

    it("should combine AND within OR", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // (parallel to XY AND on z=0) OR (vertical edges)
      const sel = select(
        face().parallelTo("xy").onPlane("xy"),
        face().notParallelTo("xy")
      ) as SelectSceneObject;

      render();

      // 1 bottom face + 4 side faces = 5
      expect(sel.getShapes()).toHaveLength(5);
    });
  });
});
