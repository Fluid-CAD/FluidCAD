import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import select from "../../../core/select.js";
import { face } from "../../../filters/index.js";
import { project } from "../../../core/2d/index.js";
import { Extrude } from "../../../features/extrude.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { testRect } from "../../helpers/profiles.js";
import { circle } from "../../../core/2d/index.js";
import { Projection } from "../../../features/2d/projection.js";
import { Vertex } from "../../../common/vertex.js";

describe("project", () => {
  setupOC();

  describe("project a previous sketch", () => {
    it("projects a coplanar sketch as fixed reference edges without consuming it", () => {
      const s1 = sketch("xy", () => {
        testRect(100, 50);
      }) as Sketch;

      let p!: Projection;
      const s2 = sketch("xy", () => {
        p = project(s1) as unknown as Projection;
      }) as Sketch;

      render();

      expect(p.getError()).toBeNull();
      expect(s2.getShapes().length).toBe(4);
      expect(p.referenceEntities()).toHaveLength(4);
      // The source sketch is referenced, not consumed: it still serves its
      // geometry and carries no removal by the projection.
      expect(s1.getShapes().length).toBe(4);
      const removedByProjection = s1.getChildren()
        .flatMap(c => c.getRemovedShapes())
        .filter(r => r.removedBy === p);
      expect(removedByProjection).toHaveLength(0);
    });

    it("still projects a sketch an extrude already consumed", () => {
      const s1 = sketch("xy", () => {
        testRect(100, 50);
      }) as Sketch;
      extrude(30);

      let p!: Projection;
      const s2 = sketch("xy", () => {
        p = project(s1) as unknown as Projection;
      }) as Sketch;

      render();

      expect(p.getError()).toBeNull();
      expect(s2.getShapes().length).toBe(4);
      expect(p.referenceEntities()).toHaveLength(4);
    });

    it("projects a perpendicular sketch edge-on: parallel edges merge, normal edges drop", () => {
      const s1 = sketch("xy", () => {
        testRect(100, 50);
      }) as Sketch;

      let p!: Projection;
      const s2 = sketch("xz", () => {
        p = project(s1) as unknown as Projection;
      }) as Sketch;

      render();

      expect(p.getError()).toBeNull();
      // The two x-parallel edges land on one line; the two y-parallel edges
      // are normal to xz and vanish.
      expect(s2.getShapes().length).toBe(1);
      expect(p.referenceEntities()).toHaveLength(1);
    });

    it("projects an entity a sketch returned", () => {
      const s1 = sketch("xy", () => {
        const c = circle([10, 20], 30);
        return { c };
      });
      extrude(5);

      let p!: Projection;
      const s2 = sketch("xy", () => {
        p = project(s1.geometries.c) as unknown as Projection;
      }) as Sketch;

      render();

      expect(p.getError()).toBeNull();
      expect(s2.getShapes().length).toBe(1);
      expect(p.referenceEntities()).toHaveLength(1);
      expect(p.referenceEntities()[0].kind).toBe("circle");
    });

    it("refuses geometry of the sketch it is drawn in", () => {
      let p!: Projection;
      sketch("xy", () => {
        const c = circle([0, 0], 10);
        p = project(c) as unknown as Projection;
      });

      render();

      expect(p.getError()).toContain("cannot reference geometry of the sketch it is drawn in");
    });
  });

  describe("project 3D shape onto sketch plane", () => {
    it("should project a box onto the current sketch plane", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });

      const e = extrude(30) as Extrude;

      const s = sketch("xy", () => {
        project(e.sideFaces(0));
      }) as Sketch;

      render();

      const shapes = s.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
    });

    it("should project a mix of face and edge accessors in one call", () => {
      // The exact argument shape the Project sketch tool synthesizes: one
      // accessor per picked bucket, faces and edges side by side.
      sketch("xy", () => {
          testRect(100, 50);
        });

      const e = extrude(30) as Extrude;

      const s = sketch("xz", () => {
        project(e.endFaces(), e.startEdges());
      }) as Sketch;

      render();

      expect(s.getShapes().length).toBeGreaterThan(0);
    });

    it("projects a select() declared outside the sketch (the hoisted form)", () => {
      // The Project tool synthesizes `project(select(…))` for producer-less
      // picks, but select() captures the container it runs in — so the
      // transform lifts it to a const BEFORE the sketch. This is the shape it
      // emits: a working projection needs the select outside the callback.
      sketch("xy", () => {
          testRect(100, 50);
        });

      extrude(30);

      const sel = select(face().planar());
      const s = sketch("xz", () => {
        project(sel);
      }) as Sketch;

      render();

      expect(s.getShapes().length).toBeGreaterThan(0);
    });
  });

  describe("center meta vertices", () => {
    it("emits a center vertex for a projected circle, like a native circle()", () => {
      // A projected bore rendered without its center dot only revealed the
      // center on hover — the meta vertex is what the sketch mesh draws.
      sketch("xy", () => {
        circle([10, 20], 30);
      });
      const e = extrude(15) as Extrude;

      let p!: Projection;
      sketch("xy", () => {
        p = project(e.endFaces(0)) as Projection;
      });
      render();

      const centers = p.getShapes({ excludeMeta: false, excludeGuide: false })
        .filter(s => s.isVertex() && s.isMetaShape()) as Vertex[];
      expect(centers.length).toBe(1);
      expect(centers[0].toPoint().x).toBeCloseTo(10, 6);
      expect(centers[0].toPoint().y).toBeCloseTo(20, 6);
      // Profiles still see only the perimeter.
      expect(p.getShapes().every(s => !s.isVertex())).toBe(true);
    });
  });
});
