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
import { Shape } from "../../common/shape.js";
import { Producers } from "../../selection/producers.js";
import { buildFeatureGhost, type FeatureGhostResult } from "../../rendering/feature-ghost.js";
import type { Scene } from "../../rendering/scene.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { Primitives } from "../../sdk/kernel.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Point } from "../../math/point.js";
import { TestCurves } from "../helpers/curves.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { chord, patch } from "../helpers/result-fixtures.js";
import { setLocation } from "./pick-helpers.js";

const FILE = "/ws/model.fluid.js";

/** How many edges the `trace` feature read off its path in its last preview. */
let traced = 0;

/** `trace(path)`: a custom feature whose one value takes a sketch or any other wire source. */
class Trace extends Feature.with({
  path: { picker: "sketch", wire: true },
}) {
  static id = "acme.trace";

  buildTool(): Shape[] {
    traced = this.edgesOf(this.values.path).length;
    return [Primitives.makeCylinder(1, 1)];
  }
}
const trace = defineFeature(Trace, { label: "Trace", group: "create", call: ["path"] });

/** The preview of `trace` over the statement at `line`. */
function tracePreview(scene: Scene, line: number): FeatureGhostResult {
  traced = 0;
  return buildFeatureGhost(scene, {
    feature: "custom",
    builder: trace,
    values: {},
    refs: { path: [{ kind: "statement", filePath: FILE, line }] },
    operation: null,
  }, DEFAULT_MESH_CONFIG);
}

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

  describe("ofStatement", () => {
    it("answers what the statement at a call site left: a curve, a surface, or neither", () => {
      const s = sketch("xy", () => {
        line([0, 0], [10, 0]);
      });
      setLocation(s, 2);
      const coil = helix("z").radius(10).pitch(5).turns(2);
      setLocation(coil, 3);
      const curve = loadShapes([EdgeOps.makeLineEdge(new Point(0, 0, 50), new Point(10, 0, 50))]);
      setLocation(curve, 4);
      const surface = loadShapes([TestSheets.plate(10, 10)]);
      setLocation(surface, 5);
      const box = block();
      setLocation(box, 9);
      const scene = render();

      expect(Producers.ofStatement(scene, { filePath: FILE, line: 2 })).toEqual({ curve: true, surface: false });
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 3 })).toEqual({ curve: true, surface: false });
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 4 })).toEqual({ curve: true, surface: false });
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 5 })).toEqual({ curve: false, surface: true });
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 9 })).toEqual({ curve: false, surface: false });
    });

    it("answers null where the scene built nothing, and narrows a line by its column", () => {
      const coil = helix("z").radius(10).pitch(5).turns(2);
      setLocation(coil, 3);
      const scene = render();

      expect(Producers.ofStatement(scene, { filePath: FILE, line: 40 })).toBeNull();
      expect(Producers.ofStatement(scene, { filePath: "/ws/other.fluid.js", line: 3 })).toBeNull();
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 3, column: 0 })).toEqual({ curve: true, surface: false });
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 3, column: 7 })).toBeNull();
    });

    it("still answers a curve for a statement whose curve a sweep took", () => {
      const spine = loadShapes([EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(0, 0, 30))]);
      setLocation(spine, 2);
      const profile = sketch("xy", () => {
        circle([0, 0], 2);
      });
      setLocation(profile, 4);
      const swept = asObject(sweep(spine, profile));
      const scene = render();

      expect(swept.getError()).toBeNull();
      expect(Producers.isCurveProducer(asObject(spine))).toBe(false);
      expect(Producers.ofStatement(scene, { filePath: FILE, line: 2 })).toEqual({ curve: true, surface: false });
    });
  });

  describe("a custom feature's wire value, in its preview", () => {
    it("takes a sketch, a helix and a curve tool's result by their statement", () => {
      const s = sketch("xy", () => {
        line([0, 0], [10, 0]);
        line([10, 0], [10, 10]);
      });
      setLocation(s, 2);
      const coil = helix("z").radius(10).pitch(5).turns(2);
      setLocation(coil, 3);
      const c = chord([0, 0, 0], [10, 0, 0]);
      setLocation(c, 4);
      const scene = render();

      expect(tracePreview(scene, 2).ok).toBe(true);
      expect(traced).toBe(2);
      expect(tracePreview(scene, 3).ok).toBe(true);
      expect(traced).toBe(1);
      expect(tracePreview(scene, 4).ok).toBe(true);
      expect(traced).toBe(1);
    });

    it("does not take a solid's statement for a wire", () => {
      const box = block();
      setLocation(box, 5);
      const scene = render();

      expect(tracePreview(scene, 5).ok).toBe(false);
      expect(traced).toBe(0);
    });
  });

  describe("a sweep's path, in its preview", () => {
    /** The preview of a Ø4 circle on XY at line 5 swept along the statement at `line`. */
    function sweepPreview(scene: Scene, line: number): FeatureGhostResult {
      return buildFeatureGhost(scene, {
        feature: "sweep",
        op: "add",
        thin: null,
        profile: { filePath: FILE, line: 5 },
        path: { kind: "wire", filePath: FILE, line },
      }, DEFAULT_MESH_CONFIG);
    }

    /** The z extent of the preview's first body. */
    function height(result: FeatureGhostResult): number {
      if ("reason" in result) {
        throw new Error(`the preview refused: ${result.reason}`);
      }
      const zs = result.solids[0].meshes.flatMap(mesh => mesh.vertices.filter((_, i) => i % 3 === 2));
      return Math.max(...zs) - Math.min(...zs);
    }

    it("runs along a curve tool's result, a wire, named by its statement", () => {
      const spine = chord([0, 0, 0], [0, 0, 30]);
      setLocation(spine, 3);
      const profile = sketch("xy", () => {
        circle([0, 0], 4);
      });
      setLocation(profile, 5);
      const scene = render();

      expect(height(sweepPreview(scene, 3))).toBeCloseTo(30, 3);
    });

    it("runs along a curve the edited sweep itself consumed", () => {
      const coil = helix("z").radius(10).pitch(5).turns(2);
      setLocation(coil, 3);
      const profile = sketch("xz", () => {
        circle([10, 0], 2);
      });
      setLocation(profile, 5);
      const swept = asObject(sweep(coil, profile));
      const scene = render();

      expect(swept.getError()).toBeNull();
      expect(height(sweepPreview(scene, 3))).toBeGreaterThan(10);
    });

    it("does not take a solid's statement for a path", () => {
      const box = block();
      setLocation(box, 3);
      const profile = sketch("xy", () => {
        circle([0, 0], 4);
      });
      setLocation(profile, 5);
      const scene = render();

      expect(sweepPreview(scene, 3).ok).toBe(false);
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
