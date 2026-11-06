// The generated-part cache (S3): part templates a render's compare leaves
// unpaired go to a process-wide, least-recently-used cache bounded by a
// count and a size estimate, and a later render that declares them again
// takes them built — reported fromCache. Its keys hold the detail tier
// (ctx.detail, a render option) and the definition's code version, so a
// preview build never stands in for a full one and code that changed is
// never served old shapes. A template's build is in one place: the scene
// holding it or the cache; the cache disposes what it holds once, and no
// scene's disposal frees it. Each render reports its layouts and where
// each template's shapes came from (built, kept, cached), with times.
//
// Build counts come from the cabinet fixture's static build. render()
// never throws — every test asserts the scene's errors.

import { describe, it, expect, afterEach, vi } from "vitest";
import { setupOC } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { Scene } from "../../rendering/scene.js";
import type { SceneCompareOptions } from "../../rendering/scene-compare.js";
import { SceneDisposal } from "../../rendering/scene-disposal.js";
import { GeneratedTemplateCache } from "../../rendering/generated-template-cache.js";
import insert from "../../core/insert.js";
import { Part } from "../../features/part.js";
import type { Shape } from "../../common/shape.js";
import { ShapeProps } from "../../oc/props.js";
import { FeatureNamespaces } from "../../sdk/feature-namespaces.js";
import { Generator, defineAssembly } from "../../sdk/index.js";
import type { GeneratedAssemblyDefinition } from "../../sdk/define-assembly.js";
import type { RenderDetail } from "../../rendering/scene.js";
import { defineCabinet } from "../fixtures/custom-features/cabinet.js";

/** Where the cabinet's `defineAssembly()` runs: an assembly module of the workspace. */
const CABINET_FILE = "/ws/assemblies/cabinet.assembly.js";

const cache = GeneratedTemplateCache.shared;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** The parts a generator made in `scene`, in scene order. */
function templates(scene: Scene): Part[] {
  return scene.getAllSceneObjects().filter((o): o is Part => o instanceof Part && !!o.generatedBy && o.getParent() === null);
}

function template(scene: Scene, type: string): Part {
  return templates(scene).find(part => part.generatedBy!.type === type)!;
}

/** The shapes a template's body holds. */
function shapesOf(part: Part): Shape[] {
  return part.getChildren()[0].getShapes();
}

function volumeOf(part: Part): number {
  return shapesOf(part).reduce((sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

/**
 * The cabinet as its module defines it on each render: a new class, a new
 * definition, located at {@link CABINET_FILE} — so a change to that module
 * reaches it.
 */
function cabinetDef(Cabinet = defineCabinet().Cabinet): GeneratedAssemblyDefinition<any> {
  return new Function("defineAssembly", "Cabinet", `return defineAssembly(Cabinet, { label: 'Cabinet' });\n//# sourceURL=${CABINET_FILE}`)(
    defineAssembly, Cabinet,
  ) as GeneratedAssemblyDefinition<any>;
}

type Render = {
  scene: AssemblyScene;
  builds: Map<string, number>;
  details: string[];
};

/** What one render of a {@link Session} is run with. */
type RenderOptions = {
  /** The scene's detail tier; `'full'` when left out. */
  detail?: RenderDetail;
  /** What the compare is told (`rebuild`). */
  compare?: SceneCompareOptions;
  /** The module's cabinet class this time — its code changed — instead of a fresh evaluation of the same code. */
  generator?: (fresh: ReturnType<typeof defineCabinet>) => unknown;
};

/**
 * Renders as a host runs them: each starts its scene, evaluates the module
 * again — a new cabinet class and definition — and inserts the cabinet with
 * each of `inserts`, compares against the scene before it, and renders.
 */
class Session {
  previous: AssemblyScene | null = null;

  render(inserts: Record<string, unknown>[] = [{}], options: RenderOptions = {}): Render {
    const scene = getSceneManager().startAssemblyScene(options.detail ? { detail: options.detail } : {});
    const fresh = defineCabinet();
    const def = cabinetDef((options.generator?.(fresh) ?? fresh.Cabinet) as never);
    for (const values of inserts) {
      insert(def, values as never);
    }
    if (this.previous) {
      getSceneManager().compare(this.previous, scene, undefined, options.compare);
    }
    getSceneManager().renderScene(scene);
    this.previous = scene;
    return { scene, builds: fresh.builds, details: fresh.details };
  }
}

/** The cabinet with a code-only edit: another class text, the same parts. */
function tweaked({ Cabinet }: ReturnType<typeof defineCabinet>): unknown {
  const Base = Cabinet as unknown as (abstract new (values: never) => object) & { build(type: string, inputs: unknown, ctx: unknown): unknown };
  abstract class Tweaked extends Base {
    static override build(type: string, inputs: unknown, ctx: unknown) {
      return super.build(type, inputs, ctx);
    }
  }
  return Tweaked;
}

const WIDE = { width: 800 };

describe("the generated-part cache", () => {
  setupOC();

  afterEach(() => {
    cache.setLimits(GeneratedTemplateCache.DEFAULT_LIMITS);
    FeatureNamespaces.useStamp(null);
  });

  it("rebuilds only the templates whose inputs a value changed, and reports the rest kept", () => {
    const session = new Session();
    const first = session.render();
    expect(errorsOf(first.scene)).toEqual([]);
    // Two doors and two drawers: one template each, built once.
    expect(Object.fromEntries(first.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });

    // The finish is the carcass's and the doors' appearance; the drawers have none.
    const walnut = session.render([{ finish: "walnut" }]);
    expect(errorsOf(walnut.scene)).toEqual([]);
    expect(Object.fromEntries(walnut.builds)).toEqual({ carcass: 1, door: 1 });
    const report = getSceneManager().getGeneratedReport(walnut.scene);
    expect(report.templates.map(t => [t.type, t.source])).toEqual([["carcass", "built"], ["door", "built"], ["drawer", "kept"]]);
    expect(report.misses).toBe(2);
    expect(report.hits).toEqual({ kept: 1, cached: 0 });
  });

  it("builds nothing going back: render A, then B, then A takes A's parts from the cache, served from cache", () => {
    const taken = cache.getStats().taken;
    const session = new Session();
    const a = session.render();
    const volumes = templates(a.scene).map(volumeOf);

    const b = session.render([WIDE]);
    expect(errorsOf(b.scene)).toEqual([]);
    expect(Object.fromEntries(b.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });
    expect(cache.getStats().entries).toBe(3);

    const again = session.render();
    expect(errorsOf(again.scene)).toEqual([]);
    expect(again.builds.size).toBe(0);
    // Every part and member took its build: rendered from cache, the same shapes.
    for (const part of templates(again.scene)) {
      expect([part, ...part.getChildren()].every(obj => again.scene.isCached(obj))).toBe(true);
    }
    const rows = again.scene.getRenderedObjects().filter(row => row.type === "part");
    expect(rows.every(row => row.fromCache)).toBe(true);
    expect(templates(again.scene).map(volumeOf)).toEqual(volumes.map(v => expect.closeTo(v, 6)));
    const report = getSceneManager().getGeneratedReport(again.scene);
    expect(report.hits).toEqual({ kept: 0, cached: 3 });
    expect(report.misses).toBe(0);
    // A's parts left the cache with the render that took them; B's took their place.
    expect(cache.getStats()).toMatchObject({ entries: 3, taken: taken + 3 });
  });

  it("builds each detail tier once: preview then full builds both, and revisiting either builds nothing", () => {
    const session = new Session();
    const preview = session.render([{}], { detail: "preview" });
    expect(errorsOf(preview.scene)).toEqual([]);
    expect(preview.details).toEqual(["carcass:preview", "door:preview", "drawer:preview"]);

    const full = session.render([{}], { detail: "full" });
    expect(full.details).toEqual(["carcass:full", "door:full", "drawer:full"]);
    expect(getSceneManager().getGeneratedReport(full.scene)).toMatchObject({ detail: "full", misses: 3 });

    const previewAgain = session.render([{}], { detail: "preview" });
    expect(previewAgain.details).toEqual([]);
    expect(getSceneManager().getGeneratedReport(previewAgain.scene)).toMatchObject({ detail: "preview", hits: { kept: 0, cached: 3 } });

    const fullAgain = session.render();
    expect(fullAgain.details).toEqual([]);
    expect(errorsOf(fullAgain.scene)).toEqual([]);
    expect(templates(fullAgain.scene).map(part => part.generatedBy!.detail)).toEqual(["full", "full", "full"]);
  });

  it("refuses a detail other than preview or full", () => {
    expect(() => new Scene({ detail: "draft" as RenderDetail })).toThrow(`a scene's detail is 'preview' or 'full', got "draft"`);
  });

  it("evicts the least recently used past its count, disposing each evicted part once, and never the parts the next render takes", () => {
    cache.setLimits({ maxEntries: 2 });
    const disposed = cache.getStats().disposed;
    const session = new Session();
    const a = session.render();
    const [carcass, door, drawer] = templates(a.scene).map(shapesOf);
    const release = vi.spyOn(SceneDisposal, "releaseOwned");

    session.render([WIDE]);
    // A's three parts were retired in scene order; the carcass, the oldest, went.
    expect(cache.getStats()).toMatchObject({ entries: 2, disposed: disposed + 1 });
    expect(release).toHaveBeenCalledTimes(1);
    // The carcass's solid and its connectors' centre marks, all released.
    const evicted = [...release.mock.calls[0][0]];
    expect(evicted).toEqual(expect.arrayContaining(carcass));
    expect(evicted.map(shape => shape.getType()).sort()).toEqual(["solid", "vertex", "vertex", "vertex", "vertex", "vertex"]);
    expect(evicted.every(shape => shape.isReleased())).toBe(true);
    expect([...door, ...drawer].some(shape => shape.isReleased())).toBe(false);

    // Going back retires the wide cabinet's three parts — past the bound —
    // yet A's door and drawer, which this render takes, stay.
    const again = session.render();
    expect(errorsOf(again.scene)).toEqual([]);
    expect(Object.fromEntries(again.builds)).toEqual({ carcass: 1 });
    expect(getSceneManager().getGeneratedReport(again.scene).hits).toEqual({ kept: 0, cached: 2 });
    expect(release).toHaveBeenCalledTimes(4);
    expect(cache.getStats()).toMatchObject({ entries: 0, disposed: disposed + 4 });
    release.mockRestore();
  });

  it("evicts the least recently used past its size estimate", () => {
    const session = new Session();
    session.render();
    session.render([WIDE]);
    const full = cache.getStats();
    expect(full.entries).toBe(3);
    expect(full.size).toBeGreaterThan(0);

    cache.setLimits({ maxSize: full.size - 1 });
    expect(cache.getStats()).toMatchObject({ entries: 2, disposed: full.disposed + 1 });
    expect(cache.getStats().size).toBeLessThan(full.size);

    cache.setLimits({ maxSize: 0 });
    expect(cache.getStats()).toMatchObject({ entries: 0, size: 0, disposed: full.disposed + 3 });
  });

  it("never disposes a part a live scene holds", () => {
    const session = new Session();
    session.render();
    const b = session.render([{ drawers: 3 }]);
    expect(errorsOf(b.scene)).toEqual([]);
    // The drawer stayed in the live scene; the old carcass and doors went to the cache.
    expect(Object.fromEntries(b.builds)).toEqual({ carcass: 1, door: 1 });
    expect(cache.getStats().entries).toBe(2);

    const disposed = cache.getStats().disposed;
    cache.setLimits({ maxEntries: 0 });
    cache.clear();
    expect(cache.getStats()).toMatchObject({ entries: 0, disposed: disposed + 2 });
    for (const part of templates(b.scene)) {
      expect(shapesOf(part).some(shape => shape.isReleased())).toBe(false);
      expect(volumeOf(part)).toBeGreaterThan(0);
    }
  });

  it("is never freed by a scene's disposal: an older scene that still names its parts spares them", () => {
    const session = new Session();
    const a = session.render();
    const volumes = templates(a.scene).map(volumeOf);
    // The second render carries every part over, so both scenes name the
    // same shapes; the third retires them from the second.
    const carried = session.render();
    expect(carried.builds.size).toBe(0);
    const shapes = templates(carried.scene).flatMap(shapesOf);
    session.render([WIDE]);
    expect(cache.getStats().entries).toBe(3);

    getSceneManager().disposeScenes([a.scene]);
    expect(shapes.some(shape => shape.isReleased())).toBe(false);

    const again = session.render();
    expect(errorsOf(again.scene)).toEqual([]);
    expect(again.builds.size).toBe(0);
    expect(templates(again.scene).map(volumeOf)).toEqual(volumes.map(v => expect.closeTo(v, 6)));
  });

  it("takes nothing for a scene dropped before it renders", () => {
    const session = new Session();
    session.render();
    session.render([WIDE]);

    // A render that never gets that far — its module threw after the insert.
    getSceneManager().startAssemblyScene();
    insert(cabinetDef(), {} as never);
    expect(cache.getStats().entries).toBe(3);

    const again = session.render();
    expect(again.builds.size).toBe(0);
  });

  it("rebuilds after a module the definition comes from changed: no pairing, the cache drops its parts", () => {
    const session = new Session();
    session.render();
    session.render([WIDE]);
    expect(cache.getStats().entries).toBe(3);

    // The host: a save of the cabinet's module (or a module it imports).
    expect(getSceneManager().noteCodeChanged(["/ws/features/lib/unrelated.js"])).toEqual([]);
    expect(getSceneManager().noteCodeChanged([CABINET_FILE])).toEqual(["acme.cabinet"]);
    expect(cache.getStats().entries).toBe(0);

    // Neither the cache nor the previous render serves the old code's parts.
    const wide = session.render([WIDE]);
    expect(errorsOf(wide.scene)).toEqual([]);
    expect(Object.fromEntries(wide.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });
    // And what was built with the old code is disposed, not cached, as it leaves.
    expect(cache.getStats().entries).toBe(0);

    const a = session.render();
    expect(Object.fromEntries(a.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });
  });

  it("rebuilds a definition the compare is told changed", () => {
    const session = new Session();
    session.render();
    session.render([WIDE]);
    const told = session.render([WIDE], { compare: { rebuild: new Set(["acme.cabinet"]) } });
    expect(errorsOf(told.scene)).toEqual([]);
    expect(Object.fromEntries(told.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });
    // The cache dropped the defaults' parts with it, and the old wide parts went too.
    expect(cache.getStats().entries).toBe(0);
  });

  it("rebuilds after the generator class's own code changed, saved or not — and the old code's parts still serve the old code", () => {
    const session = new Session();
    session.render();
    session.render([WIDE]);
    expect(Generator.codeBaseOf(tweaked(defineCabinet()) as never)).not.toBe(Generator.codeBaseOf(defineCabinet().Cabinet));
    // The same code evaluated again is the same code.
    expect(Generator.codeBaseOf(defineCabinet().Cabinet)).toBe(Generator.codeBaseOf(defineCabinet().Cabinet));

    const edited = session.render([{}], { generator: tweaked });
    expect(errorsOf(edited.scene)).toEqual([]);
    expect(Object.fromEntries(edited.builds)).toEqual({ carcass: 1, door: 1, drawer: 1 });

    // An undo: the old code's parts, still cached under its version, come back.
    const undone = session.render();
    expect(errorsOf(undone.scene)).toEqual([]);
    expect(undone.builds.size).toBe(0);
  });

  it("takes a package's version into the code version: another version never reads the other's parts", () => {
    FeatureNamespaces.useStamp(() => "@acme/cabinets@1.0.0#aaaa");
    const v1 = defineCabinet().Cabinet;
    FeatureNamespaces.useStamp(() => "@acme/cabinets@1.1.0#bbbb");
    const v2 = defineCabinet().Cabinet;
    FeatureNamespaces.useStamp(null);
    expect(Generator.codeBaseOf(v1)).toMatch(/^@acme\/cabinets@1\.0\.0#aaaa:/);
    expect(Generator.codeBaseOf(v2)).toMatch(/^@acme\/cabinets@1\.1\.0#bbbb:/);
    expect(Generator.codeBaseOf(defineCabinet().Cabinet)).toMatch(/^workspace:/);

    const first = getSceneManager().startAssemblyScene();
    insert(cabinetDef(v1), {} as never);
    getSceneManager().renderScene(first);
    const second = getSceneManager().startAssemblyScene();
    insert(cabinetDef(v2), {} as never);
    getSceneManager().compare(first, second);
    getSceneManager().renderScene(second);
    expect(errorsOf(second)).toEqual([]);
    expect(getSceneManager().getGeneratedReport(second)).toMatchObject({ misses: 3, hits: { kept: 0, cached: 0 } });
  });

  it("reports each layout's time and parts, and each template's source and build time", () => {
    const session = new Session();
    const first = session.render([{}, { drawers: 9 }]);
    const report = getSceneManager().getGeneratedReport(first.scene);
    expect(report.detail).toBe("full");
    expect(report.layouts.map(l => ({ definition: l.definition, assembly: l.assembly, parts: l.parts, refused: l.refused }))).toEqual([
      { definition: "acme.cabinet", assembly: "Cabinet", parts: 5, refused: false },
      { definition: "acme.cabinet", assembly: "Cabinet", parts: 0, refused: true },
    ]);
    expect(report.layouts.every(l => l.ms >= 0)).toBe(true);
    expect(report.layoutMs).toBeCloseTo(report.layouts[0].ms + report.layouts[1].ms, 9);
    expect(report.templates.map(t => [t.definition, t.type, t.detail, t.source])).toEqual([
      ["acme.cabinet", "carcass", "full", "built"],
      ["acme.cabinet", "door", "full", "built"],
      ["acme.cabinet", "drawer", "full", "built"],
    ]);
    expect(report.templates.every(t => typeof t.buildMs === "number" && t.buildMs >= 0)).toBe(true);
    expect(report.buildMs).toBeCloseTo(report.templates.reduce((sum, t) => sum + t.buildMs!, 0), 9);
    expect(new Set(report.templates.map(t => t.key)).size).toBe(3);
    expect(report.templates[0].key).toMatch(/^[0-9a-f]{14}$/);
    expect(report).toMatchObject({ misses: 3, hits: { kept: 0, cached: 0 } });
    expect(report.cache).toMatchObject({ entries: 0, ...GeneratedTemplateCache.DEFAULT_LIMITS });

    const failing = getSceneManager().startAssemblyScene();
    const { Cabinet } = defineCabinet({ failBuild: "door" });
    insert(cabinetDef(Cabinet), {} as never);
    getSceneManager().renderScene(failing);
    const door = getSceneManager().getGeneratedReport(failing).templates.find(t => t.type === "door")!;
    expect(door.error).toBe("Cabinet.build('door'): no door today");
    expect(door.source).toBe("built");
  });
});
