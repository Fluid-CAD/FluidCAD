// rect() macro shape (fluidcad/shapes, P8): ONE statement registering 4
// lines (+4 corner arcs with .radius()) plus INTERNAL constraint rows —
// an atomic self-constrained unit whose args are exactly its DOF.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line } from "../../../core/2d/index.js";
import { rect } from "../../../core/shapes/index.js";
import {
  coincident, horizontal, vertical, fix, distance, radius,
} from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { Scene } from "../../../rendering/scene.js";
import { SceneObject } from "../../../common/scene-object.js";
import { getBoundingBoxOfShapes } from "../../utils.js";
import type { IRect } from "../../../core/interfaces.js";

function renderedByUniqueType(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

function macroPayload(scene: Scene) {
  return renderedByUniqueType(scene, 'macro-rect')[0];
}

function sketchSolver(scene: Scene, s: Sketch) {
  return scene.getRenderedObject(s as unknown as SceneObject).object.solver;
}

function entityParams(payload: any, slot: string): number[] {
  const entity = payload.entities.find((e: any) => e.slot === slot);
  expect(entity, `entity '${slot}'`).toBeTruthy();
  return entity.params;
}

describe("rect() macro shape", () => {
  setupOC();

  it("registers 4 lines + internal rows only, at exactly 4 DOF, and extrudes", () => {
    const s = sketch('xy', () => {
      rect([0, 0], 40, 25);
    }) as unknown as Sketch;
    const e = extrude(10) as ExtrudeBase;
    const scene = render();

    const row = macroPayload(scene);
    expect(row.hasError).toBe(false);
    expect(row.object.macro.shape).toBe('rect');
    expect(row.object.macro.centered).toBe(false);
    expect(row.object.macro.radius).toBeNull();
    expect(row.object.entities).toHaveLength(4);
    // (sceneShapes are empty here — the extrude consumes the profile edges,
    // like any sketch feeding a 3D feature.)

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.dof).toBe(4);
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    // 4 statement entities, all lines; no user constraint records — the
    // shape rules are internal (4 coincident + 2 H + 2 V).
    expect(solver.entities.filter((en: any) => en.id >= 0)).toHaveLength(4);
    expect(solver.constraints.filter((c: any) => !c.internal)).toHaveLength(0);
    expect(solver.constraints.filter((c: any) => c.internal)).toHaveLength(8);
    // All four entities stay free to move (bare rect = blue).
    expect(solver.underconstrainedEntities).toHaveLength(4);

    const solid = e.getShapes()[0] as Solid;
    const bbox = getBoundingBoxOfShapes([solid]);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(40, 4);
    expect(bbox.maxY - bbox.minY).toBeCloseTo(25, 4);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(10, 4);
  });

  it("external fix + dims drive it to 0 DOF with exact geometry", () => {
    // Guesses deliberately off the dimensioned values.
    const s = sketch('xy', () => {
      const r = rect([1, 2], 38, 22);
      fix(r.bottom().start(), [0, 0]);
      distance(r.bottom().start(), r.bottom().end(), 50);
      distance(r.right().start(), r.right().end(), 30);
    }) as unknown as Sketch;
    const scene = render();

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.dof).toBe(0);
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.underconstrainedEntities).toEqual([]);

    const payload = macroPayload(scene).object;
    const bottom = entityParams(payload, 'bottom');
    expect(bottom[0]).toBeCloseTo(0, 6);
    expect(bottom[1]).toBeCloseTo(0, 6);
    expect(bottom[2]).toBeCloseTo(50, 6);
    expect(bottom[3]).toBeCloseTo(0, 6);
    const top = entityParams(payload, 'top');
    expect(top[0]).toBeCloseTo(50, 6);
    expect(top[1]).toBeCloseTo(30, 6);
  });

  it("omitting height draws a square", () => {
    sketch('xy', () => {
      rect([5, 5], 30);
    });
    const scene = render();

    const payload = macroPayload(scene).object;
    expect(payload.macro.guess.width).toBe(30);
    expect(payload.macro.guess.height).toBe(30);
    const right = entityParams(payload, 'right');
    expect(right).toEqual([35, 5, 35, 35]);
  });

  it(".centered() reinterprets pos as the center", () => {
    sketch('xy', () => {
      rect([0, 0], 40, 20).centered();
    });
    const scene = render();

    const payload = macroPayload(scene).object;
    expect(payload.macro.centered).toBe(true);
    const bottom = entityParams(payload, 'bottom');
    expect(bottom).toEqual([-20, -10, 20, -10]);
    const top = entityParams(payload, 'top');
    expect(top).toEqual([20, 10, -20, 10]);
  });

  it(".radius(r) rounds corners at 5 DOF and dims solve it exactly", () => {
    // Guesses off the dims again: pos [1,1], size 40×25, r 5 — dims say
    // 50×30, r 6, bottom-left corner start at (6, 0).
    const s = sketch('xy', () => {
      const r = rect([1, 1], 40, 25).radius(5);
      fix(r.bottom().start(), [6, 0]);
      distance(r.left(), r.right(), 50);
      distance(r.bottom(), r.top(), 30);
      radius(r.corner(0), 6);
    }) as unknown as Sketch;
    const scene = render();

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.dof).toBe(0);
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);

    const payload = macroPayload(scene).object;
    expect(payload.entities).toHaveLength(8);
    // right line runs the full height minus the corner take-up.
    const right = entityParams(payload, 'right');
    expect(right[0]).toBeCloseTo(50, 5);
    expect(right[1]).toBeCloseTo(6, 5);
    expect(right[2]).toBeCloseTo(50, 5);
    expect(right[3]).toBeCloseTo(24, 5);
    // corner2 (top-right): center inset by the solved radius, r = 6.
    const corner2 = entityParams(payload, 'corner2');
    expect(corner2[0]).toBeCloseTo(44, 5);
    expect(corner2[1]).toBeCloseTo(24, 5);
    expect(corner2[2]).toBeCloseTo(6, 5);
  });

  it("bare rounded rect keeps exactly 5 DOF with a clean verdict", () => {
    const s = sketch('xy', () => {
      rect([0, 0], 40, 25).radius(6);
    }) as unknown as Sketch;
    const scene = render();

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.dof).toBe(5);
    expect(solver.redundant).toEqual([]);
    expect(solver.conflicting).toEqual([]);
    // 8 entities; internal records: 8 coincident + 4 H/V + 8 tangent +
    // 1 equal + 4 arc-consistency.
    expect(solver.entities.filter((en: any) => en.id >= 0)).toHaveLength(8);
    expect(solver.constraints.filter((c: any) => c.internal)).toHaveLength(25);
    expect(solver.constraints.filter((c: any) => !c.internal)).toHaveLength(0);
  });

  it("a duplicate external horizontal is named redundant — never the macro's internal row", () => {
    const s = sketch('xy', () => {
      const r = rect([0, 0], 40, 25);
      horizontal(r.top());
    }) as unknown as Sketch;
    const scene = render();

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.dof).toBe(4);
    const userIds = solver.constraints.filter((c: any) => !c.internal).map((c: any) => c.id);
    expect(userIds).toHaveLength(1);
    expect(solver.redundant).toEqual(userIds);
  });

  it("a contradicting external constraint surfaces as a conflict on the user statement", () => {
    sketch('xy', () => {
      const r = rect([0, 0], 40, 25);
      fix(r.bottom().start(), [0, 0]);
      vertical(r.bottom());
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-vertical')[0];
    expect(row.hasError).toBe(true);
    // Geometry still renders least-bad.
    expect(macroPayload(scene).sceneShapes.length).toBeGreaterThan(0);
  });

  it("other geometry constrains against macro accessors", () => {
    const s = sketch('xy', () => {
      const r = rect([0, 0], 40, 25);
      const l = line([60, 5], [80, 5]);
      coincident(l.start(), r.bottom().end());
    }) as unknown as Sketch;
    const scene = render();

    const solver = sketchSolver(scene, s);
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);

    const linePayload = renderedByUniqueType(scene, 'solved-line')[0].object;
    const bottom = entityParams(macroPayload(scene).object, 'bottom');
    expect(linePayload.start.x).toBeCloseTo(bottom[2], 6);
    expect(linePayload.start.y).toBeCloseTo(bottom[3], 6);
  });

  it("corner() on a plain rect errors on the referencing statement, not the sketch", () => {
    sketch('xy', () => {
      const r = rect([0, 0], 40, 25);
      radius(r.corner(0), 5);
    });
    const scene = render();

    const dim = renderedByUniqueType(scene, 'constraint-radius')[0];
    expect(dim.hasError).toBe(true);
    expect(dim.errorMessage).toContain('no rounded corners');
    expect(macroPayload(scene).hasError).toBe(false);
  });

  it("a radius that does not fit errors the rect row and skips its geometry", () => {
    sketch('xy', () => {
      rect([0, 0], 40, 10).radius(8);
    });
    const scene = render();

    const row = macroPayload(scene);
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('does not fit');
  });

  it("modifiers after the sketch callback closes throw", () => {
    let r: IRect | null = null;
    sketch('xy', () => {
      r = rect([0, 0], 40, 25);
    });
    expect(() => r.radius(4)).toThrow(/sketch has closed/);
    expect(() => r.centered()).toThrow(/sketch has closed/);
  });

  it("outside a sketch it errors like the primitives", () => {
    rect([0, 0], 10, 10);
    const scene = render();

    const row = macroPayload(scene);
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('inside a sketch');
  });

  it("compares cache-stable across identical renders (SceneCompare is pre-build)", () => {
    const declare = (w: number) => {
      sketch('xy', () => {
        const r = rect([0, 0], w, 25).radius(4);
        fix(r.bottom().start(), [4, 0]);
      });
      extrude(10);
    };
    declare(40);
    render();
    const previousScene = getSceneManager().currentScene;
    const previousIds = previousScene.getSceneObjects().map(o => o.id);

    // Identical redeclare → the whole subtree caches, ids preserved. The
    // fresh macro has NOT finalized when compare runs — config equality
    // must be enough.
    let newScene = getSceneManager().startScene();
    declare(40);
    SceneCompare.compare(previousScene, newScene);
    expect(newScene.getSceneObjects().map(o => o.id)).toEqual(previousIds);
    for (const obj of newScene.getSceneObjects()) {
      expect(newScene.isCached(obj)).toBe(true);
    }

    // A changed size arg busts the sketch subtree (container atomicity).
    newScene = getSceneManager().startScene();
    declare(60);
    SceneCompare.compare(previousScene, newScene);
    const sketchObj = newScene.getSceneObjects().find(o => o.getUniqueType() === 'sketch');
    expect(newScene.isCached(sketchObj)).toBe(false);
  });

  it(".guide() excludes the whole shape from the profile", () => {
    sketch('xy', () => {
      rect([0, 0], 100, 100).guide();
      const inner = rect([10, 10], 20, 20);
      fix(inner.bottom().start(), [10, 10]);
    });
    const e = extrude(5) as ExtrudeBase;
    const scene = render();
    expect(scene).toBeTruthy();

    const solid = e.getShapes()[0] as Solid;
    const bbox = getBoundingBoxOfShapes([solid]);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(20, 4);
    expect(bbox.maxY - bbox.minY).toBeCloseTo(20, 4);
  });
});
