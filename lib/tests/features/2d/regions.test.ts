import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { circle, line, region, far } from "../../../core/2d/index.js";
import { rect } from "../../../core/shapes/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Extrude } from "../../../features/extrude.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { testRect } from "../../helpers/profiles.js";
import { runFluid } from "../../helpers/run-fluid.js";
import { matchItems } from "../../../features/2d/regions/region-match.js";
import { StatementLabels } from "../../../features/2d/regions/statement-label.js";
import { itemRefOf, writableItems } from "../../../features/2d/regions/region-wire.js";
import { regionItemOf } from "../../../features/2d/regions/region-ref.js";
import type { SketchRegion } from "../../../features/2d/regions/region-builder.js";
import type { ISceneObject } from "../../../core/interfaces.js";

// Region declarations: `region('name', ...entities)` inside the sketch
// callback names a region by the statements on its outer loop, passed by
// value; `far(entity)` puts the region on the entity's far side. A consumer
// selects it with `.region('name')`. Nothing here depends on variable names
// or coordinates, so a dimension edit never moves a region away from its
// declaration, and the kernel never reads the callback's source text.

const keysOf = (regions: SketchRegion[]) => regions.map(r => r.key);

describe("region declarations", () => {
  setupOC();

  describe("the arrangement", () => {
    it("describes a rectangle by its four lines, all on their left (counter-clockwise)", () => {
      const s = sketch("xy", () => {
        testRect(100, 50);
      }) as unknown as Sketch;
      render();

      expect(keysOf(s.buildRegions())).toEqual(["line#1 line#2 line#3 line#4"]);
    });

    it("describes a region by its outer loop only — a hole inside it is a region of its own", () => {
      const s = sketch("xy", () => {
        circle([0, 0], 60);
        circle([0, 0], 30);
      }) as unknown as Sketch;
      render();

      // The ring's outer loop is circle 1; circle 2 is its hole and bounds
      // the disc. The ring sorts first: it lies on the older statement.
      expect(keysOf(s.buildRegions())).toEqual(["circle#1", "circle#2"]);
    });

    it("tells the lens and both crescents of two overlapping circles apart by side", () => {
      const s = sketch("xy", () => {
        circle([-20, 0], 80);
        circle([20, 0], 80);
      }) as unknown as Sketch;
      render();

      expect(keysOf(s.buildRegions()).sort()).toEqual([
        "circle#1 circle#2",
        "circle#1 far(circle#2)",
        "far(circle#1) circle#2",
      ].sort());
    });

    it("describes the halves of a rectangle a line splits by the line's side", () => {
      const s = sketch("xy", () => {
        testRect(100, 50);
        line([50, -10], [50, 60]);
      }) as unknown as Sketch;
      render();

      // The vertical line runs +y: the left half lies on its left, the right
      // half on its right.
      expect(keysOf(s.buildRegions())).toEqual([
        "line#1 line#2 line#3 far(line#5)",
        "line#1 line#5 line#3 line#4",
      ]);
    });

    it("describes a rect() macro's edges by their slots", () => {
      const s = sketch("xy", () => {
        rect([0, 0], 40, 25);
      }) as unknown as Sketch;
      render();

      expect(keysOf(s.buildRegions())).toEqual(["rect#1.bottom rect#1.right rect#1.top rect#1.left"]);
    });
  });

  describe("declaring", () => {
    it("registers the declaration with the sketch, by the entities it was given", () => {
      let outer!: ISceneObject;
      let inner!: ISceneObject;
      const s = sketch("xy", () => {
        outer = circle([0, 0], 60);
        inner = circle([0, 0], 30);
        region("ring", outer);
        region("disc", inner);
      }) as unknown as Sketch;
      render();

      const declared = s.declaredRegions();
      expect([...declared.keys()]).toEqual(["ring", "disc"]);
      expect(declared.get("ring")!.items).toEqual([{ owner: outer, path: [], right: false }]);
      expect(declared.get("ring")!.getError()).toBeNull();
    });

    it("reads far(), macro edges and sub-edges", () => {
      let c!: ISceneObject;
      let r!: ReturnType<typeof rect>;
      sketch("xy", () => {
        c = circle([0, 0], 60);
        r = rect([0, 0], 40, 25);
      });
      expect(regionItemOf(far(c as never) as never)).toEqual({ owner: c, path: [], right: true });
      expect(regionItemOf(r.top() as never)).toEqual({ owner: r, path: ["top"], right: false });
      expect(regionItemOf(far(r.left() as never) as never)).toEqual({ owner: r, path: ["left"], right: true });
      expect(() => regionItemOf("c1" as never)).toThrow(/takes sketch entities/);
    });

    it("stashes its problems as the statement's own error", () => {
      let stray!: ISceneObject;
      const other = sketch("xy", () => {
        stray = circle([100, 0], 10);
      }) as unknown as Sketch;
      const s = sketch("xy", () => {
        const c = circle([0, 0], 60);
        region("a", c);
        region("a", c);
        region("b");
        region("c", stray);
      }) as unknown as Sketch;
      const loose = region("outside", stray) as unknown as Sketch;
      render();

      const rows = s.getChildren().filter(child => child.getType() === 'region');
      expect(rows[0].getError()).toBeNull();
      expect(rows[1].getError()).toContain("declared twice");
      expect(rows[2].getError()).toContain("names no entity");
      expect(rows[3].getError()).toContain("another sketch");
      expect(loose.getError()).toContain("inside a sketch");
      expect(other.declaredRegions().size).toBe(0);
    });
  });

  describe("resolving", () => {
    const labelsOf = (s: Sketch) => StatementLabels.ofSketchChildren(s.getChildren());

    it("finds a region by its exact boundary, a bare statement covering every edge, and a subset that pins one region", () => {
      let a!: ISceneObject;
      let b!: ISceneObject;
      const s = sketch("xy", () => {
        a = circle([-20, 0], 80);
        b = circle([20, 0], 80);
      }) as unknown as Sketch;
      render();
      const cells = s.buildRegions();
      const labels = labelsOf(s);
      const item = (owner: ISceneObject, right = false) => ({ owner: owner as never, path: [], right });

      expect(matchItems([item(a), item(b)], cells, labels).region!.key).toBe("circle#1 circle#2");
      expect(matchItems([item(a), item(b, true)], cells, labels).region!.key).toBe("circle#1 far(circle#2)");
      // `a` alone lies on two cells (the lens and one crescent).
      const partial = matchItems([item(a)], cells, labels);
      expect(partial.region).toBeUndefined();
      expect(partial.problem).toContain("ambiguous");
      expect(partial.problem).toContain("far()");
    });

    it("covers every edge of a multi-edge statement with its bare reference", () => {
      let r!: ReturnType<typeof rect>;
      let l!: ISceneObject;
      const s = sketch("xy", () => {
        r = rect([0, 0], 100, 50);
        l = line([50, -10], [50, 60]);
      }) as unknown as Sketch;
      render();
      const cells = s.buildRegions();
      const labels = labelsOf(s);

      // The line runs +y, so the left half of the rectangle lies on its left.
      const left = matchItems([{ owner: r as never, path: [], right: false }, { owner: l as never, path: [], right: false }], cells, labels);
      expect(left.region!.key).toBe("rect#1.bottom line#1 rect#1.top rect#1.left");
      const right = matchItems([{ owner: r as never, path: [], right: false }, { owner: l as never, path: [], right: true }], cells, labels);
      expect(right.region!.key).toBe("rect#1.bottom rect#1.right rect#1.top far(line#1)");
    });

    it("keeps a region whose boundary only grew or shrank a little", () => {
      let b!: ISceneObject, r!: ISceneObject, t!: ISceneObject, l!: ISceneObject, v!: ISceneObject;
      const s = sketch("xy", () => {
        b = line([0, 0], [100, 0]);
        r = line([100, 0], [100, 50]);
        t = line([100, 50], [0, 50]);
        l = line([0, 50], [0, 0]);
        v = line([50, -10], [50, 90]);
        line([-10, 25], [40, 25]);
      }) as unknown as Sketch;
      render();
      const cells = s.buildRegions();
      const labels = labelsOf(s);
      const item = (owner: ISceneObject, right = false) => ({ owner: owner as never, path: [], right });

      // Two more lines cut the rectangle into three cells. The old right
      // half's boundary still finds it; the old whole rectangle's boundary
      // now covers two cells' worth of boundary equally and is refused.
      const rightHalf = matchItems([item(b), item(r), item(t), item(v, true)], cells, labels);
      expect(rightHalf.region!.key).toBe("line#1 line#2 line#3 far(line#5)");
      const whole = matchItems([item(b), item(r), item(t), item(l)], cells, labels);
      expect(whole.region).toBeUndefined();
      expect(whole.problem).toMatch(/equally well|ambiguous|not found/);
    });
  });

  describe("extrude().region()", () => {
    it("extrudes only the declared region, the hole inside it kept", () => {
      const s = sketch("xy", () => {
        const outer = circle([0, 0], 60);
        circle([0, 0], 30);
        region("ring", outer);
      });
      const e = extrude(20, s).region("ring") as Extrude;
      render();

      const solids = e.getShapes();
      expect(solids).toHaveLength(1);
      expect(e.getError()).toBeNull();
      // A ring: two caps plus the outer and inner cylinders.
      expect(solids[0].getSubShapes('face')).toHaveLength(4);
    });

    it("takes several regions, and far() picks the far side", () => {
      const s = sketch("xy", () => {
        const a = circle([-20, 0], 80);
        const b = circle([20, 0], 80);
        region("lens", a, b);
        region("leftCrescent", a, far(b));
      });
      const e = extrude(20, s).region("lens", "leftCrescent") as Extrude;
      render();

      // The lens and the left crescent share an arc, so the two regions fuse
      // into the whole of `a`: 80 wide, where the lens alone is narrower.
      expect(e.getError()).toBeNull();
      expect(e.getShapes()).toHaveLength(1);
      const both = ShapeOps.getBoundingBox(e.getShapes()[0]);
      expect(both.maxX - both.minX).toBeCloseTo(80, 0);
      expect(both.minX).toBeCloseTo(-60, 0);
    });

    it("reads the declarations of the sketch a primitive belongs to", () => {
      let c!: ISceneObject;
      sketch("xy", () => {
        circle([0, 0], 100);
        c = circle([0, 0], 60);
        region("disc", c);
      });
      const e = extrude(20, c as never).region("disc") as Extrude;
      render();

      expect(e.getError()).toBeNull();
      expect(e.getShapes()).toHaveLength(1);
      expect(ShapeOps.getBoundingBox(e.getShapes()[0]).maxX).toBeCloseTo(30, 0);
    });

    it("builds nothing but lists every region when called without names", () => {
      const s = sketch("xy", () => {
        const a = circle([0, 0], 60);
        circle([100, 0], 60);
        region("left", a);
      });
      const e = extrude(20, s).region() as Extrude;
      render();

      expect(e.getShapes()).toHaveLength(0);
      const all = e.getAddedShapes();
      expect(all.filter(sh => sh.metaType === 'pick-region')).toHaveLength(2);
      expect(all.filter(sh => sh.metaType === 'pick-region-selected')).toHaveLength(0);
      const serialized = e.serialize() as any;
      expect(serialized.regionPicking).toBe(true);
      expect(serialized.regions).toEqual([
        { key: 'circle#1', index: 0, name: 'left', selected: false },
        { key: 'circle#2', index: 1, name: null, selected: false },
      ]);
    });

    it("reports an undeclared or ambiguous region on the feature and still builds the rest", () => {
      const s = sketch("xy", () => {
        const a = circle([-20, 0], 80);
        const b = circle([20, 0], 80);
        region("lens", a, b);
        region("some", a);
      });
      const e = extrude(20, s).region("lens", "gone", "some") as Extrude;
      render();

      expect(e.getShapes()).toHaveLength(1);
      expect(e.getError()).toContain("'gone' is not declared");
      expect(e.getError()).toContain("declared: 'lens', 'some'");
      expect(e.getError()).toContain("'some' is ambiguous");
    });

    it("names a declaration's own problem when a feature uses it", () => {
      const s = sketch("xy", () => {
        region("empty");
      });
      const e = extrude(20, s).region("empty") as Extrude;
      render();

      expect(e.getError()).toContain("region 'empty': region('empty') names no entity");
    });

    it("refuses on a face source", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      const base = extrude(10) as Extrude;
      const e = extrude(5, base as never).region("top") as Extrude;
      render();
      expect(e.getError()).toContain("needs a sketch source");
    });

    it("keeps its region through a dimension change", () => {
      const build = (radius: number) => {
        const s = sketch("xy", () => {
          const a = circle([-20, 0], 80);
          const b = circle([20, 0], radius);
          region("lens", a, b);
        });
        const e = extrude(20, s).region("lens") as Extrude;
        render();
        return e;
      };
      const lens = build(80);
      const bbox = ShapeOps.getBoundingBox(lens.getShapes()[0]);
      expect(bbox.maxX - bbox.minX).toBeLessThan(80);
      expect(lens.getError()).toBeNull();
    });
  });

  describe("the wire form", () => {
    it("writes whole statements with their sides, addressed by source line", () => {
      const { s } = runFluid(`
        const s = sketch("xy", () => {
          const a = circle([-20, 0], 80);
          const b = circle([20, 0], 80);
        });
        return { s };
      `) as { s: Sketch };
      render();
      const line = s.getSourceLocation()!.line;
      const cells = s.buildRegions();
      const crescent = cells.find(c => c.key === "circle#1 far(circle#2)")!;

      const refs = writableItems(crescent, cells).map(item => itemRefOf(item, s));
      expect(refs).toEqual([
        { line: line + 1, callee: 'circle', far: false },
        { line: line + 2, callee: 'circle', far: true },
      ]);
    });

    it("collapses a macro's edges to the statement unless two regions would read the same", () => {
      const { s } = runFluid(`
        const s = sketch("xy", () => {
          const r = rect([0, 0], 100, 50);
          const l = line([50, -10], [50, 60]);
        });
        return { s };
      `) as { s: Sketch };
      render();
      const line = s.getSourceLocation()!.line;
      const cells = s.buildRegions();
      const right = cells.find(c => c.key.startsWith("rect#1.bottom rect#1.right"))!;

      expect(writableItems(right, cells).map(item => itemRefOf(item, s))).toEqual([
        { line: line + 1, callee: 'rect', far: false },
        { line: line + 2, callee: 'line', far: true },
      ]);
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
      const line = s.getSourceLocation()!.line;
      const cells = s.buildRegions();

      expect(cells.map(cell => itemRefOf(cell.items[0], s))).toEqual([
        { line: line + 2, occurrence: 0, callee: 'circle', far: false },
        { line: line + 2, occurrence: 1, callee: 'circle', far: false },
        { line: line + 2, occurrence: 2, callee: 'circle', far: false },
      ]);
    });
  });
});
