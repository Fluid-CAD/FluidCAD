// Phase 3 of the unit system: the kernel's absolute tolerances are authored
// in millimetres and read in the document's unit (lib/units/tolerance.ts), so
// the same model built with every literal divided by 25.4 in an inch document
// must produce the same B-rep — same face count, volume scaled by 25.4³.
// A metre-scale boolean documents WHY: an unscaled 1e-4 fuzzy is 0.1 mm in a
// metre document and swallows real sub-millimetre geometry.

import { describe, it, expect, afterEach } from "vitest";
import { setupOC } from "../setup.js";
import { SceneRenderer } from "../../rendering/render.js";
import { Scene } from "../../rendering/scene.js";
import { MESH_PRESETS } from "../../oc/mesh.js";
import { getCurrentScene, getSceneManager, setCurrentFile } from "../../scene-manager.js";
import { getUnitRegistry } from "../../units/registry.js";
import { MM_PER_UNIT } from "../../units/units.js";
import type { LengthUnit } from "../../units/units.js";
import { getOC } from "../../oc/init.js";
import { ShapeProps } from "../../oc/props.js";
import { Solid } from "../../common/solid.js";
import type { Shape } from "../../common/shape.js";
import type { Extrude } from "../../features/extrude.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import revolve from "../../core/revolve.js";
import sweep from "../../core/sweep.js";
import fuse from "../../core/fuse.js";
import select from "../../core/select.js";
import { circle, line } from "../../core/2d/index.js";
import { coincident, horizontal, vertical, fix, distance } from "../../core/constraints/index.js";
import { edge } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";

const FILE = "/ws/scale-invariance.fluid.js";

// The size-aware renderer the SceneManager uses in production, not the
// fixed-deflection one the shared test setup keeps for legacy numbers.
const renderer = new SceneRenderer(MESH_PRESETS.standard);

/** Make `unit` the root document's unit for the rest of this test. */
function declareUnit(unit: LengthUnit): void {
  setCurrentFile(FILE);
  if (unit !== "mm") {
    getUnitRegistry().declare(FILE, unit);
  }
}

function renderScene(): Scene {
  const scene = getCurrentScene();
  scene.materializeLeftoverDefinitions();
  return renderer.render(scene);
}

type Measured = { volume: number; faces: number; edges: number; solids: number; meshDiagonal: number };

function measure(scene: Scene): Measured {
  const solids: Solid[] = [];
  for (const object of scene.getAllSceneObjects()) {
    for (const shape of object.getShapes()) {
      if (shape.getType() === "solid") {
        solids.push(shape as Solid);
      }
    }
  }
  expect(solids.length).toBeGreaterThan(0);
  let volume = 0;
  let faces = 0;
  let edges = 0;
  for (const solid of solids) {
    volume += ShapeProps.getProperties(solid.getShape()).volumeMm3;
    faces += solid.getFaces().length;
    edges += solid.getEdges().length;
  }
  return { volume, faces, edges, solids: solids.length, meshDiagonal: meshedDiagonal(solids) };
}

/** Diagonal of the box around every rendered face-mesh vertex (meshed, not B-rep, bounds). */
function meshedDiagonal(shapes: Shape[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    for (const mesh of shape.getMeshes() ?? []) {
      if (mesh.label !== "solid-faces") {
        continue;
      }
      for (let i = 0; i < mesh.vertices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], mesh.vertices[i + k]);
          max[k] = Math.max(max[k], mesh.vertices[i + k]);
        }
      }
    }
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/**
 * Each model takes `k`, the factor every mm literal is multiplied by to
 * express it in the document's unit (1 for mm, 1/25.4 for inches).
 */
const MODELS: Record<string, (k: number) => void> = {
  "box + fillet": (k) => {
    sketch("xy", () => {
      testRect(100 * k, 50 * k);
    });
    extrude(30 * k);
    select(edge().verticalTo("xy"));
    fillet(5 * k);
  },
  "boolean cut with a 1 mm hole": (k) => {
    sketch("xy", () => {
      testRect(100 * k, 60 * k);
    });
    extrude(20 * k);
    sketch("xy", () => {
      circle([20 * k, 20 * k], 0.5 * k);
    });
    cut(20 * k);
  },
  "revolve": (k) => {
    sketch("xz", () => {
      testRect(10 * k, 30 * k, { at: [20 * k, 0] });
    });
    revolve("z");
  },
  "sweep along a line": (k) => {
    const profile = sketch("xy", () => {
      circle([0, 0], 10 * k);
    });
    const path = sketch("xz", () => {
      vertical(line([0, 0], [0, 50 * k]));
    });
    sweep(path, profile);
  },
  // Guesses are deliberately off so the solver has to move geometry: the
  // glue / collapse floors and LM tolerances are what this one exercises.
  "solved sketch from wrong guesses": (k) => {
    sketch("xy", () => {
      const b = line([0, 0], [90 * k, 1 * k]);
      const r = line([90 * k, 1 * k], [92 * k, 40 * k]);
      const t = line([92 * k, 40 * k], [-1 * k, 41 * k]);
      const l = line([-1 * k, 41 * k], [0, 0]);
      coincident(b.end(), r.start());
      coincident(r.end(), t.start());
      coincident(t.end(), l.start());
      coincident(l.end(), b.start());
      horizontal(b);
      vertical(r);
      horizontal(t);
      vertical(l);
      fix(b.start(), [0, 0]);
      distance(b.start(), b.end(), 100 * k);
      distance(r.start(), r.end(), 50 * k);
    });
    extrude(10 * k);
  },
};

describe("scale invariance across document units", () => {
  setupOC();

  afterEach(() => {
    setCurrentFile("");
    getSceneManager().projectUnit = "mm";
  });

  for (const [name, model] of Object.entries(MODELS)) {
    it(`${name}: inches ×25.4³ ≈ millimetres, same topology`, () => {
      declareUnit("mm");
      model(1);
      const mm = measure(renderScene());

      getSceneManager().startScene();
      declareUnit("in");
      model(1 / 25.4);
      const scene = renderScene();
      for (const object of scene.getAllSceneObjects()) {
        expect(object.getUnit()).toBe("in");
        expect(object.getError()).toBeFalsy();
      }
      const inch = measure(scene);

      const f = MM_PER_UNIT.in;
      expect(inch.solids).toBe(mm.solids);
      expect(inch.faces).toBe(mm.faces);
      expect(inch.edges).toBe(mm.edges);
      expect(Math.abs(inch.volume * f * f * f - mm.volume) / mm.volume).toBeLessThan(0.005);
      expect(Math.abs(inch.meshDiagonal * f - mm.meshDiagonal) / mm.meshDiagonal).toBeLessThan(0.005);
    });
  }

  it("metre document: two blocks overlapping by 0.2 mm fuse to the exact union", () => {
    declareUnit("m");
    // 1 m × 0.5 m × 0.3 m blocks; the second starts 0.2 mm inside the first.
    sketch("xy", () => {
      testRect(1, 0.5);
    });
    const a = extrude(0.3).new();
    sketch("xy", () => {
      testRect(1, 0.5, { at: [1 - 2e-4, 0] });
    });
    const b = extrude(0.3).new();
    fuse(a, b);

    const result = measure(renderScene());
    expect(result.solids).toBe(1);
    const overlap = 2e-4 * 0.5 * 0.3;
    const expected = 2 * (1 * 0.5 * 0.3) - overlap;
    // Exact to well below the overlap volume: nothing was fuzzed away.
    expect(Math.abs(result.volume - expected)).toBeLessThan(overlap * 1e-3);
  });

  it("documents why the fuzzy scales: an unscaled 1e-4 fuzzy is 0.1 mm in metres and glues a 0.05 mm gap", () => {
    const oc = getOC();
    const gap = 5e-5;
    declareUnit("m");
    sketch("xy", () => {
      testRect(1, 0.5);
    });
    const a = extrude(0.3).new() as unknown as Extrude;
    sketch("xy", () => {
      testRect(1, 0.5, { at: [1 + gap, 0] });
    });
    const b = extrude(0.3).new() as unknown as Extrude;
    // The scene's own boolean pass (scaled fuzzy) leaves the two bodies apart.
    expect(measure(renderScene()).solids).toBe(2);
    const left = a.getShapes()[0].getShape();
    const right = b.getShapes()[0].getShape();

    const solidsAfterFuse = (fuzzy: number): number => {
      const fuser = new oc.BRepAlgoAPI_Fuse(left, right, new oc.Message_ProgressRange());
      fuser.SetFuzzyValue(fuzzy);
      fuser.Build(new oc.Message_ProgressRange());
      const explorer = new oc.TopExp_Explorer(fuser.Shape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      let count = 0;
      for (; explorer.More(); explorer.Next()) {
        count++;
      }
      explorer.delete();
      fuser.delete();
      return count;
    };

    // 1e-4 mm expressed in metres keeps the two bodies apart …
    expect(solidsAfterFuse(1e-4 / MM_PER_UNIT.m)).toBe(2);
    // … the raw mm constant, applied in metres, is 0.1 mm and merges them.
    expect(solidsAfterFuse(1e-4)).toBe(1);
  });
});
