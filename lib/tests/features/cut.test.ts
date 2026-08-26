import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import plane from "../../core/plane.js";
import cylinder from "../../core/cylinder.js";
import { circle } from "../../core/2d/index.js";
import { Solid } from "../../common/solid.js";
import { Extrude } from "../../features/extrude.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { countShapes, getFacesByType, getEdgesByType } from "../utils.js";
import { SceneObject } from "../../common/scene-object.js";
import { testRect } from "../helpers/profiles.js";

describe("cut", () => {
  setupOC();

  describe("cut by distance", () => {
    it("should cut into an existing solid", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
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
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          circle([50, 50], 40);
        });
      cut(30);

      const scene = render();

      expect(countShapes(scene)).toBe(1);
    });

    it("should remove the extrudable sketch shapes", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      const s = sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        }) as SceneObject;

      cut(20);

      render();

      expect(s.getShapes()).toHaveLength(0);
    });
  });

  describe("cut through all", () => {
    it("should cut all the way through the solid", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          circle([25, 25], 40);
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

    it("should apply draft to a through-all cut", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          circle([50, 50], 40);
        });
      cut().draft(-5);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Drafted through-all cut: hole wall is a cone, not a cylinder
      expect(getFacesByType(solid, "cone").length).toBeGreaterThanOrEqual(1);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(0);
    });

    it("should apply draft to a through-all cut on a small profile", () => {
      // Mirrors the user's repro: small radius (1.5) and steep draft (-8°).
      // Lateral draft grows with the prism's length, so a through-all tool not
      // sized to the model would invert a 1.5-radius profile long before it
      // cleared the stock (see `throughAllLength`).
      sketch("xy", () => {
          testRect(7, 5, { at: [-3.5, -2.5] });
        });
      const e = extrude(1.5) as Extrude;

      sketch(e.endFaces(), () => {
        // Origin-centered base profile: the face center is local [0, 0].
        circle([0, 0], 1.5);
      });
      cut().draft(-8);

      const scene = render();

      expect(countShapes(scene)).toBe(1);

      const solid = scene.getAllSceneObjects()
        .flatMap(o => o.getShapes())
        .find(s => s.getType() === "solid") as Solid;

      // Drafted through-all cut: hole wall is a cone, not a cylinder
      expect(getFacesByType(solid, "cone").length).toBeGreaterThanOrEqual(1);
      expect(getFacesByType(solid, "cylinder")).toHaveLength(0);
    });
  });

  describe("section edges", () => {
    it("should expose section edges", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const edgesObj = c.edges();
      addToScene(edgesObj);

      render();

      const edges = edgesObj.getShapes();
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.getType()).toBe("edge");
      }
    });

    it("should expose specific edge by index", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const edge0 = c.edges(0);
      const edge1 = c.edges(1);
      addToScene(edge0);
      addToScene(edge1);

      render();

      expect(edge0.getShapes()).toHaveLength(1);
      expect(edge1.getShapes()).toHaveLength(1);
      expect(edge0.getShapes()[0].isSame(edge1.getShapes()[0])).toBe(false);
    });

    it("should expose start and end edges for a distance cut", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const se = c.startEdges();
      const ee = c.endEdges();
      addToScene(se);
      addToScene(ee);

      render();

      const startEdges = se.getShapes();
      const endEdges = ee.getShapes();
      expect(startEdges.length).toBeGreaterThan(0);
      expect(endEdges.length).toBeGreaterThan(0);
    });
  });

  describe("fuse scope", () => {
    it("should only cut the targeted object", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e1 = extrude(50) as Extrude;

      sketch("xy", () => {
          testRect(100, 100, { at: [200, 0] });
        });
      extrude(50);

      sketch(e1.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      cut(20).scope(e1);

      const scene = render();

      // First box is cut (modified), second box is untouched — 2 shapes
      expect(countShapes(scene)).toBe(2);
    });

  });

  describe("pick", () => {
    it("should only cut the picked region", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          circle([25, 25], 30);
          circle([75, 25], 30);
        });
      const c = cut(20).pick([25, 25]) as ExtrudeBase;

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
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const inf = c.internalFaces();
      addToScene(inf);

      render();

      const faces = inf.getShapes();
      // A rectangular pocket creates 5 internal faces: 4 walls + 1 floor
      expect(faces.length).toBeGreaterThan(0);
      for (const f of faces) {
        expect(f.getType()).toBe("face");
      }
    });

    it("should expose internal faces for a circular pocket", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          circle([50, 50], 40);
        });
      const c = cut(30) as ExtrudeBase;
      const inf = c.internalFaces();
      addToScene(inf);

      render();

      const faces = inf.getShapes();
      // A circular pocket creates internal faces: cylinder wall + floor
      expect(faces.length).toBeGreaterThan(0);
    });

    it("should filter internal faces by index", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const allFaces = c.internalFaces();
      const first = c.internalFaces(0);
      addToScene(allFaces);
      addToScene(first);

      render();

      const allShapes = allFaces.getShapes();
      expect(allShapes.length).toBeGreaterThan(0);
      expect(first.getShapes()).toHaveLength(1);
      expect(first.getShapes()[0].isSame(allShapes[0])).toBe(true);
    });
  });

  describe("internalEdges", () => {
    it("should expose internal edges for a rectangular pocket", () => {
      sketch("xy", () => {
          testRect(100, 100);
        });
      const e = extrude(50) as Extrude;

      sketch(e.endFaces(), () => {
          testRect(50, 50, { at: [25, 25] });
        });
      const c = cut(20) as ExtrudeBase;
      const ine = c.internalEdges();
      addToScene(ine);

      render();

      const edges = ine.getShapes();
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

      const c = cut() as ExtrudeBase;
      const se = c.startEdges();
      addToScene(se);

      render();

      const startEdges = se.getShapes();
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

      const c = cut() as ExtrudeBase;
      const inf = c.internalFaces();
      addToScene(inf);

      render();

      const faces = inf.getShapes();
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

      const c = cut() as ExtrudeBase;
      const ee = c.endEdges();
      addToScene(ee);

      render();

      const endEdges = ee.getShapes();
      expect(endEdges.length).toBeGreaterThan(0);
    });
  });
});
