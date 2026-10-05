import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import { Scene } from "../../rendering/scene.js";
import { BreakpointHit } from "../../common/breakpoint-hit.js";
import { SceneObject } from "../../common/scene-object.js";
import { Part } from "../../features/part.js";
import type { PartDefinition } from "../../features/part-definition.js";
import part from "../../core/part.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import expose from "../../core/expose.js";
import { breakpoint } from "../../core/breakpoint.js";
import { circle } from "../../core/2d/index.js";
import { scopedSceneBefore } from "../../selection/types.js";
import type { IExtrude } from "../../core/interfaces.js";

// part() is lazy: a definition builds after the module ran, so a statement
// written after a part builds before it. The timeline — what a render lists,
// and what rollbacks, pauses and statement boundaries count rows in — keeps
// the order the statements ran, with the part where its part() call ran.

function disc(plane: "xy" | "xz" | "yz", radius: number): SceneObject {
  return sketch(plane, () => {
    circle([0, 0], radius);
  }) as unknown as SceneObject;
}

function builtPart(def: PartDefinition<unknown>, scene: Scene): Part {
  return def.builtVariantsIn(scene)[0];
}

/** `sketch; part(sketch → extrude); sketch` — the second sketch written after the part. */
function partBetweenSketches() {
  const before = disc("xy", 10);
  let body: SceneObject | null = null;
  const def = part("A", () => {
    disc("xz", 6);
    body = extrude(5) as unknown as SceneObject;
  });
  const after = disc("yz", 4);
  const scene = render();
  return { scene, before, after, body: body!, part: builtPart(def, scene) };
}

/** A breakpoint() statement, typed so the statements after it still read as reachable. */
function pauseHere(): void {
  breakpoint();
}

/** Pause the way the hosts do: a breakpoint stops the build, the render carries on. */
function renderPaused(scene: Scene): void {
  try {
    scene.materializeLeftoverDefinitions();
  } catch (e) {
    if (!(e instanceof BreakpointHit)) {
      throw e;
    }
  }
  getSceneManager().renderScene(scene);
}

describe("timeline order", () => {
  setupOC();

  it("lists a statement written after a part below it, though it builds first", () => {
    const { scene, before, after, part: a } = partBetweenSketches();
    const built = scene.getAllSceneObjects();
    const rows = scene.getTimelineObjects();

    expect(built.indexOf(after)).toBeLessThan(built.indexOf(a));
    expect(rows.indexOf(before)).toBeLessThan(rows.indexOf(a));
    expect(rows.indexOf(a)).toBeLessThan(rows.indexOf(after));
    // The render lists exactly those rows.
    expect(scene.getRenderedObjects().map(r => r.id)).toEqual(rows.map(o => o.id));
  });

  it("keeps a part's members together at its call, and parts in call order", () => {
    const a = part("A", () => {
      disc("xy", 10);
      extrude(5);
    });
    const middle = disc("xz", 4);
    const b = part("B", () => {
      disc("yz", 3);
      extrude(2);
    });
    const scene = render();
    const rows = scene.getTimelineObjects();
    const partA = builtPart(a, scene);
    const partB = builtPart(b, scene);
    const membersOf = (p: Part) => scene.getAllSceneObjects().filter(o => scene.findEnclosingPart(o) === p);

    const start = rows.indexOf(partA);
    expect(rows.slice(start, start + membersOf(partA).length)).toEqual(membersOf(partA));
    expect(rows.indexOf(partA)).toBeLessThan(rows.indexOf(middle));
    expect(rows.indexOf(middle)).toBeLessThan(rows.indexOf(partB));
    expect(rows).toHaveLength(scene.getAllSceneObjects().length);
  });

  it("still builds a part body that reads a top-level sketch declared below it", () => {
    let profile: SceneObject | null = null;
    let body: SceneObject | null = null;
    const def = part("A", () => {
      body = extrude(5, profile as any) as unknown as SceneObject;
    });
    profile = disc("xy", 10);
    const scene = render();

    expect(body!.getError()).toBeFalsy();
    expect(scene.getRenderedObject(body!)?.visible).toBe(true);
    const rows = scene.getTimelineObjects();
    expect(rows.indexOf(builtPart(def, scene))).toBeLessThan(rows.indexOf(profile!));
  });

  it("rolls back by row: the part listed above a statement is part of its world", () => {
    const { scene, before, after, body } = partBetweenSketches();
    const rows = scene.getTimelineObjects();

    getSceneManager().rollbackScene(scene, rows.indexOf(after));
    expect(scene.getRenderedObject(body)?.visible).toBe(true);

    getSceneManager().rollbackScene(scene, rows.indexOf(before));
    expect(scene.getRenderedObject(body)?.visible).toBe(false);
    expect(scene.getRenderedObjects().map(r => r.id)).toEqual(rows.map(o => o.id));
  });

  it("stops a render paused inside a part on its paused row, scoped to the part", () => {
    const scene = getCurrentScene();
    disc("xy", 10);
    let paused: SceneObject | null = null;
    const def = part("A", () => {
      paused = disc("xz", 6);
      pauseHere();
      extrude(5);
    });
    const after = disc("yz", 4);
    renderPaused(scene);

    const rows = scene.getTimelineObjects();
    const { stop, scopePartId } = getSceneManager().renderStop(scene);
    const a = builtPart(def, scene);
    expect(scopePartId).toBe(a.id);
    expect(scene.findEnclosingPart(rows[stop])).toBe(a);
    expect(scene.getSceneObjectsUpTo(rows[stop])).toContain(paused);
    // Written after the part: listed below the paused row, and it ran.
    expect(rows.indexOf(after)).toBeGreaterThan(stop);
    expect(scene.getRenderedObject(after)?.visible).toBe(true);
  });

  it("stops a render paused at the top level on the last row", () => {
    const scene = getCurrentScene();
    part("A", () => {
      disc("xy", 10);
      extrude(5);
    });
    disc("xz", 4);
    try {
      pauseHere();
    } catch (e) {
      if (!(e instanceof BreakpointHit)) {
        throw e;
      }
    }
    renderPaused(scene);

    expect(getSceneManager().renderStop(scene)).toEqual({
      stop: scene.getTimelineObjects().length - 1,
      scopePartId: null,
    });
  });

  it("scopes a statement boundary by row to what built before the statement", () => {
    const { scene, before, after, part: a } = partBetweenSketches();
    const rows = scene.getTimelineObjects();

    const scoped = scopedSceneBefore(scene, rows.indexOf(after));
    expect(scoped.editedStatement).toBe(after);
    expect(scoped.getAllSceneObjects()).toContain(before);
    // Listed above the statement, but built after it: not in its world.
    expect(scoped.getAllSceneObjects()).not.toContain(a);
  });

  it("builds a part a top-level statement reads through .features right before it", () => {
    const def = part("A", () => {
      disc("xy", 10);
      const e = extrude(5) as unknown as IExtrude;
      expose("top", e.endFaces(0) as any);
    });
    const onFace = sketch(def.features.top as any, () => {
      circle([0, 0], 3);
    }) as unknown as SceneObject;
    const scene = render();
    const a = builtPart(def, scene);

    expect(onFace.getError()).toBeFalsy();
    const built = scene.getAllSceneObjects();
    expect(built.indexOf(a)).toBeLessThan(built.indexOf(onFace));
    const rows = scene.getTimelineObjects();
    expect(rows.indexOf(a)).toBeLessThan(rows.indexOf(onFace));
    // Built before the reader, so its edit boundary sees the part.
    expect(scopedSceneBefore(scene, rows.indexOf(onFace)).getAllSceneObjects()).toContain(a);
  });

  it("leaves an assembly's rows in build order", () => {
    const scene = getSceneManager().startAssemblyScene();
    const a = part("A", () => {
      disc("xy", 10);
      extrude(5);
    });
    const b = part("B", () => {
      disc("xz", 4);
      extrude(2);
    });
    // Built the other way round from their part() calls, as inserts can.
    b.materialize();
    a.materialize();

    expect(scene.getTimelineObjects()).toEqual(scene.getAllSceneObjects());
  });
});
