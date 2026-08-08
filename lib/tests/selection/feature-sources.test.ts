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
import revolve from "../../core/revolve.js";
import axis from "../../core/axis.js";
import helix from "../../core/helix.js";
import chamfer from "../../core/chamfer.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import rotate from "../../core/rotate.js";
import rib from "../../core/rib.js";
import { circle, hLine, move, offset, project, rect, vLine } from "../../core/2d/index.js";
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

/**
 * Boundary addressing the plane statement at `line`. Planes need their own
 * lookup: every `sketch('xy', …)` puts an unlocated plane object in the scene
 * too, and all three plane forms report the same type, so the line is what
 * tells the statement apart.
 */
function planeBoundary(scene: Scene, line: number): SelectionBoundary {
  const index = scene.getAllSceneObjects()
    .findIndex(o => o.getType() === "plane" && o.getSourceLocation()?.line === line);
  expect(index).toBeGreaterThanOrEqual(0);
  return { index, type: "plane", line, column: 0 };
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

  it("resolves a face offset's target faces onto the pre-offset solid", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const e = extrude(50) as Extrude;
    setLocation(e, 4);
    const off = offset(-5, e.endFaces());
    setLocation(off as any, 6);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "offset", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "offset") {
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

  it("resolves a to-face cut's profile, with an opaque target for a face literal", () => {
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
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 });
      // 'first-face' resolves at build time — there is no picked face to seed.
      expect(result.toFace).toEqual({ kind: "opaque" });
    }
  });

  it("resolves a to-face extrude's picked target as entities", () => {
    sketch("xy", () => {
      move([200, 0]);
      rect(100, 50);
    });
    const e = extrude(50) as Extrude;
    setLocation(e, 4);
    const s2 = sketch("xy", () => {
      circle(30);
    });
    setLocation(s2, 6);
    const t = extrude(e.endFaces(), s2);
    setLocation(t, 9);

    const scene = render();
    const objects = scene.getAllSceneObjects();
    // Both extrudes share the type 'extrude' — address the statements by line.
    const box = objects.find(o => o.getSourceLocation()?.line === 4)!
      .getAddedShapes().filter(s => s.getType() === "solid")[0];
    const index = objects.findIndex(o => o.getSourceLocation()?.line === 9);
    expect(index).toBeGreaterThanOrEqual(0);
    const result = resolveFeatureSources(scene, { index, type: "extrude", line: 9, column: 0 });

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "extrude") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 });
      const topFace = faceRefsWhere(box, m => Math.abs(m.z - 50) < 1e-6);
      expect(result.toFace).toEqual({ kind: "entities", entities: topFace });
    }
  });

  it("resolves a rib's spine sketch and scope statements by call site", () => {
    sketch("top", () => {
      rect(100, 50).centered();
    });
    const box = extrude(30);
    const sh = shell(-4, box.endFaces());
    setLocation(sh, 4);
    const sp = sketch("front", () => {
      move([-20, 15]);
      hLine(40);
    });
    setLocation(sp, 6);
    const r = rib(5, sp).extend().scope(sh);
    setLocation(r, 9);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "rib", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "rib") {
      expect(result.spine).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 });
      expect(result.scope).toEqual([{ kind: "sketch", filePath: "/ws/model.fluid.js", line: 4, column: 0 }]);
    }
  });

  it("reports an empty scope for a whole-scene rib", () => {
    sketch("top", () => {
      rect(100, 50).centered();
    });
    const box = extrude(30);
    shell(-4, box.endFaces());
    const sp = sketch("front", () => {
      move([-20, 15]);
      hLine(40);
    });
    setLocation(sp, 6);
    const r = rib(5);
    setLocation(r, 9);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "rib", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "rib") {
      expect(result.spine).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 6, column: 0 });
      expect(result.scope).toEqual([]);
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

  it("resolves a projection's sources onto the pre-statement solid", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30) as Extrude;
    setLocation(e, 4);
    sketch("xz", () => {
      rect(20, 10);
      const p = project(e.endFaces());
      setLocation(p as any, 8);
    });

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, boundaryFor(scene, "projection", 8));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "projection") {
      expect(result.selection.kind).toBe("entities");
      if (result.selection.kind === "entities") {
        const endFaces = faceRefsWhere(box, m => Math.abs(m.z) < 1e-6 || Math.abs(m.z - 30) < 1e-6);
        expect(result.selection.entities.length).toBeGreaterThan(0);
        for (const ref of result.selection.entities) {
          expect(ref.shapeId).toBe(box.id);
          expect(ref.sub.type).toBe("face");
          expect(endFaces.map(r => r.sub.index)).toContain(ref.sub.index);
        }
      }
    }
  });

  it("resolves a helix sweep path and a helix loft guide to their call sites", () => {
    const spring = helix("z").radius(30).pitch(10).turns(3);
    setLocation(spring, 2);
    const s = sketch("xy", () => {
      circle(2);
    });
    setLocation(s, 4);
    const sw = sweep(spring, s).new();
    setLocation(sw, 7);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "sweep", 7));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "sweep") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 4, column: 0 });
      expect(result.path).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 });
    }
  });

  it("resolves a revolve's profile and axis-statement call sites", () => {
    const s = sketch("xz", () => {
      move([80, 0]);
      circle(20);
    });
    setLocation(s, 2);
    // Offset along x keeps the axis inside the xz sketch plane.
    const a = axis("z", { offsetX: -10 });
    setLocation(a, 5);
    const r = revolve(a);
    setLocation(r, 7);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "revolve", 7));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "revolve") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 });
      expect(result.axis).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 5, column: 0 });
    }
  });

  it("marks an inline revolve axis opaque", () => {
    const s = sketch("xz", () => {
      move([80, 0]);
      circle(20);
    });
    setLocation(s, 2);
    // revolve('z'): the AxisObject is created inside the revolve call, so it
    // captures the revolve's own line — no standalone statement to re-target.
    const r = revolve("z", 180);
    setLocation(r, 5);
    const scene = render();
    for (const obj of scene.getAllSceneObjects()) {
      if (obj.getType() === "axis") {
        setLocation(obj, 5);
      }
    }

    const result = resolveFeatureSources(scene, boundaryFor(scene, "revolve", 5));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "revolve") {
      expect(result.profile).toEqual({ kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 });
      expect(result.axis).toEqual({ kind: "opaque" });
    }
  });

  /**
   * A repeat that names no targets replays whatever came before it, so its
   * edit dialog has no argument text to seed the Features slot with — the
   * feature it consumes has to come from here, or the slot opens empty over a
   * statement that plainly repeats something.
   */
  it("resolves an implicit repeat's target by call site", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 4);
    const r = repeat("linear", "x", { count: 3, offset: 60 });
    setLocation(r as never, 6);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "repeat-linear", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "repeat") {
      expect(result.targets).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 4, column: 0 },
      ]);
      // A world-axis literal builds no statement to point at.
      expect(result.axes).toEqual([{ kind: "opaque" }]);
    }
  });

  it("resolves a repeat's axis statement and its named targets", () => {
    const a = axis("y");
    setLocation(a as never, 2);
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 5);
    const f = chamfer(2, (e as never as { endEdges: () => unknown }).endEdges() as never);
    setLocation(f as never, 7);
    const r = repeat("circular", a as never, { count: 4, angle: 360 }, f as never);
    setLocation(r as never, 9);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "repeat-circular", 9));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "repeat") {
      expect(result.targets).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 7, column: 0 },
      ]);
      expect(result.axes).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
      ]);
    }
  });

  /**
   * The copy's keep chips, which only its ghost reads: the apply rewrites a
   * kept axis verbatim by position, so this is what tells the preview WHICH
   * axis that text names.
   */
  it("resolves a copy's axis statement and its named targets", () => {
    const a = axis("y");
    setLocation(a as never, 2);
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 5);
    const c = copy("circular", a as never, { count: 4, angle: 360 }, e as never);
    setLocation(c as never, 7);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "copy-circular", 7));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "copy") {
      expect(result.targets).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 5, column: 0 },
      ]);
      expect(result.axes).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
      ]);
    }
  });

  /**
   * An implicit copy names no targets at all — it clones every active solid —
   * and reports the empty list that says so. Its world-axis literals build no
   * statement to point at, one per direction.
   */
  it("resolves an implicit two-direction copy's axes, targets and all", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 4);
    const c = copy("linear", ["x", "y"] as never, { count: [2, 2], offset: [60, 60] });
    setLocation(c as never, 6);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "copy-linear", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "copy") {
      expect(result.targets).toEqual([]);
      expect(result.axes).toEqual([{ kind: "opaque" }, { kind: "opaque" }]);
    }
  });

  /** A mirror written from the dialog's face mode resolves to that face. */
  it("resolves a mirror plane picked as a face", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 4);
    const r = repeat("mirror", e.endFaces() as never);
    setLocation(r as never, 6);

    const scene = render();
    // The mirror cloned the extrude, so the scene holds two of them; the
    // pre-statement solid the picks resolve against is the original's.
    const original = scene.getAllSceneObjects()
      .find(o => o.getType() === "extrude" && !o.getCloneSource())!;
    const box = original.getAddedShapes().filter(s => s.getType() === "solid")[0];
    const result = resolveFeatureSources(scene, boundaryFor(scene, "mirror", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "repeat") {
      expect(result.plane).toEqual({
        kind: "entities",
        entities: faceRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6),
      });
    }
  });

  it("resolves a rotate's targets and axis statement by call site", () => {
    const a = axis("z");
    setLocation(a as never, 2);
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10);
    setLocation(e, 4);
    const r = rotate(a as never, 45, e as never);
    setLocation(r as never, 6);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "rotate", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "rotate") {
      expect(result.targets).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 4, column: 0 },
      ]);
      expect(result.axis).toEqual(
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
      );
    }
  });

  it("marks a rotate's inline world-axis literal opaque", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10);
    setLocation(e, 4);
    const r = rotate("z", 45, e as never);
    setLocation(r as never, 6);

    const scene = render();
    const result = resolveFeatureSources(scene, boundaryFor(scene, "rotate", 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "rotate") {
      expect(result.axis).toEqual({ kind: "opaque" });
    }
  });

  it("resolves a plane's picked-face base onto the pre-plane solid", () => {
    sketch("xy", () => {
      rect(40, 40);
    });
    const e = extrude(10) as Extrude;
    setLocation(e, 4);
    const p = plane(e.endFaces() as never, 8);
    setLocation(p as never, 6);

    const scene = render();
    const box = solidOf(scene, "extrude");
    const result = resolveFeatureSources(scene, planeBoundary(scene, 6));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "plane") {
      expect(result.bases).toEqual([{
        kind: "entities",
        entities: faceRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6),
      }]);
    }
  });

  it("resolves a mid plane's two bases in argument order", () => {
    const first = plane("xy", 10);
    setLocation(first as never, 2);
    const second = plane("xy", 40);
    setLocation(second as never, 3);
    const mid = plane(first as never, second as never);
    setLocation(mid as never, 4);

    const scene = render();
    const result = resolveFeatureSources(scene, planeBoundary(scene, 4));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "plane") {
      expect(result.bases).toEqual([
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 2, column: 0 },
        { kind: "sketch", filePath: "/ws/model.fluid.js", line: 3, column: 0 },
      ]);
    }
  });

  it("marks an origin-plane literal's base opaque", () => {
    const p = plane("xz", 12);
    setLocation(p as never, 3);

    const scene = render();
    const result = resolveFeatureSources(scene, planeBoundary(scene, 3));

    expect(result.ok).toBe(true);
    if (result.ok && result.feature === "plane") {
      expect(result.bases).toEqual([{ kind: "opaque" }]);
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
