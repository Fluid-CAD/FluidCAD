import { describe, it, expect, vi, afterEach } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { RenderChangeTracker } from "../rendering/render-changes.js";
import { ShapeInterference } from "../oc/shape-interference.js";
import { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Extrude } from "../features/extrude.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import insert from "../core/insert.js";
import { circle } from "../core/2d/index.js";
import { testRect } from "./helpers/profiles.js";

// The change summary is the MCP's view of what the incremental compare
// decided: which feature rows were built again, which are new, which are
// gone, and how many were served from cache — with exact bounds so an agent
// can tell "rebuilt, same geometry" from "rebuilt, moved". It exists only
// when a render asks for it; the guard test at the end pins that a compare
// without a tracker never runs any of it.

/** A base block with a named boss on its top face. */
function buildPart(opts: { baseDepth?: number; bossDepth?: number; extra?: boolean } = {}): Scene {
  const scene = getSceneManager().startScene();
  sketch("xy", () => {
    testRect(100, 50);
  });
  const base = extrude(opts.baseDepth ?? 30) as Extrude;
  sketch(base.endFaces() as never, () => {
    circle([50, 25], 20);
  });
  extrude(opts.bossDepth ?? 10).name("boss");
  if (opts.extra) {
    sketch("xz", () => {
      circle([-40, 0], 5);
    });
    extrude(4).name("pin");
  }
  return scene;
}

function buildAssembly(camDepth: number): AssemblyScene {
  const scene = getSceneManager().startAssemblyScene();
  const base = part("Base", () => {
    sketch("xy", () => {
      testRect(60, 60);
    });
    extrude(10);
  });
  const cam = part("Cam", () => {
    sketch("xz", () => {
      circle([0, 12], 40);
    });
    extrude(camDepth);
  });
  insert(base);
  insert(cam);
  return scene;
}

function assertBuilt(scene: Scene): void {
  for (const obj of scene.getAllSceneObjects()) {
    expect(obj.getError(), `${obj.getUniqueType()} failed to build`).toBeNull();
  }
}

/** Render `previous`, build `next`, compare with a tracker, render, summarize. */
function rerender(previous: Scene, next: Scene, limit?: number) {
  const tracker = getSceneManager().trackRenderChanges(limit);
  const merged = getSceneManager().compare(previous, next, tracker);
  render();
  assertBuilt(merged);
  return { changes: tracker.summarize(merged), merged };
}

describe("RenderChangeTracker", () => {
  setupOC();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports only the edited feature rebuilt, with before and after bounds", () => {
    const first = buildPart({ bossDepth: 10 });
    render();
    assertBuilt(first);

    const { changes } = rerender(first, buildPart({ bossDepth: 20 }));

    expect(changes.rebuilt.map(e => e.name)).toEqual(["boss"]);
    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual([]);
    // Sketch, base extrude, the materialized endFaces() selection, boss
    // sketch: a sketch's lines, constraints and internal plane fold into
    // its row.
    expect(changes.reused).toBe(4);
    expect(changes.truncated).toBeUndefined();

    const boss = changes.rebuilt[0];
    expect(boss.kind).toBe("extrude");
    expect(boss.shapes).toBe(1);
    // The boss fuses into the base, so its added solid is the whole body.
    expect(boss.bounds?.before).toEqual({ min: [0, 0, 0], max: [100, 50, 40] });
    expect(boss.bounds?.after).toEqual({ min: [0, 0, 0], max: [100, 50, 50] });
  });

  it("reports a downstream sketch and its feature rebuilt when the face they sit on moves", () => {
    const first = buildPart({ baseDepth: 30 });
    render();

    const { changes } = rerender(first, buildPart({ baseDepth: 40 }));

    expect(changes.rebuilt.map(e => e.name)).toEqual(["Extrude", "Select", "Sketch", "boss"]);
    expect(changes.reused).toBe(1);
    // The sketch adds no solid, so it carries no bounds; the boss moved up
    // with the face even though its own statement did not change.
    expect(changes.rebuilt[2].bounds).toBeUndefined();
    expect(changes.rebuilt[3].bounds?.before?.max[2]).toBe(40);
    expect(changes.rebuilt[3].bounds?.after?.max[2]).toBe(50);
  });

  it("lists new features under added and dropped ones under removed", () => {
    const plain = buildPart();
    render();

    const grown = rerender(plain, buildPart({ extra: true }));
    expect(grown.changes.rebuilt).toEqual([]);
    expect(grown.changes.added.map(e => e.name)).toEqual(["Sketch", "pin"]);
    expect(grown.changes.added[1].bounds?.after).toBeDefined();
    expect(grown.changes.added[1].bounds?.before).toBeUndefined();
    expect(grown.changes.reused).toBe(5);

    const shrunk = rerender(grown.merged, buildPart());
    expect(shrunk.changes.rebuilt).toEqual([]);
    expect(shrunk.changes.added).toEqual([]);
    expect(shrunk.changes.removed.map(e => e.name)).toEqual(["Sketch", "pin"]);
    expect(shrunk.changes.removed[1].kind).toBe("extrude");
    expect(shrunk.changes.reused).toBe(5);
  });

  it("caps every list and counts what it dropped", () => {
    const first = buildPart({ baseDepth: 30 });
    render();

    const { changes } = rerender(first, buildPart({ baseDepth: 40 }), 1);

    expect(changes.rebuilt).toHaveLength(1);
    expect(changes.rebuilt[0].name).toBe("Extrude");
    expect(changes.truncated).toBe(3);
  });

  it("summarizes a forced rebuild (no compare) as everything rebuilt", () => {
    const first = buildPart();
    render();

    // The recompute path drops the previous scene without a compare: the
    // server captures it whole (nothing matched) before disposing it.
    const tracker = getSceneManager().trackRenderChanges();
    tracker.captureBefore(first, new Map());
    getSceneManager().disposeScene(first);

    const next = buildPart();
    render();
    assertBuilt(next);
    const changes = tracker.summarize(next);

    expect(changes.reused).toBe(0);
    expect(changes.added).toEqual([]);
    expect(changes.rebuilt.map(e => e.name)).toEqual(["Sketch", "Extrude", "Select", "Sketch", "boss"]);
    expect(changes.rebuilt[4].bounds?.before).toEqual(changes.rebuilt[4].bounds?.after);
  });

  it("reports nothing built for a deduplicated render", () => {
    const first = buildPart();
    render();

    const changes = getSceneManager().trackRenderChanges().summarizeUnchanged(first);

    expect(changes).toEqual({ rebuilt: [], added: [], removed: [], reused: 5 });
  });

  it("works over an assembly: the edited part's rows rebuild, the other part is reused", () => {
    const first = buildAssembly(24);
    getSceneManager().renderScene(first);
    assertBuilt(first);

    const tracker = getSceneManager().trackRenderChanges();
    const merged = getSceneManager().compare(first, buildAssembly(30), tracker);
    getSceneManager().renderScene(merged);
    assertBuilt(merged);
    const changes = tracker.summarize(merged);

    expect(changes.rebuilt.map(e => `${e.kind}:${e.name}`)).toEqual(["part:Cam", "sketch:Sketch", "extrude:Extrude"]);
    expect(changes.rebuilt[2].bounds?.before).toBeDefined();
    expect(changes.rebuilt[2].bounds?.after).toBeDefined();
    expect(changes.rebuilt[2].bounds?.before).not.toEqual(changes.rebuilt[2].bounds?.after);
    expect(changes.added).toEqual([]);
    expect(changes.removed).toEqual([]);
    expect(changes.reused).toBe(3);
  });

  it("never runs without a tracker, and decides the same reuse either way", () => {
    const capture = vi.spyOn(RenderChangeTracker.prototype, "captureBefore");
    const bounds = vi.spyOn(ShapeInterference, "bounds");

    const first = buildPart({ bossDepth: 10 });
    render();
    const next = buildPart({ bossDepth: 20 });
    const merged = getSceneManager().compare(first, next);

    // The host's render: the compare returns the scene it was given and no
    // change-tracking code ran — no capture, no bounding box.
    expect(merged).toBe(next);
    expect(capture).not.toHaveBeenCalled();
    expect(bounds).not.toHaveBeenCalled();
    render();
    assertBuilt(merged);
    expect(bounds).not.toHaveBeenCalled();
    const untracked = merged.getAllSceneObjects().map(o => [o.getUniqueType(), merged.isCached(o)]);

    // The same edit with a tracker: identical reuse decisions.
    const again = buildPart({ bossDepth: 10 });
    render();
    const tracker = getSceneManager().trackRenderChanges();
    const tracked = getSceneManager().compare(again, buildPart({ bossDepth: 20 }), tracker);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(tracked.getAllSceneObjects().map(o => [o.getUniqueType(), tracked.isCached(o)])).toEqual(untracked);
  });
});
