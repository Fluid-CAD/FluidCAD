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

    describe("intersectsWith / notIntersectsWith", () => {
      it("should select faces that intersect with a plane", () => {
        sketch("xy", () => {
          move([-50, -25]);
          rect(100, 50);
        });
        extrude(30);

        // XZ plane (y=0) cuts through the centered box.
        // Box spans x:-50..50, y:-25..25, z:0..30.
        // Top, bottom, left, right faces are cut by the plane.
        // Front (y=-25) and back (y=25) are parallel to XZ → not intersected.
        const xzPlane = "xz" as const;
        const sel = select(face().intersectsWith(xzPlane)) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(4);
      });

      it("should select faces not intersecting with a plane", () => {
        sketch("xy", () => {
          move([-50, -25]);
          rect(100, 50);
        });
        extrude(30);

        const xzPlane = "xz" as const;
        const sel = select(face().notIntersectsWith(xzPlane)) as SelectSceneObject;

        render();

        // Front and back faces are parallel to XZ → not intersected
        const shapes = sel.getShapes();
        expect(shapes).toHaveLength(2);
      });

      it("should have complementary results between intersectsWith and notIntersectsWith", () => {
        sketch("xy", () => {
          move([-50, -25]);
          rect(100, 50);
        });
        extrude(30);

        const xzPlane = "xz" as const;
        const intersects = select(face().intersectsWith(xzPlane)) as SelectSceneObject;
        const notIntersects = select(face().notIntersectsWith(xzPlane)) as SelectSceneObject;

        render();

        expect(intersects.getShapes()).toHaveLength(4);
        expect(notIntersects.getShapes()).toHaveLength(2);
        // No overlap
        for (const s of intersects.getShapes()) {
          expect(notIntersects.getShapes().some(ns => ns.isSame(s))).toBe(false);
        }
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

        const sel = select(edge().onPlane("xy", { offset: 30 })) as SelectSceneObject;

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

      it("should select edges on offset plane with bothDirections", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Edges on z=15 or z=-15 — none exist on an extruded box
        const sel = select(edge().onPlane("xy", { offset: 15, bothDirections: true })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(0);
      });

      it("should select edges with partial match", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // partial: true matches edges with at least one vertex on the plane
        // Bottom 4 edges are fully on XY, plus the 4 vertical edges each have one vertex on XY
        const sel = select(edge().onPlane("xy", { partial: true })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });

      it("should exclude edges with partial notOnPlane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // notOnPlane partial: true excludes edges where any vertex touches XY
        // Only the 4 top edges (z=30) have no vertex on XY
        const sel = select(edge().notOnPlane("xy", { partial: true })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });
    });

    describe("above / below", () => {
      it("should select edges entirely above a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Edges above z=10: the 4 top edges (z=30) have both vertices above
        // The 4 vertical edges straddle z=10, so they don't match
        const sel = select(edge().above("xy", { offset: 10 })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });

      it("should select edges entirely below a plane", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Edges below z=10: the 4 bottom edges (z=0) have both vertices below
        const sel = select(edge().below("xy", { offset: 10 })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });

      it("should not match edges on the plane itself", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Edges above z=0: bottom edges are ON the plane (dist=0), not above
        // Only top 4 edges are above, vertical edges straddle
        const sel = select(edge().above("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(4);
      });

      it("should select partially above edges", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // partial: true — match edges where at least one vertex is above z=0
        // Top 4 edges (both vertices above) + 4 vertical edges (one vertex above)
        const sel = select(edge().above("xy", { partial: true })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });

      it("should select partially below edges", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // partial: true — match edges where at least one vertex is below z=30
        // Bottom 4 edges (both vertices below) + 4 vertical edges (one vertex below)
        const sel = select(edge().below("xy", { offset: 30, partial: true })) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(8);
      });

      it("should return empty when no edges match", () => {
        sketch("xy", () => {
          rect(100, 50);
        });
        extrude(30);

        // Nothing is below z=0 on a box sitting on XY
        const sel = select(edge().below("xy")) as SelectSceneObject;

        render();

        expect(sel.getShapes()).toHaveLength(0);
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

  describe("hasEdge / notHasEdge", () => {
    it("should select faces that have circular edges", () => {
      cylinder(30, 50);

      // All 3 faces have circular edges (top, bottom, and cylindrical side bounded by circles)
      const sel = select(face().hasEdge(edge().circle())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(3);
    });

    it("should select faces that have line edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // All 6 faces of a box have line edges
      const sel = select(face().hasEdge(edge().line())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(6);
    });

    it("should select faces with multiple edge criteria (AND)", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Faces that have both a line edge on XY AND a line edge on XY offset 30
      // The 4 side faces each have edges on both bottom and top planes
      const sel = select(face().hasEdge(edge().onPlane("xy"), edge().onPlane("xy", { offset: 30 }))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should select faces with vertical and horizontal edges", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Side faces have both vertical and horizontal edges
      const sel = select(face().hasEdge(edge().verticalTo("xy"), edge().parallelTo("xy"))) as SelectSceneObject;

      render();

      // 4 side faces
      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should combine hasEdge with other face filters", () => {
      cylinder(30, 50);

      // Circle faces that also have circular edges
      const sel = select(face().circle().hasEdge(edge().circle())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(2);
    });

    it("should exclude faces with notHasEdge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Exclude faces that have vertical edges → only top and bottom faces remain
      const sel = select(face().notHasEdge(edge().verticalTo("xy"))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(2);
    });

    it("should have complementary results between hasEdge and notHasEdge", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Side faces have vertical edges, top/bottom do not
      const has = select(face().hasEdge(edge().verticalTo("xy"))) as SelectSceneObject;
      const notHas = select(face().notHasEdge(edge().verticalTo("xy"))) as SelectSceneObject;

      render();

      expect(has.getShapes()).toHaveLength(4);
      expect(notHas.getShapes()).toHaveLength(2);
      // No overlap
      for (const s of has.getShapes()) {
        expect(notHas.getShapes().some(ns => ns.isSame(s))).toBe(false);
      }
    });

    it("should select faces matching edges from a scene object", () => {
      cylinder(30, 50);

      const circleEdges = select(edge().circle());
      const sel = select(face().hasEdge(circleEdges)) as SelectSceneObject;

      render();

      // All 3 cylinder faces share a circular edge
      expect(sel.getShapes()).toHaveLength(3);
    });

    it("should exclude faces with notHasEdge using a scene object", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      const bottomEdges = select(edge().belongsToFace(face().onPlane("xy")));
      const sel = select(face().notHasEdge(bottomEdges)) as SelectSceneObject;

      render();

      // Top face has no edges from the bottom face selection
      expect(sel.getShapes()).toHaveLength(1);
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
      const sel = select(edge().onPlane("xy"), edge().onPlane("xy", { offset: 30 })) as SelectSceneObject;

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

  describe("belongsToFace / notBelongsToFace", () => {
    it("should select edges belonging to circular faces", () => {
      cylinder(30, 50);

      // Circular faces (top and bottom discs) each have 1 circular edge
      const sel = select(edge().belongsToFace(face().circle())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(2);
      expect(sel.getShapes().every(s => s.getType() === "edge")).toBe(true);
    });

    it("should select edges belonging to faces on a specific plane", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Bottom face (on XY) has 4 edges
      const sel = select(edge().belongsToFace(face().onPlane("xy"))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should select edges belonging to faces on offset plane", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Top face (on XY offset 30) has 4 edges
      const sel = select(edge().belongsToFace(face().onPlane("xy", 30))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should select edges with multiple face criteria (AND)", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Edges belonging to a face that is both parallel to XY AND on the bottom plane
      // Only the bottom face matches both criteria → 4 edges
      const sel = select(edge().belongsToFace(face().parallelTo("xy").onPlane("xy"))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should select edges with multiple face filter builders (AND across builders)", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Edges that belong to a face on XY AND also belong to a face NOT parallel to XY
      // Bottom face edges: the 4 bottom edges each also belong to a side face (not parallel to XY)
      const sel = select(edge().belongsToFace(face().onPlane("xy"), face().notParallelTo("xy"))) as SelectSceneObject;

      render();

      // All 4 bottom edges belong to the bottom face (on XY) AND each belongs to a side face (not parallel to XY)
      expect(sel.getShapes()).toHaveLength(4);
    });

    it("should combine belongsToFace with other edge filters", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Line edges that belong to faces parallel to XY (top and bottom)
      // Top face has 4 edges, bottom face has 4 edges → 8 edges total
      const sel = select(edge().line().belongsToFace(face().parallelTo("xy"))) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(8);
    });

    it("should combine belongsToFace with circle edge filter", () => {
      cylinder(30, 50);

      // Circular edges that belong to circular faces (discs)
      // Top and bottom discs each have 1 circular edge → 2 edges
      const sel = select(edge().circle().belongsToFace(face().circle())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(2);
    });

    it("should select edges belonging to cylindrical faces", () => {
      cylinder(30, 50);

      // The cylindrical side face has 3 edges: 2 circular (top/bottom) + 1 seam edge
      const sel = select(edge().belongsToFace(face().cylinder())) as SelectSceneObject;

      render();

      expect(sel.getShapes()).toHaveLength(3);
    });

    it("should exclude edges with notBelongsToFace", () => {
      cylinder(30, 50);

      // Exclude edges belonging to circular faces → only edges on the cylindrical face that aren't shared with discs
      // Cylinder has 3 total edges: 2 circles + 1 seam. The 2 circles belong to circular faces.
      // The seam edge only belongs to the cylindrical face.
      const sel = select(edge().notBelongsToFace(face().circle())) as SelectSceneObject;

      render();

      // Only the seam edge doesn't belong to any circular face
      expect(sel.getShapes()).toHaveLength(1);
    });

    it("should have complementary results between belongsToFace and notBelongsToFace", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Edges belonging to the bottom face vs edges NOT belonging to the bottom face
      const belongs = select(edge().belongsToFace(face().onPlane("xy"))) as SelectSceneObject;
      const notBelongs = select(edge().notBelongsToFace(face().onPlane("xy"))) as SelectSceneObject;

      render();

      expect(belongs.getShapes()).toHaveLength(4);
      // Box has 12 edges total, 4 on bottom face → 8 not on bottom
      expect(notBelongs.getShapes()).toHaveLength(8);
      // No overlap
      for (const s of belongs.getShapes()) {
        expect(notBelongs.getShapes().some(ns => ns.isSame(s))).toBe(false);
      }
    });

    it("should cover all edges between belongsToFace and notBelongsToFace", () => {
      cylinder(30, 50);

      const belongs = select(edge().belongsToFace(face().cylinder())) as SelectSceneObject;
      const notBelongs = select(edge().notBelongsToFace(face().cylinder())) as SelectSceneObject;

      render();

      // Cylinder has 3 edges total, all belong to the cylindrical face
      expect(belongs.getShapes().length + notBelongs.getShapes().length).toBe(3);
      // No overlap
      for (const s of belongs.getShapes()) {
        expect(notBelongs.getShapes().some(ns => ns.isSame(s))).toBe(false);
      }
    });

    it("should select all edges when face filter matches all faces", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Every edge belongs to at least one face that has line edges (all 6 faces of a box)
      const sel = select(edge().belongsToFace(face().hasEdge(edge().line()))) as SelectSceneObject;

      render();

      // All 12 edges of the box
      expect(sel.getShapes()).toHaveLength(12);
    });

    it("should use OR logic with multiple builders", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      extrude(30);

      // Edges on bottom face OR edges on top face
      const sel = select(
        edge().belongsToFace(face().onPlane("xy")),
        edge().belongsToFace(face().onPlane("xy", 30))
      ) as SelectSceneObject;

      render();

      // 4 bottom + 4 top = 8 edges
      expect(sel.getShapes()).toHaveLength(8);
    });

    it("should select edges belonging to faces from a scene object", () => {
      cylinder(30, 50);

      const circleFaces = select(face().circle());
      const sel = select(edge().belongsToFace(circleFaces)) as SelectSceneObject;

      render();

      // Top and bottom disc faces each have 1 circular edge = 2 edges
      expect(sel.getShapes()).toHaveLength(2);
    });

    it("should exclude edges with notBelongsToFace using a scene object", () => {
      cylinder(30, 50);

      const circleFaces = select(face().circle());
      const sel = select(edge().notBelongsToFace(circleFaces)) as SelectSceneObject;

      render();

      // Cylinder has 3 edges; 2 belong to circle faces, so 1 remains (the seam)
      expect(sel.getShapes()).toHaveLength(1);
    });
  });

  describe("withTangents", () => {
    describe("face withTangents", () => {
      it("should expand to tangent side faces but not perpendicular top/bottom", () => {
        sketch("xy", () => {
          rect(200, 100).radius(10);
        });

        extrude(50);

        // "front" = XZ plane (y=0). Matches one flat side face.
        // withTangents should follow cylindrical fillets to adjacent side faces,
        // but NOT cross to top/bottom faces (90° angle = not tangent).
        const sel = select(face().onPlane("front").withTangents()) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();

        // Rounded rect extrusion has:
        // - 2 cap faces (top/bottom on XY planes)
        // - 4 flat side faces
        // - 4 cylindrical fillet faces connecting adjacent sides
        // Total = 10 faces
        //
        // Starting from front face, tangent expansion should include:
        // 4 flat side faces + 4 cylindrical fillet faces = 8
        // (NOT the 2 cap faces which meet at 90°)
        expect(shapes.length).toBe(8);
      });

      it("should not expand when no tangent neighbors exist (sharp box)", () => {
        sketch("xy", () => {
          rect(100, 50);
        });

        extrude(30);

        // Sharp box: all edges are 90° → no tangent expansion
        const sel = select(face().onPlane("front").withTangents()) as SelectSceneObject;

        render();

        // Should still be just the 1 front face
        expect(sel.getShapes()).toHaveLength(1);
      });
    });

    describe("edge withTangents", () => {
      it("should expand to tangent edges along a filleted box bottom", () => {
        sketch("xy", () => {
          rect(200, 100).radius(10);
        });

        extrude(50);

        // Bottom edges on XY plane: 4 line edges + 4 arc edges = 8 edges
        // All are tangent-connected (line→arc→line→arc→...)
        // Selecting one line edge on "front" plane + withTangents should get all 8
        const sel = select(edge().onPlane("xy").onPlane("front").withTangents()) as SelectSceneObject;

        render();

        const shapes = sel.getShapes();
        // The front-bottom edge is tangent to the 2 corner arcs,
        // which are tangent to the left/right bottom edges, etc.
        // All 8 bottom edges form a tangent chain.
        expect(shapes.length).toBe(8);
      });
    });
  });
});
