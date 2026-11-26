import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import helix from "../../core/helix.js";
import sweep from "../../core/sweep.js";
import axis from "../../core/axis.js";
import repeat from "../../core/repeat.js";
import { circle, line, point } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Extrude } from "../../features/extrude.js";
import { Producers } from "../../selection/producers.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { TestCurves } from "../helpers/curves.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { chord, patch } from "../helpers/result-fixtures.js";

const asObject = (value: unknown) => value as SceneObject;

/** A 20 × 10 × 5 block on XY from the origin. */
function block(): Extrude {
  sketch("xy", () => {
    testRect(20, 10);
  });
  return extrude(5) as unknown as Extrude;
}

describe("Producers", () => {
  setupOC();
  useLoadedBodies();

  describe("isCurveProducer", () => {
    it("is true of a helix", () => {
      const coil = asObject(helix("z").radius(10).pitch(5).turns(2));
      render();

      expect(Producers.isCurveProducer(coil)).toBe(true);
    });

    it("is true of an imported curve, a wire or a bare edge", () => {
      const curves = asObject(loadShapes([
        TestCurves.threeEdges(),
        EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50)),
      ]));
      render();

      expect(Producers.isCurveProducer(curves)).toBe(true);
    });

    it("is true of a curve tool's result, and of a repeat of one", () => {
      const path = asObject(sketch("xy", () => {
        line([0, 0], [10, 0]);
      }));
      const c = chord([0, 0, 0], [1, 0, 0]).along(path);
      const r = asObject(repeat("linear", "y", { count: 2, offset: 30 }, c));
      render();

      expect(Producers.isCurveProducer(c)).toBe(true);
      expect(Producers.isCurveProducer(r)).toBe(true);
    });

    it("is true of a sketch, points and all, and false of the entities inside it", () => {
      let drawn: SceneObject = null!;
      let dot: SceneObject = null!;
      const s = asObject(sketch("xy", () => {
        drawn = asObject(line([0, 0], [10, 0]));
        dot = asObject(point([5, 5]));
      }));
      render();

      expect(Producers.isCurveProducer(s)).toBe(true);
      expect(Producers.isCurveProducer(drawn)).toBe(false);
      expect(Producers.isCurveProducer(dot)).toBe(false);
    });

    it("is false of a sketch that holds no edge", () => {
      const s = asObject(sketch("xy", () => {
        point([5, 5]);
      }));
      render();

      expect(Producers.isCurveProducer(s)).toBe(false);
    });

    it("is false of a selection of edges and of a lazy accessor, which name another object's edges", () => {
      const box = block();
      const picked = asObject(select(edge().verticalTo("xy")));
      const lazy = asObject(box.sideEdges());
      render();

      expect(picked.getShapes().length).toBe(4);
      expect(Producers.isCurveProducer(picked)).toBe(false);
      expect(Producers.isCurveProducer(lazy)).toBe(false);
    });

    it("is false of a solid, a surface, a datum, and an object holding a curve beside a body", () => {
      const box = asObject(block());
      const surface = asObject(loadShapes([TestSheets.plate(10, 10)]));
      const mixed = asObject(loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]));
      const datum = asObject(axis("z"));
      render();

      expect(Producers.isCurveProducer(box)).toBe(false);
      expect(Producers.isCurveProducer(surface)).toBe(false);
      expect(Producers.isCurveProducer(mixed)).toBe(false);
      expect(Producers.isCurveProducer(datum)).toBe(false);
    });

    it("reads a curve its consumer took as that consumer's own arguments saw it, given the objects before it", () => {
      const coil = asObject(helix("z").radius(10).pitch(5).turns(2));
      const profile = asObject(sketch("xz", () => {
        circle([10, 0], 2);
      }));
      const swept = asObject(sweep(coil, profile));
      const scene = render();

      expect(swept.getError()).toBeNull();
      const all = scene.getAllSceneObjects();
      const before = new Set(all.slice(0, all.indexOf(swept)));
      expect(Producers.isCurveProducer(coil, before)).toBe(true);
      // To the finished scene the sweep took the curve: nothing after it can read it.
      expect(Producers.isCurveProducer(coil, new Set(all))).toBe(false);
    });
  });

  describe("holdsSurface", () => {
    it("is true of an imported surface, alone or beside a solid or a curve", () => {
      const surface = asObject(loadShapes([TestSheets.plate(10, 10)]));
      const mixed = asObject(loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]));
      render();

      expect(Producers.holdsSurface(surface)).toBe(true);
      expect(Producers.holdsSurface(mixed)).toBe(true);
    });

    it("is true of a surface tool's result, and of a repeat of one", () => {
      const boundary = asObject(sketch("xy", () => {
        testRect(20, 10);
      }));
      const p = patch(boundary);
      const r = asObject(repeat("linear", "x", { count: 2, offset: 50 }, p));
      render();

      expect(Producers.holdsSurface(p)).toBe(true);
      expect(Producers.holdsSurface(r)).toBe(true);
      expect(Producers.isCurveProducer(p)).toBe(false);
    });

    it("is false of a solid, a curve, a sketch, and a selection of a surface's faces", () => {
      const box = asObject(block());
      const coil = asObject(helix("z").radius(10).pitch(5).turns(2));
      const s = asObject(sketch("xy", () => {
        line([40, 0], [50, 0]);
      }));
      const surface = asObject(loadShapes([TestSheets.plate(10, 10)]));
      const faces = asObject(select(face().ofSurface()));
      render();

      expect(faces.getShapes().length).toBe(1);
      expect(Producers.holdsSurface(surface)).toBe(true);
      expect(Producers.holdsSurface(box)).toBe(false);
      expect(Producers.holdsSurface(coil)).toBe(false);
      expect(Producers.holdsSurface(s)).toBe(false);
      expect(Producers.holdsSurface(faces)).toBe(false);
    });
  });
});
