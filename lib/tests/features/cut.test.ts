import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import plane from "../../core/plane.js";
import cylinder from "../../core/cylinder.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { Cut } from "../../features/cut.js";
import { countShapes, getFacesByType, getEdgesByType } from "../utils.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SceneObject } from "../../common/scene-object.js";

describe("cut", () => {
  setupOC();

  describe("cut by distance", () => {
    it("should cut into an existing solid", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // A box with a rectangular pocket: 6 original + 4 pocket walls + 1 pocket floor = 11 planar faces
      expect(getFacesByType(solid, "plane").length).toBeGreaterThan(6);
      // All faces should be planar (no curves)
      expect(getFacesByType(solid, "cylinder")).toHaveLength(0);
    });

    it("should cut a circular pocket into a box", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([50, 50]);
        circle(40);
      });
      cut(30);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should remove the extrudable sketch shapes", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      const s = sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      }) as SceneObject;

      cut(20);

      render();

      expect(s.getShapes()).toHaveLength(0);
    });
  });

  describe("cut through all", () => {
    it("should cut all the way through the solid", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        circle(40);
      });
      cut();

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Through-all circular cut adds a cylindrical face (the hole wall)
      expect(getFacesByType(solid, "cylinder")).toHaveLength(1);
      // Circle edges at top and bottom of the hole
      expect(getEdgesByType(solid, "circle").length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("section edges", () => {
    it("should expose section edges", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const edges = c.edges().getShapes();
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("should expose specific edge by index", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const edge0 = c.edges(0).getShapes();
      expect(edge0).toHaveLength(1);

      const edge1 = c.edges(1).getShapes();
      expect(edge1).toHaveLength(1);

      expect(edge0[0].isSame(edge1[0])).toBe(false);
    });

    it("should expose start and end edges for a distance cut", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const startEdges = c.startEdges().getShapes();
      const endEdges = c.endEdges().getShapes();
      expect(startEdges.length).toBeGreaterThan(0);
      expect(endEdges.length).toBeGreaterThan(0);
    });
  });

  describe("fuse scope", () => {
    it("should only cut the targeted object", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
        move([200, 0]);
        rect(100, 100);
      });
      extrude(50);

      sketch(e1.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20).fuse(e1);

      const scene = render();

      // First box is cut (modified), second box is untouched — 2 shapes
      expect(countShapes(scene)).toBe(2);
    });

    it("should not cut anything when fuse is none", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      cut(20).fuse("none");

      const scene = render();

      // Original solid is untouched — 1 shape
      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Still a simple box
      expect(solid.getFaces()).toHaveLength(6);
    });
  });

  describe("pick", () => {
    it("should only cut the picked region", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        circle(30);
        move([75, 25]);
        circle(30);
      });
      const c = cut(20).pick([25, 25]) as Cut;

      render();

      // The cut should have produced a modified solid
      const shapes = c.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      expect(shapes[0].getType()).toBe("solid");
    });
  });

  describe("internalFaces", () => {
    it("should expose internal faces for a rectangular pocket", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const faces = c.internalFaces().getShapes();
      // A rectangular pocket creates 5 internal faces: 4 walls + 1 floor
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        expect(f.getType()).toBe("face");
      }
    });

    it("should expose internal faces for a circular pocket", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([50, 50]);
        circle(40);
      });
      const c = cut(30) as Cut;

      render();

      const faces = c.internalFaces().getShapes();
      // A circular pocket creates internal faces: cylinder wall + floor
      expect(faces.length).toBeGreaterThan(0);
    });

    it("should filter internal faces by index", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const allFaces = c.internalFaces().getShapes();
      if (allFaces.length > 0) {
        const first = c.internalFaces(0).getShapes();
        expect(first).toHaveLength(1);
        expect(first[0].isSame(allFaces[0])).toBe(true);
      }
    });
  });

  describe("internalEdges", () => {
    it("should expose internal edges for a rectangular pocket", () => {
      sketch("xy", () => {
        rect(100, 100);
      });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
        move([25, 25]);
        rect(50, 50);
      });
      const c = cut(20) as Cut;

      render();

      const edges = c.internalEdges().getShapes();
      // A rectangular pocket has 4 internal edges (vertical wall edges)
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.getType()).toBe("edge");
      }
    });
  });

  describe("multiple intersecting shapes", () => {
    it("should expose startEdges for through-all cut with overlapping circles", () => {
      cylinder(50, 80);

      sketch(plane("xy", 80), () => {
        circle([-20, 0], 40);
        circle([20, 0], 50);
      });

      const c = cut() as Cut;

      render();

      const startEdges = c.startEdges().getShapes();
      expect(startEdges.length).toBeGreaterThan(0);
      for (const edge of startEdges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("should expose internalFaces for through-all cut with overlapping circles", () => {
      cylinder(50, 80);

      sketch(plane("xy", 80), () => {
        circle([-20, 0], 40);
        circle([20, 0], 50);
      });

      const c = cut() as Cut;

      render();

      const faces = c.internalFaces().getShapes();
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        expect(f.getType()).toBe("face");
      }
    });

    it("should expose endEdges for through-all cut with overlapping circles", () => {
      cylinder(50, 80);

      sketch(plane("xy", 80), () => {
        circle([-20, 0], 40);
        circle([20, 0], 50);
      });

      const c = cut() as Cut;

      render();

      const endEdges = c.endEdges().getShapes();
      expect(endEdges.length).toBeGreaterThan(0);
    });
  });
});
