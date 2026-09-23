import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { circle, line } from "../../../core/2d/index.js";
import { rect } from "../../../core/shapes/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Extrude } from "../../../features/extrude.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { testRect } from "../../helpers/profiles.js";
import { runFluid } from "../../helpers/run-fluid.js";
import { parseRegionKey, formatRegionKey, RegionKeyError } from "../../../features/2d/regions/region-key.js";
import { resolveRegions } from "../../../features/2d/regions/region-match.js";
import type { SketchRegion } from "../../../features/2d/regions/region-builder.js";

// Region keys: a sketch region is named by the statements on its outer
// loop, each with the side the region lies on. Keys are topological — no
// coordinate in them — so a dimension edit never moves a region away from
// its key, and a key survives the edits other CAD systems survive.

const keysOf = (regions: SketchRegion[]) => regions.map(r => r.key);

describe("region keys", () => {
  setupOC();

  describe("grammar", () => {
    it("parses entities, sub-keys and sides", () => {
      expect(parseRegionKey("b r t l")).toEqual([
        { entity: 'b', path: [], right: false },
        { entity: 'r', path: [], right: false },
        { entity: 't', path: [], right: false },
        { entity: 'l', path: [], right: false },
      ]);
      expect(parseRegionKey("c1 c2-")).toEqual([
        { entity: 'c1', path: [], right: false },
        { entity: 'c2', path: [], right: true },
      ]);
      expect(parseRegionKey("r1.top circle#2- l[3]")).toEqual([
        { entity: 'r1', path: ['top'], right: false },
        { entity: 'circle#2', path: [], right: true },
        { entity: 'l[3]', path: [], right: false },
      ]);
      expect(formatRegionKey(parseRegionKey("  c1,  c2-  "))).toBe("c1 c2-");
    });

    it("refuses what is not a key", () => {
      expect(() => parseRegionKey("")).toThrow(RegionKeyError);
      expect(() => parseRegionKey("1abc")).toThrow(RegionKeyError);
      expect(() => parseRegionKey("a..b")).toThrow(RegionKeyError);
      expect(() => parseRegionKey("a b-c")).toThrow(RegionKeyError);
    });
  });

  describe("naming", () => {
    it("names a rectangle by its four lines, all on their left (counter-clockwise)", () => {
      const s = sketch("xy", () => {
        testRect(100, 50);
      }) as unknown as Sketch;
      render();

      // Statements drawn from a TypeScript test carry no source location,
      // so every key falls back to the callee ordinal.
      expect(keysOf(s.buildRegions())).toEqual(["line#1 line#2 line#3 line#4"]);
    });

    it("names a region by its outer loop only — a hole inside it is a region of its own", () => {
      const s = sketch("xy", () => {
        circle([0, 0], 60);
        circle([0, 0], 30);
      }) as unknown as Sketch;
      render();

      // The ring's outer loop is circle 1; circle 2 is its hole and names
      // the disc. Cutting a hole into a region never changes its key. The
      // ring sorts first: it lies on the older statement.
      expect(keysOf(s.buildRegions())).toEqual(["circle#1", "circle#2"]);
    });

    it("tells the lens and both crescents of two overlapping circles apart", () => {
      const s = sketch("xy", () => {
        circle([-20, 0], 80);
        circle([20, 0], 80);
      }) as unknown as Sketch;
      render();

      expect(keysOf(s.buildRegions()).sort()).toEqual([
        "circle#1 circle#2",
        "circle#1 circle#2-",
        "circle#1- circle#2",
      ].sort());
    });

    it("names the halves of a rectangle a line splits by the line's side", () => {
      const s = sketch("xy", () => {
        testRect(100, 50);
        line([50, -10], [50, 60]);
      }) as unknown as Sketch;
      render();

      // The vertical line runs +y: the left half lies on its left, the right
      // half on its right. Each half keeps the rectangle's lines it still
      // touches, and the key walks the loop from the oldest statement.
      expect(keysOf(s.buildRegions())).toEqual([
        "line#1 line#2 line#3 line#5-",
        "line#1 line#5 line#3 line#4",
      ]);
    });

    it("names a rect() macro's edges by their slots", () => {
      const s = sketch("xy", () => {
        rect([0, 0], 40, 25);
      }) as unknown as Sketch;
      render();

      expect(keysOf(s.buildRegions())).toEqual(["rect#1.bottom rect#1.right rect#1.top rect#1.left"]);
    });

    it("reads binding names from the sketch callback's source", () => {
      const { s } = runFluid(`
        const s = sketch("xy", () => {
          const b = line([0, 0], [100, 0]);
          const r = line([100, 0], [100, 50]);
          const t = line([100, 50], [0, 50]);
          const l = line([0, 50], [0, 0]);
          coincident(b.end(), r.start());
          coincident(r.end(), t.start());
          coincident(t.end(), l.start());
          coincident(l.end(), b.start());
          const h1 = circle([30, 25], 8);
          circle([70, 25], 8);
        });
        return { s };
      `) as { s: Sketch };
      render();

      // Bound statements are named; the unbound circle is the sketch's
      // second circle statement. A hole is a region of its own, and the
      // plate's outer loop ignores the holes inside it.
      expect(keysOf(s.buildRegions())).toEqual(["b r t l", "h1", "circle#2"]);
    });

    it("reads every binding form, and falls back for statements that are not bound", () => {
      const { s } = runFluid(`
        const s = sketch("xy", () => {
          const a = circle([0, 0], 10), b = circle([40, 0], 10);
          let c = circle([80, 0], 10);
          const kept = [];
          kept.push(circle([120, 0], 10));
          circle([160, 0], 10);
        });
        return { s };
      `) as { s: Sketch };
      render();

      expect(keysOf(s.buildRegions())).toEqual(["a", "b", "c", "circle#4", "circle#5"]);
    });

    it("numbers the runs of a call site a loop executes", () => {
      const { s } = runFluid(`
        const s = sketch("xy", () => {
          for (let i = 0; i < 3; i++) {
            const c = circle([i * 30, 0], 10);
          }
        });
        return { s };
      `) as { s: Sketch };
      render();

      expect(keysOf(s.buildRegions())).toEqual(["c[0]", "c[1]", "c[2]"]);
    });

    it("finds names when the callback opens below the sketch line", () => {
      const { s } = runFluid(`
        const s = sketch(
          "xy",
          () => {
            const outer = circle([0, 0], 60);
            const inner = circle([0, 0], 30);
          },
        );
        return { s };
      `) as { s: Sketch };
      render();

      expect(keysOf(s.buildRegions())).toEqual(["outer", "inner"]);
    });
  });

  describe("matching", () => {
    const ring = (): SketchRegion[] => {
      const s = sketch("xy", () => {
        circle([0, 0], 60);
        circle([0, 0], 30);
      }) as unknown as Sketch;
      render();
      return s.buildRegions();
    };

    it("resolves an exact key, a position, and a partial key that lies on one region", () => {
      const regions = ring();
      expect(keysOf(resolveRegions(["circle#1"], regions).selected)).toEqual(["circle#1"]);
      expect(keysOf(resolveRegions([1], regions).selected)).toEqual(["circle#2"]);
      expect(keysOf(resolveRegions(["circle#2"], regions).selected)).toEqual(["circle#2"]);

      // A partial key: the lens of two overlapping circles is the one region
      // on the left of both.
      const s = sketch("xy", () => {
        circle([-20, 0], 80);
        circle([20, 0], 80);
      }) as unknown as Sketch;
      render();
      const cells = s.buildRegions();
      expect(keysOf(resolveRegions(["circle#1 circle#2"], cells).selected)).toEqual(["circle#1 circle#2"]);
      // `circle#1` alone lies on two of them (the lens and one crescent).
      const partial = resolveRegions(["circle#1"], cells);
      expect(partial.selected).toEqual([]);
      expect(partial.problems[0]).toContain("ambiguous");
    });

    it("keeps a region whose boundary only grew or shrank a little", () => {
      const s = sketch("xy", () => {
        testRect(100, 50);
        line([50, -10], [50, 90]);
        line([-10, 25], [40, 25]);
      }) as unknown as Sketch;
      render();
      const regions = s.buildRegions();
      // Two more lines cut the rectangle into three cells. The key of the
      // old right half still finds it; the old left half's key now covers
      // two cells' worth of boundary equally and is refused as ambiguous.
      const right = resolveRegions(["line#1 line#2 line#3 line#5-"], regions);
      expect(right.problems).toEqual([]);
      expect(right.selected).toHaveLength(1);
      expect(right.selected[0].key).toBe("line#1 line#2 line#3 line#5-");

      const whole = resolveRegions(["line#1 line#2 line#3 line#4"], regions);
      expect(whole.selected).toEqual([]);
      expect(whole.problems[0]).toMatch(/equally well|ambiguous|not found/);
    });

    it("survives an earlier statement of the same kind being deleted", () => {
      // The key was written when a fifth line preceded the rectangle's
      // four; that line is gone and the ordinals slid down by one. Three
      // of the four named half-edges still lie on the rectangle, nothing
      // else comes close, so the region is found.
      const s = sketch("xy", () => {
        testRect(100, 50);
        circle([200, 0], 20);
      }) as unknown as Sketch;
      render();
      const regions = s.buildRegions();
      const found = resolveRegions(["line#2 line#3 line#4 line#5"], regions);
      expect(found.problems).toEqual([]);
      expect(keysOf(found.selected)).toEqual(["line#1 line#2 line#3 line#4"]);
    });

    it("names what went wrong", () => {
      const regions = ring();
      const missing = resolveRegions(["nothing"], regions);
      expect(missing.selected).toEqual([]);
      expect(missing.problems[0]).toContain("'nothing' not found");
      expect(missing.problems[0]).toContain("'circle#1'");

      const outOfRange = resolveRegions([5], regions);
      expect(outOfRange.problems[0]).toContain("region(5)");

      const bad = resolveRegions(["1abc"], regions);
      expect(bad.problems[0]).toContain("'1abc'");
    });
  });

  describe("extrude().region()", () => {
    it("extrudes only the keyed region, the hole inside it kept", () => {
      sketch("xy", () => {
        circle([0, 0], 60);
        circle([0, 0], 30);
      });
      const e = extrude(20).region("circle#1") as Extrude;
      render();

      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      expect(e.getError()).toBeNull();
      const faces = solids[0].getSubShapes('face');
      // A ring: two caps plus the outer and inner cylinders.
      expect(faces).toHaveLength(4);
    });

    it("takes several regions and positions", () => {
      sketch("xy", () => {
        circle([0, 0], 60);
        circle([100, 0], 60);
      });
      const e = extrude(20).region(0, "circle#2") as Extrude;
      render();

      expect(e.getShapes()).toHaveLength(2);
      expect(e.getError()).toBeNull();
    });

    it("builds nothing but lists every region when called without keys", () => {
      sketch("xy", () => {
        circle([0, 0], 60);
        circle([100, 0], 60);
      });
      const e = extrude(20).region() as Extrude;
      render();

      expect(e.getShapes()).toHaveLength(0);
      const all = e.getAddedShapes();
      expect(all.filter(s => s.metaType === 'pick-region')).toHaveLength(2);
      expect(all.filter(s => s.metaType === 'pick-region-selected')).toHaveLength(0);
      const serialized = e.serialize() as any;
      expect(serialized.regionPicking).toBe(true);
      expect(serialized.regions).toEqual([
        { key: 'circle#1', index: 0, selected: false },
        { key: 'circle#2', index: 1, selected: false },
      ]);
    });

    it("reports a lost region on the feature and still builds the rest", () => {
      sketch("xy", () => {
        circle([0, 0], 60);
        circle([100, 0], 60);
      });
      const e = extrude(20).region("circle#1", "circle#9") as Extrude;
      render();

      expect(e.getShapes()).toHaveLength(1);
      expect(e.getError()).toContain("'circle#9' not found");
    });

    it("keeps its region through a dimension change", () => {
      const build = (radius: number) => {
        sketch("xy", () => {
          circle([-20, 0], 80);
          circle([20, 0], radius);
        });
        const e = extrude(20).region("circle#1 circle#2") as Extrude;
        render();
        return e;
      };
      const lens = build(80);
      const bbox = ShapeOps.getBoundingBox(lens.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeLessThan(80);
    });
  });
});
