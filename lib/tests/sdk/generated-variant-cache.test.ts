// Generated parts' variants in the template cache (F2): a definePart variant
// an assembly compare leaves unpaired goes to the process-wide template cache
// beside the generators' templates, keyed by its definition, name, values,
// units and code version (Part.cacheKey), and a later render that declares the
// same variant again takes it built — reported fromCache, with the shapes,
// buckets, connector frames, mesh keys and lineage a fresh build gives. Code
// that changed (the feature class's text, a module save, the host's rebuild
// set) never serves old shapes. A variant's build is in one place: a live
// scene or the cache; the cache frees what it holds once, and never what a
// scene holds. A part file renders its defaults without the cache.
//
// Build counts come from the spur fixture (defineSpur({ builds })). render()
// never throws — every test asserts the scene's errors.

import { describe, it, expect, afterEach, vi } from "vitest";
import { setupOC } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { Scene, type RenderDetail, type RenderedShape } from "../../rendering/scene.js";
import type { SceneCompareOptions } from "../../rendering/scene-compare.js";
import { SceneDisposal } from "../../rendering/scene-disposal.js";
import { GeneratedTemplateCache } from "../../rendering/generated-template-cache.js";
import insert from "../../core/insert.js";
import { Part } from "../../features/part.js";
import { Connector } from "../../features/connector.js";
import { SceneObject } from "../../common/scene-object.js";
import type { Shape } from "../../common/shape.js";
import type { Face } from "../../common/face.js";
import { ShapeProps } from "../../oc/props.js";
import { Feature } from "../../sdk/feature.js";
import { ClassModules } from "../../sdk/class-modules.js";
import { definePart } from "../../sdk/index.js";
import type { GeneratedPartDefinition } from "../../sdk/define-part.js";
import { defineSpur, spurRadius, SPUR_DEFAULTS, type SpurClass } from "../fixtures/custom-features/spur.js";

/** Where the spur part's `definePart()` runs: a part module of the workspace. */
const SPUR_PART_FILE = "/ws/parts/spur.part.js";

const cache = GeneratedTemplateCache.shared;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

/** The definePart variants `scene` holds, in scene order. */
function variants(scene: Scene): Part[] {
  return scene.getAllSceneObjects().filter((o): o is Part => o instanceof Part && !!o.generatedVariant && o.getParent() === null);
}

function variantWith(scene: Scene, teeth: number): Part {
  const found = variants(scene).filter(part => part.paramValues?.teeth === teeth);
  expect(found).toHaveLength(1);
  return found[0];
}

function subtree(root: SceneObject): SceneObject[] {
  return [root, ...root.getChildren().flatMap(subtree)];
}

function featureOf(part: Part): Feature {
  return part.getChildren().find((child): child is Feature => child instanceof Feature)!;
}

function solidsOf(part: Part): Shape[] {
  return subtree(part).filter(obj => !(obj instanceof Part)).flatMap(obj => obj.getShapes()).filter(shape => shape.isSolid());
}

function volumeOf(part: Part): number {
  return solidsOf(part).reduce((sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

const discVolume = (teeth: number) => Math.PI * spurRadius(teeth, SPUR_DEFAULTS.module) ** 2 * SPUR_DEFAULTS.width;

/** Every shape wrapper the objects' state reaches. */
function shapesOf(objects: SceneObject[]): Shape[] {
  return [...SceneDisposal.collectShapes(objects)];
}

/** The spur part as its module defines it on each render: a new definition of `Spur`, located at {@link SPUR_PART_FILE}. */
function spurDef(Spur: SpurClass): GeneratedPartDefinition {
  return new Function("definePart", "Spur", `return definePart(Spur, { label: 'Spur' });\n//# sourceURL=${SPUR_PART_FILE}`)(
    definePart, Spur,
  ) as GeneratedPartDefinition;
}

/** What one render of a {@link Session} is run with. */
type RenderOptions = {
  /** The scene's detail tier; `'full'` when left out. */
  detail?: RenderDetail;
  /** What the compare is told (`rebuild`). */
  compare?: SceneCompareOptions;
  /** The module's spur class this time — its code changed — instead of a fresh evaluation of the same code. */
  spur?: (fresh: SpurClass) => SpurClass;
};

/**
 * Renders as a host runs them: each starts an assembly scene, evaluates the
 * module again — a new spur class and definition — inserts the spur with
 * each of `inserts`, compares against the scene before it, and renders.
 * Every build of every render lands in {@link builds}.
 */
class Session {
  previous: AssemblyScene | null = null;
  readonly builds: number[] = [];

  constructor(private readonly buckets = false) {}

  render(inserts: Record<string, unknown>[], options: RenderOptions = {}): AssemblyScene {
    const scene = getSceneManager().startAssemblyScene(options.detail ? { detail: options.detail } : {});
    const { Spur } = defineSpur({ builds: this.builds, buckets: this.buckets });
    const def = spurDef(options.spur?.(Spur) ?? Spur);
    for (const values of inserts) {
      insert(def as never, values as never);
    }
    if (this.previous) {
      getSceneManager().compare(this.previous, scene, undefined, options.compare);
    }
    getSceneManager().renderScene(scene);
    this.previous = scene;
    return scene;
  }

  /** The builds since `from` (an earlier `builds.length`). */
  since(from: number): number[] {
    return this.builds.slice(from);
  }
}

/** The spur with a code-only edit: another class text, the same shapes. */
function tweaked(Spur: SpurClass): SpurClass {
  const Base = Spur as unknown as new (values: never) => { buildTool(): Shape[] };
  class Tweaked extends Base {
    override buildTool(): Shape[] {
      return super.buildTool();
    }
  }
  return Tweaked as unknown as SpurClass;
}

/** How a rendered row reads, less what is minted afresh each render (ids, timings) and whether it came from a cache. */
function rowOf(scene: Scene, obj: SceneObject): Record<string, unknown> {
  const row = scene.getRenderedObject(obj)!;
  const { id: _id, parentId: _parentId, fromCache: _fromCache, buildDurationMs: _ms, profileCategories: _profile, sceneShapes, ...rest } = row as typeof row & Record<string, unknown>;
  return {
    ...rest,
    shapes: sceneShapes.map(({ shapeId: _shapeId, meshes: _meshes, vertices: _vertices, faceVertices: _faceVertices, ...shape }: RenderedShape) => shape),
  };
}

/** A face as geometry: its bounding box, rounded — two builds of one face read the same. */
function faceBox(face: Face): number[] {
  const box = face.getBoundingBox();
  return [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ].map(n => Math.round(n * 1e6) / 1e6);
}

describe("generated parts' variants in the template cache", () => {
  setupOC();

  afterEach(() => {
    cache.setLimits(GeneratedTemplateCache.DEFAULT_LIMITS);
  });

  it("builds nothing on the way back: A → B → A takes A from the cache, every row fromCache, the report says cached", () => {
    const session = new Session();
    const first = session.render([{ teeth: 24 }]);
    expect(errorsOf(first)).toEqual([]);
    expect(session.builds).toEqual([24]);
    expect(getSceneManager().getGeneratedReport(first).variants.map(v => [v.part, v.values.teeth, v.source]))
      .toEqual([["Spur", 24, "built"]]);
    const firstShapes = shapesOf(subtree(variantWith(first, 24)));

    const b = session.render([{ teeth: 30 }]);
    expect(errorsOf(b)).toEqual([]);
    expect(session.builds).toEqual([24, 30]);
    // The 24-tooth variant left the scene for the cache, its build intact.
    expect(cache.getStats().entries).toBe(1);
    expect(firstShapes.every(shape => cache.heldShapes().has(shape) && !shape.isReleased())).toBe(true);

    const taken = cache.getStats().taken;
    const back = session.render([{ teeth: 24 }]);
    expect(errorsOf(back)).toEqual([]);
    expect(session.builds).toEqual([24, 30]);
    const part = variantWith(back, 24);
    expect(subtree(part).map(obj => back.isCached(obj))).toEqual(subtree(part).map(() => true));
    expect(subtree(part).map(obj => back.getRenderedObject(obj)!.fromCache)).toEqual(subtree(part).map(() => true));
    expect(volumeOf(part)).toBeCloseTo(discVolume(24), 1);
    // The first render's shapes, the scene's own again.
    expect(shapesOf(subtree(part))).toEqual(expect.arrayContaining(firstShapes));
    expect(firstShapes.some(shape => cache.heldShapes().has(shape))).toBe(false);
    expect(cache.getStats().taken).toBe(taken + 1);

    const report = getSceneManager().getGeneratedReport(back);
    expect(report.variants.map(v => [v.definition, v.values.teeth, v.source])).toEqual([["acme.spur", 24, "cached"]]);
    expect(report.hits).toEqual({ kept: 0, cached: 1 });
    expect(report.misses).toBe(0);
    expect(report.templates).toEqual([]);
  });

  it("builds equal values once: two inserts of one values, and {} beside the defaults, share one variant — across renders too", () => {
    const session = new Session();
    const scene = session.render([{ teeth: 18 }, { teeth: 18 }, {}, { teeth: SPUR_DEFAULTS.teeth }]);
    expect(errorsOf(scene)).toEqual([]);
    expect(session.builds).toEqual([18, SPUR_DEFAULTS.teeth]);
    expect(variants(scene)).toHaveLength(2);
    expect(scene.getInstances().map(inst => inst.part)).toEqual([
      variantWith(scene, 18), variantWith(scene, 18), variantWith(scene, SPUR_DEFAULTS.teeth), variantWith(scene, SPUR_DEFAULTS.teeth),
    ]);

    // Away and back: both come back from the cache, built once in all.
    session.render([{ teeth: 50 }]);
    const back = session.render([{ teeth: SPUR_DEFAULTS.teeth }, { teeth: 18 }, { teeth: 18 }]);
    expect(errorsOf(back)).toEqual([]);
    expect(session.builds).toEqual([18, SPUR_DEFAULTS.teeth, 50]);
    expect(getSceneManager().getGeneratedReport(back).variants.map(v => v.source)).toEqual(["cached", "cached"]);
  });

  it("rebuilds only the variant whose values changed, and reports the other kept", () => {
    const session = new Session();
    session.render([{ teeth: 24 }, { teeth: 40 }]);
    expect(session.builds).toEqual([24, 40]);
    const next = session.render([{ teeth: 30 }, { teeth: 40 }]);
    expect(errorsOf(next)).toEqual([]);
    expect(session.since(2)).toEqual([30]);
    const report = getSceneManager().getGeneratedReport(next);
    expect(report.variants.map(v => [v.values.teeth, v.source])).toEqual([[30, "built"], [40, "kept"]]);
    expect(report.misses).toBe(1);
    expect(report.hits).toEqual({ kept: 1, cached: 0 });
    expect(report.variants[0].buildMs).toBeGreaterThan(0);
    expect(report.buildMs).toBeCloseTo(report.variants[0].buildMs!, 6);
    expect(volumeOf(variantWith(next, 30))).toBeCloseTo(discVolume(30), 1);
    expect(volumeOf(variantWith(next, 40))).toBeCloseTo(discVolume(40), 1);
  });

  it("serves a variant a preview render built to the full render: a feature's build reads no detail tier", () => {
    const session = new Session();
    session.render([{ teeth: 24 }], { detail: "preview" });
    session.render([{ teeth: 30 }], { detail: "preview" });
    expect(session.builds).toEqual([24, 30]);
    const full = session.render([{ teeth: 24 }], { detail: "full" });
    expect(errorsOf(full)).toEqual([]);
    expect(session.builds).toEqual([24, 30]);
    expect(getSceneManager().getGeneratedReport(full).variants.map(v => v.source)).toEqual(["cached"]);
    // And the full render carries the preview's other variant over.
    const kept = session.render([{ teeth: 24 }], { detail: "preview" });
    expect(getSceneManager().getGeneratedReport(kept).variants.map(v => v.source)).toEqual(["kept"]);
    expect(session.builds).toEqual([24, 30]);
  });

  it("rebuilds after a change of the feature class's text — and the old code's variant comes back on undo", () => {
    const session = new Session();
    session.render([{ teeth: 24 }]);
    session.render([{ teeth: 30 }]);
    expect(session.builds).toEqual([24, 30]);

    // The class's text changed (an edit of buildTool, saved or not): the cached 24 is not its build.
    const edited = session.render([{ teeth: 24 }], { spur: tweaked });
    expect(errorsOf(edited)).toEqual([]);
    expect(session.since(2)).toEqual([24]);
    expect(getSceneManager().getGeneratedReport(edited).variants.map(v => v.source)).toEqual(["built"]);
    // The same values with the edited code again: carried over, as the compare pairs same code.
    session.render([{ teeth: 24 }], { spur: tweaked });
    expect(session.since(2)).toEqual([24]);

    // Undone: the old code's 24 — retired in the second render — is still its build.
    const undone = session.render([{ teeth: 24 }]);
    expect(errorsOf(undone)).toEqual([]);
    expect(session.since(2)).toEqual([24]);
    expect(getSceneManager().getGeneratedReport(undone).variants.map(v => v.source)).toEqual(["cached"]);
  });

  it("drops what it holds of a definition whose module — the part's or its feature class's — changed, and never serves it again", () => {
    for (const changed of [SPUR_PART_FILE, ClassModules.of(defineSpur().Spur)!]) {
      const session = new Session();
      session.render([{ teeth: 24 }]);
      session.render([{ teeth: 30 }]);
      expect(cache.getStats().entries).toBe(1);
      const held = [...cache.heldShapes()];
      const disposed = cache.getStats().disposed;

      // The host heard of a save: the definition takes a new code version, its cached variant is disposed.
      expect(getSceneManager().noteCodeChanged([changed])).toContain("acme.spur");
      expect(cache.getStats().entries).toBe(0);
      expect(cache.getStats().disposed).toBe(disposed + 1);
      expect(held.every(shape => shape.isReleased())).toBe(true);

      // The 30 on screen was built with the old version: it rebuilds too, though its values are the same.
      const same = session.render([{ teeth: 30 }]);
      expect(errorsOf(same)).toEqual([]);
      expect(session.since(2)).toEqual([30]);
      const back = session.render([{ teeth: 24 }]);
      expect(errorsOf(back)).toEqual([]);
      expect(session.since(2)).toEqual([30, 24]);
      expect(volumeOf(variantWith(back, 24))).toBeCloseTo(discVolume(24), 1);
      cache.clear();
    }
  });

  it("rebuilds a feature the host names in `rebuild`, and disposes its old variant as it leaves — once", () => {
    const session = new Session();
    const first = session.render([{ teeth: 24 }]);
    const old = subtree(variantWith(first, 24));
    const oldShapes = shapesOf(old);
    session.render([{ teeth: 30 }]);
    expect(cache.getStats().entries).toBe(1);

    const destroy = vi.spyOn(SceneObject.prototype, "destroy");
    const rebuilt = session.render([{ teeth: 24 }], { compare: { rebuild: new Set(["acme.spur"]) } });
    expect(errorsOf(rebuilt)).toEqual([]);
    expect(session.since(2)).toEqual([24]);
    // The cached 24 was dropped, the leaving 30 disposed at once — both by the cache, once each.
    expect(cache.getStats().entries).toBe(0);
    expect(old.map(obj => destroy.mock.contexts.filter(c => c === obj).length)).toEqual(old.map(() => 1));
    expect(oldShapes.every(shape => shape.isReleased())).toBe(true);
    destroy.mockRestore();
  });

  it("disposes an evicted variant once, and builds it again when it is asked for", () => {
    const session = new Session();
    const first = session.render([{ teeth: 24 }]);
    const old = subtree(variantWith(first, 24));
    const oldShapes = shapesOf(old);
    const b = session.render([{ teeth: 30 }]);

    const destroy = vi.spyOn(SceneObject.prototype, "destroy");
    const release = vi.spyOn(SceneDisposal, "releaseOwned");
    cache.setLimits({ maxEntries: 0 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(old.map(obj => destroy.mock.contexts.filter(c => c === obj).length)).toEqual(old.map(() => 1));
    expect(oldShapes.every(shape => shape.isReleased())).toBe(true);
    // The live scene's variant is its own.
    expect(shapesOf(b.getAllSceneObjects()).some(shape => shape.isReleased())).toBe(false);
    cache.setLimits(GeneratedTemplateCache.DEFAULT_LIMITS);

    const again = session.render([{ teeth: 24 }]);
    expect(errorsOf(again)).toEqual([]);
    expect(session.since(2)).toEqual([24]);
    expect(volumeOf(variantWith(again, 24))).toBeCloseTo(discVolume(24), 1);
    expect(release).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
    release.mockRestore();
  });

  it("never frees a variant a live scene holds: clear() and a zero bound leave the scene on screen whole", () => {
    const session = new Session();
    session.render([{ teeth: 24 }]);
    const live = session.render([{ teeth: 30 }, { teeth: 40 }]);
    const liveShapes = shapesOf(live.getAllSceneObjects());
    cache.clear();
    cache.setLimits({ maxEntries: 0, maxSize: 0 });
    expect(liveShapes.some(shape => shape.isReleased())).toBe(false);
    // And it keeps rendering on them: carried over by the next compare.
    const next = session.render([{ teeth: 30 }, { teeth: 40 }]);
    expect(errorsOf(next)).toEqual([]);
    expect(session.since(1)).toEqual([30, 40]);
    expect(volumeOf(variantWith(next, 30))).toBeCloseTo(discVolume(30), 1);
  });

  it("keeps nothing of an insert refused for its values, nor of a scene that never rendered", () => {
    const session = new Session();
    const refused = session.render([{ teeth: 2 }, { teeth: 24 }]);
    expect(errorsOf(refused).some(error => error.includes("teeth"))).toBe(true);
    session.render([{ teeth: 30 }]);
    // The 24 went to the cache; the refused insert's empty part did not.
    expect(cache.getStats().entries).toBe(1);

    // A scene that declared a variant and was dropped unrendered hands the cache nothing.
    const unrendered = getSceneManager().startAssemblyScene();
    insert(spurDef(defineSpur({ builds: session.builds }).Spur) as never, { teeth: 60 } as never);
    const next = getSceneManager().startAssemblyScene();
    insert(spurDef(defineSpur({ builds: session.builds }).Spur) as never, { teeth: 61 } as never);
    getSceneManager().compare(unrendered, next);
    getSceneManager().renderScene(next);
    expect(errorsOf(next)).toEqual([]);
    expect(cache.getStats().entries).toBe(1);
  });

  it("renders a part file's defaults without the cache: it neither takes the assembly's variant nor hands its own over", () => {
    const session = new Session();
    session.render([{}]);
    session.render([{ teeth: 30 }]);
    // The default variant is in the cache.
    expect(cache.getStats().entries).toBe(1);
    const taken = cache.getStats().taken;

    // The part file (its definePart() rendered on its own): the default variant, built in its own scene.
    const builds = session.builds.length;
    const partScene = getSceneManager().startScene();
    const def = spurDef(defineSpur({ builds: session.builds }).Spur);
    def.materializeInto(partScene);
    getSceneManager().renderScene(partScene);
    expect(errorsOf(partScene)).toEqual([]);
    expect(session.since(builds)).toEqual([SPUR_DEFAULTS.teeth]);
    expect(cache.getStats().taken).toBe(taken);
    expect(cache.getStats().entries).toBe(1);
    expect(partScene.getAllSceneObjects().some(obj => partScene.isCached(obj))).toBe(false);
  });

  it("restores a variant exactly as a fresh build makes it: volumes, bucket faces, connector frames, rows, mesh keys and lineage", () => {
    const session = new Session(true);
    session.render([{ teeth: 24 }]);
    session.render([{ teeth: 30 }]);
    const restoredScene = session.render([{ teeth: 24 }]);
    expect(errorsOf(restoredScene)).toEqual([]);
    expect(session.builds).toEqual([24, 30]);
    const restored = variantWith(restoredScene, 24);

    cache.clear();
    const fresh = new Session(true);
    const freshScene = fresh.render([{ teeth: 24 }]);
    expect(errorsOf(freshScene)).toEqual([]);
    expect(fresh.builds).toEqual([24]);
    const built = variantWith(freshScene, 24);

    expect(subtree(restored).map(obj => restoredScene.getRenderedObject(obj)!.fromCache)).toEqual(subtree(restored).map(() => true));
    expect(subtree(built).map(obj => freshScene.getRenderedObject(obj)!.fromCache)).toEqual(subtree(built).map(() => false));

    expect(volumeOf(restored)).toBeCloseTo(volumeOf(built), 6);
    expect(volumeOf(restored)).toBeCloseTo(discVolume(24), 1);

    // The feature's buckets: the custom rim and the standard side, start and end faces.
    for (const key of ["bucket:rimFaces", "side-faces", "start-faces", "end-faces"]) {
      const restoredFaces = (featureOf(restored).getState(key) as Face[]).map(faceBox);
      const builtFaces = (featureOf(built).getState(key) as Face[]).map(faceBox);
      expect(restoredFaces.length, key).toBeGreaterThan(0);
      expect(restoredFaces, key).toEqual(builtFaces);
    }

    // The connector on the feature's frame.
    const frameOf = (part: Part) => {
      const connector = part.getChildren().find((child): child is Connector => child instanceof Connector)!;
      const frame = connector.getFrame();
      return { name: connector.connectorName, origin: frame.origin, normal: frame.normal, x: frame.xDirection };
    };
    expect(JSON.parse(JSON.stringify(frameOf(restored)))).toEqual(JSON.parse(JSON.stringify(frameOf(built))));
    expect(frameOf(restored).name).toBe("axis");

    // The rows the hosts get: names, objects, shapes with their mesh keys and lineage keys — identical.
    const restoredRows = subtree(restored).map(obj => rowOf(restoredScene, obj));
    const builtRows = subtree(built).map(obj => rowOf(freshScene, obj));
    expect(restoredRows).toEqual(builtRows);
    const keys = (rows: Record<string, unknown>[]) => rows.flatMap(row => (row.shapes as RenderedShape[]).map(shape => [shape.meshKey, shape.lineageKey]));
    expect(keys(restoredRows).length).toBeGreaterThan(0);
    expect(keys(restoredRows).every(([meshKey]) => typeof meshKey === "string")).toBe(true);
    expect(keys(restoredRows).some(([, lineageKey]) => typeof lineageKey === "string")).toBe(true);
    expect(keys(restoredRows)).toEqual(keys(builtRows));
    // No face colour records on either: a feature paints nothing.
    expect(featureOf(restored).getState("faceColors") ?? []).toEqual(featureOf(built).getState("faceColors") ?? []);
  });
});
