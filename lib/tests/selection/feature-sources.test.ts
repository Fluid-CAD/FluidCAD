import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import shell from "../../core/shell.js";
import fillet from "../../core/fillet.js";
import sweep from "../../core/sweep.js";
import loft from "../../core/loft.js";
import { circle, move, rect, vLine } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { resolveFeatureSources } from "../../selection/feature-sources.js";
import type { SelectionBoundary } from "../../selection/types.js";
import { edgeRefsWhere, faceRefsWhere, setLocation } from "./pick-helpers.js";

/** The solid added by the scene's only object of `type`. */
function solidOf(scene: Scene, type: string): Shape {
  const objects = scene.getAllSceneObjects().filter(o => o.getType() === type);
  expect(objects).toHaveLength(1);
  const solids = objects[0].getAddedShapes().filter(s => s.getType() === "solid");
  expect(solids.length).toBeGreaterThan(0);
  return solids[0];
}

/** Boundary addressing the scene's only object of `type` (its set line). */
function boundaryFor(scene: Scene, type: string, line: number): SelectionBoundary {
  const index = scene.getAllSceneObjects().findIndex(o => o.getType() === type);
  expect(index).toBeGreaterThanOrEqual(0);
  return { index, type, line, column: 0 };
}

describe("feature sources (edit-dialog seeding)", () => {
  setupOC();

  it("resolves shell faces onto the pre-shell solid", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const e = extrude(50) as Extrude;
    setLocation(e, 4);
    const sh = shell(-2, e.endFaces());
    setLocation(sh, 6);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "shell", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "shell") {
      const topFace = faceRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6);
      expect(result.selection).toEqual({ kind: "entities", entities: topFace });
    }
  });

  it("keeps fillet face inputs as faces (no pre-explosion)", () => {
    sketch("xy", () => {
      rect(80, 60);
    });
    const e = extrude(30) as Extrude;
    setLocation(e, 4);
    const f = fillet(3, e.endFaces());
    setLocation(f, 6);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "fillet", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "fillet") {
      expect(result.selection.kind).toBe("entities");
      if (result.selection.kind === "entities") {
        expect(result.selection.entities).toHaveLength(1);
        expect(result.selection.entities[0].sub.type).toBe("face");
        expect(result.selection.entities[0].shapeId).toBe(box.id);
      }
    }
  });

  it("resolves an extrude profile to its sketch call site, implicit included", () => {
    const s = sketch("xy", () => {
      rect(40, 40);
    });
    setLocation(s, 2);
    const e = extrude(25);
    setLocation(e, 4);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "extrude", 4));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "extrude") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 });
    }
  });

  it("reports a to-face cut's argument slot as opaque", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const e = extrude(50) as Extrude;
    setLocation(e, 4);
    const s2 = sketch(e.endFaces(), () => {
      move([50, 50]);
      circle(40);
    });
    setLocation(s2, 6);
    const c = cut("first-face");
    setLocation(c, 9);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "cut", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "cut") {
      expect(result.profile).toEqual({ kind: "opaque" });
    }
  });

  it("resolves loft profiles in order: picked face entities and sketch refs", () => {
    sketch("xy", () => {
      rect(60, 40);
    });
    const e = extrude(20) as Extrude;
    setLocation(e, 4);
    const s2 = sketch(plane("xy", { offset: 50 }), () => {
      rect(30, 20);
    });
    setLocation(s2, 6);
    const l = loft(e.endFaces(), s2);
    setLocation(l, 9);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "loft", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "loft") {
      const topFace = faceRefsWhere(box, m => Math.abs(m.z - 20) < 1e-6);
      expect(result.profiles).toEqual([
        { kind: "entities", entities: topFace },
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 },
      ]);
      expect(result.guides).toEqual([]);
    }
  });

  it("resolves loft guides and marks same-line (inline) sketches opaque", () => {
    const s1 = sketch("xy", () => {
      circle(80);
    });
    setLocation(s1, 2);
    const s2 = sketch(plane("xy", { offset: 60 }), () => {
      circle(80);
    });
    setLocation(s2, 5);
    const guide = sketch("xz", () => {
      move([40, 0]);
      vLine(60);
    });
    // Same line as the loft — reads as an inline argument, not a statement.
    setLocation(guide, 9);
    const l = loft(s1, s2).guides(guide);
    setLocation(l, 9);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "loft", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "loft") {
      expect(result.profiles).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 5, column: 0 },
      ]);
      expect(result.guides).toEqual([{ kind: "opaque" }]);
    }
  });

  it("marks a shared-call-site sketch profile opaque", () => {
    const s1 = sketch("xy", () => {
      circle(40);
    });
    setLocation(s1, 3);
    const s2 = sketch(plane("xy", { offset: 30 }), () => {
      circle(40);
    });
    // Same call site as s1 — a loop body; binding one variable would lie.
    setLocation(s2, 3);
    const l = loft(s1, s2);
    setLocation(l, 6);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "loft", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "loft") {
      expect(result.profiles).toEqual([{ kind: "opaque" }, { kind: "opaque" }]);
    }
  });

  it("resolves a picked-edge sweep path onto the pre-sweep solid", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(40) as Extrude;
    setLocation(e, 4);
    const s = sketch("xy", () => {
      circle(6);
    });
    setLocation(s, 6);
    const sw = sweep(e.sideEdges(0), s).new();
    setLocation(sw, 8);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "sweep", 8));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "sweep") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 });
      expect(result.path.kind).toBe("entities");
      if (result.path.kind === "entities") {
        expect(result.path.entities).toHaveLength(1);
        expect(result.path.entities[0].shapeId).toBe(box.id);
        expect(result.path.entities[0].sub.type).toBe("edge");
        const verticalEdges = edgeRefsWhere(box, m => Math.abs(m.z - 20) < 1e-6);
        expect(verticalEdges.map(r => r.sub.index)).toContain(result.path.entities[0].sub.index);
      }
    }
  });

  it("refuses a stale boundary", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(25);
    setLocation(e, 4);

    const scene = render();
    const boundary = boundaryFor(scene, "extrude", 4);
    const result = resolveFeatureSources(scene, { ...boundary, line: 7 });
    expect(result.ok).toBe(false);
  });
});
