// An assembly render frees the scene it replaces (plans/assembly-scene-leak.md):
// AssemblyCompare destroys every old object the new scene doesn't take over
// and releases every old shape wrapper the new scene doesn't reach — the part
// that rebuilt (a changed insert value, a sub-assembly's part, a definePart
// variant), never the parts it carried over, and never what the generated-
// template cache took (the cache disposes that, once, when it lets go). The
// new scene keeps building clean on top of what survived, render after
// render. render() never throws: every test asserts getError().

import { describe, it, expect, vi, afterEach } from "vitest";
import { setupOC } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import { Scene } from "../rendering/scene.js";
import { SceneDisposal } from "../rendering/scene-disposal.js";
import { GeneratedTemplateCache } from "../rendering/generated-template-cache.js";
import type { SceneCompareOptions } from "../rendering/scene-compare.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Part } from "../features/part.js";
import { ShapeProps } from "../oc/props.js";
import part from "../core/part.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import expose from "../core/expose.js";
import param from "../core/param.js";
import connector from "../core/connector.js";
import select from "../core/select.js";
import mate from "../core/mate.js";
import { breakpoint } from "../core/breakpoint.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { face } from "../filters/index.js";
import { testRect } from "./helpers/profiles.js";
import { definePart, defineAssembly } from "../sdk/index.js";
import { defineSpur, spurRadius, SPUR_DEFAULTS } from "./fixtures/custom-features/spur.js";
import { defineCabinet } from "./fixtures/custom-features/cabinet.js";

const cache = GeneratedTemplateCache.shared;

/**
 * Renders as a host runs them: each starts an assembly scene, evaluates the
 * module again (`body`: fresh definitions, the inserts), compares against
 * the scene before it, renders — and from then on holds only the new scene.
 */
class Renders {
  previous: AssemblyScene | null = null;

  render(body: () => void, compare?: SceneCompareOptions): AssemblyScene {
    const scene = getSceneManager().startAssemblyScene();
    body();
    if (this.previous) {
      getSceneManager().compare(this.previous, scene, undefined, compare);
    }
    getSceneManager().renderScene(scene);
    this.previous = scene;
    return scene;
  }
}

/** What a compare did to the old scene: how often each object was destroyed, and the disposal failures it logged. */
class DisposalWatch {
  private readonly destroy = vi.spyOn(SceneObject.prototype, "destroy");
  private readonly errors = vi.spyOn(console, "error");

  /** How many times `obj` was destroyed since the watch started. */
  destroys(obj: SceneObject): number {
    return this.destroy.mock.contexts.filter(context => context === obj).length;
  }

  /** The disposal failures logged — none, or a wrapper was freed twice. */
  failures(): unknown[][] {
    return this.errors.mock.calls.filter(call => String(call[0]).includes("disposal"));
  }

  stop(): void {
    this.destroy.mockRestore();
    this.errors.mockRestore();
  }
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function topParts(scene: Scene): Part[] {
  return scene.getAllSceneObjects().filter((o): o is Part => o instanceof Part && o.getParent() === null);
}

/** The top-level part whose insert passed `values`. */
function partWith(scene: Scene, values: Record<string, unknown>): Part {
  const found = topParts(scene).filter(p => Object.entries(values).every(([key, value]) => p.paramValues?.[key] === value));
  expect(found).toHaveLength(1);
  return found[0];
}

function subtree(root: SceneObject): SceneObject[] {
  return [root, ...root.getChildren().flatMap(subtree)];
}

/** Every shape wrapper the objects' state reaches. */
function shapesOf(objects: SceneObject[]): Shape[] {
  return [...SceneDisposal.collectShapes(objects)];
}

/** The volume of the solids the objects build — parts left out: a part answers its members' shapes. */
function solidVolume(objects: SceneObject[]): number {
  return objects
    .filter(obj => !(obj instanceof Part))
    .flatMap(obj => obj.getShapes())
    .filter(shape => shape.isSolid())
    .reduce((sum, shape) => sum + ShapeProps.getProperties(shape.getShape()).volumeMm3, 0);
}

/**
 * Every scene object the new scene's objects and assembly records point at
 * that a disposal destroyed — none, or the scene reads an object a compare
 * freed. Walks state and records like the disposal walker does: arrays, maps,
 * sets and plain records; a scene object ends the walk.
 */
function destroyedReferences(scene: AssemblyScene): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (value instanceof SceneObject) {
      if (value.isDestroyed()) {
        found.push(value.getUniqueType());
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        walk(key);
        walk(entry);
      }
      return;
    }
    if (value instanceof Set) {
      value.forEach(walk);
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      Object.values(value).forEach(walk);
    }
  };
  for (const obj of scene.getAllSceneObjects()) {
    walk(obj);
    walk(obj.getFullState());
  }
  walk(scene.getInstances());
  walk(scene.getMates());
  walk(scene.getOccurrences());
  walk(scene.getAssemblyConnectors());
  walk(scene.getRelations());
  return found;
}

/** No wrapper the scene's objects reach is released: it renders on live memory. */
function releasedIn(scene: Scene): number {
  return shapesOf(scene.getAllSceneObjects()).filter(shape => shape.isReleased()).length;
}

/**
 * A beam of `Length` × 20 × 15 — a fresh definition, as each render's module
 * evaluation makes — with a connector on its top face when asked.
 */
function beamDefinition(options: { connector?: boolean } = {}) {
  return part("Beam", () => {
    const length = param("Length", 100) as number;
    sketch("xy", () => { testRect(length, 20); });
    extrude(15);
    if (options.connector) {
      connector("top", select(face().planar().onPlane("xy", 15)));
    }
  });
}

const beamVolume = (length: number) => length * 20 * 15;

describe("an assembly render frees the scene it replaces", () => {
  setupOC();

  let watch: DisposalWatch | null = null;

  afterEach(() => {
    watch?.stop();
    watch = null;
    cache.setLimits(GeneratedTemplateCache.DEFAULT_LIMITS);
  });

  it("destroys and releases the rebuilt variant's old subtree once, and leaves the unchanged variant alone", () => {
    const renders = new Renders();
    // Each beam carries a connector on its top face; the two are mated.
    const twoBeams = (first: number) => () => {
      const beam = beamDefinition({ connector: true });
      const a = insert(beam, { Length: first });
      const b = insert(beam, { Length: 50 });
      mate("fastened", a.connectors.top, b.connectors.top);
    };

    const scene1 = renders.render(twoBeams(100));
    expect(errorsOf(scene1)).toEqual([]);
    const rebuilt = subtree(partWith(scene1, { Length: 100 }));
    const kept = subtree(partWith(scene1, { Length: 50 }));
    const rebuiltShapes = shapesOf(rebuilt);
    const keptShapes = shapesOf(kept);
    expect(rebuiltShapes.length).toBeGreaterThan(0);
    expect(keptShapes.length).toBeGreaterThan(0);

    watch = new DisposalWatch();
    const scene2 = renders.render(twoBeams(200));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene2)).toEqual([]);

    // The 100 beam rebuilt as a 200 one: its old part and every member destroyed once, its shapes freed.
    expect(rebuilt.map(obj => watch!.destroys(obj))).toEqual(rebuilt.map(() => 1));
    expect(rebuiltShapes.every(shape => shape.isReleased())).toBe(true);
    // The 50 beam was carried over: nothing of it destroyed, its shapes live in the new scene.
    expect(kept.map(obj => watch!.destroys(obj))).toEqual(kept.map(() => 0));
    expect(keptShapes.some(shape => shape.isReleased())).toBe(false);
    const carried = new Set(shapesOf(subtree(partWith(scene2, { Length: 50 }))));
    expect(keptShapes.every(shape => carried.has(shape))).toBe(true);
    expect(scene2.isCached(partWith(scene2, { Length: 50 }))).toBe(true);

    expect(releasedIn(scene2)).toBe(0);
    expect(destroyedReferences(scene2)).toEqual([]);
    // The mate joins the new scene's connectors — the kept beam's carried
    // over, the rebuilt one's built again — and both frames read.
    const [joint] = scene2.getMates();
    for (const side of [joint.connectorA!, joint.connectorB!]) {
      expect(scene2.getAllSceneObjects()).toContain(side.connector);
      expect(side.connector.getFrame().normal.z).toBeCloseTo(1, 6);
    }
    expect(solidVolume(subtree(partWith(scene2, { Length: 200 })))).toBeCloseTo(beamVolume(200), 3);
    expect(solidVolume(subtree(partWith(scene2, { Length: 50 })))).toBeCloseTo(beamVolume(50), 3);

    // A second and a third render go on from what survived: back to 100, then to 200 again.
    for (const [length, round] of [[100, 3], [200, 4]] as const) {
      const before = renders.previous!;
      const scene = renders.render(twoBeams(length));
      expect(watch.failures()).toEqual([]);
      expect(errorsOf(scene), `render ${round}`).toEqual([]);
      expect(releasedIn(scene)).toBe(0);
      expect(destroyedReferences(scene)).toEqual([]);
      expect(solidVolume(subtree(partWith(scene, { Length: length })))).toBeCloseTo(beamVolume(length), 3);
      expect(solidVolume(subtree(partWith(scene, { Length: 50 })))).toBeCloseTo(beamVolume(50), 3);
      // The 50 beam's wrappers are the first render's still.
      expect(new Set(shapesOf(subtree(partWith(scene, { Length: 50 }))))).toEqual(new Set(keptShapes));
      // Of the scene before, only what this one carried over is still alive.
      const live = new Set(shapesOf(scene.getAllSceneObjects()));
      expect(shapesOf(before.getAllSceneObjects()).filter(shape => !shape.isReleased() && !live.has(shape))).toEqual([]);
    }
  });

  it("frees a paused render's partial part and the parts it never reached, and the full render after it builds clean", () => {
    const renders = new Renders();
    // A breakpoint() in the first beam's body after its first extrude: the
    // render stops there, the partial part recorded paused, the second
    // insert never run — as the host catches the pause and renders what ran.
    const model = (stop: boolean) => () => {
      const beam = part("Beam", () => {
        const length = param("Length", 100) as number;
        sketch("xy", () => { testRect(length, 20); });
        extrude(15);
        if (stop) {
          breakpoint();
        }
        sketch("xy", () => { testRect(10, 10, { at: [0, 40] }); });
        extrude(5);
      });
      try {
        insert(beam, { Length: 100 });
        insert(beam, { Length: 50 });
      } catch (error) {
        if (!(error instanceof BreakpointHit)) {
          throw error;
        }
      }
    };
    const full = (length: number) => beamVolume(length) + 10 * 10 * 5;

    const scene1 = renders.render(model(false));
    expect(errorsOf(scene1)).toEqual([]);
    const before = topParts(scene1).flatMap(subtree);
    const beforeShapes = shapesOf(before);

    watch = new DisposalWatch();
    const paused = renders.render(model(true));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(paused)).toEqual([]);
    // Only the first beam ran, up to the pause.
    expect(topParts(paused)).toHaveLength(1);
    const [partial] = topParts(paused);
    expect(partial.isPaused()).toBe(true);
    expect(solidVolume(subtree(partial))).toBeCloseTo(beamVolume(100), 3);
    // Neither full beam carried over into the paused scene: both freed.
    expect(before.map(obj => watch!.destroys(obj))).toEqual(before.map(() => 1));
    expect(beforeShapes.every(shape => shape.isReleased())).toBe(true);
    expect(releasedIn(paused)).toBe(0);

    const partialObjects = subtree(partial);
    const partialShapes = shapesOf(partialObjects);
    const resumed = renders.render(model(false));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(resumed)).toEqual([]);
    expect(partialObjects.map(obj => watch!.destroys(obj))).toEqual(partialObjects.map(() => 1));
    expect(partialShapes.every(shape => shape.isReleased())).toBe(true);
    expect(releasedIn(resumed)).toBe(0);
    expect(destroyedReferences(resumed)).toEqual([]);
    expect(solidVolume(subtree(partWith(resumed, { Length: 100 })))).toBeCloseTo(full(100), 3);
    expect(solidVolume(subtree(partWith(resumed, { Length: 50 })))).toBeCloseTo(full(50), 3);
  });

  it("frees a sub-assembly occurrence's rebuilt part", () => {
    const renders = new Renders();
    const withSub = (length: number) => () => {
      const beam = beamDefinition();
      const sub = assembly("Sub", () => ({ beam: insert(beam, { Length: length }) }));
      insert(sub);
      insert(beam, { Length: 50 });
    };

    const scene1 = renders.render(withSub(100));
    expect(errorsOf(scene1)).toEqual([]);
    const inSub = subtree(partWith(scene1, { Length: 100 }));
    const inSubShapes = shapesOf(inSub);
    const kept = subtree(partWith(scene1, { Length: 50 }));

    watch = new DisposalWatch();
    const scene2 = renders.render(withSub(120));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene2)).toEqual([]);
    expect(scene2.getOccurrences()).toHaveLength(1);
    expect(inSub.map(obj => watch!.destroys(obj))).toEqual(inSub.map(() => 1));
    expect(inSubShapes.every(shape => shape.isReleased())).toBe(true);
    expect(kept.map(obj => watch!.destroys(obj))).toEqual(kept.map(() => 0));
    expect(releasedIn(scene2)).toBe(0);
    expect(destroyedReferences(scene2)).toEqual([]);
    expect(solidVolume(subtree(partWith(scene2, { Length: 120 })))).toBeCloseTo(beamVolume(120), 3);
  });

  it("frees a definePart variant whose values changed — every preview tick of a gear's teeth", () => {
    const renders = new Renders();
    const gears = (teeth: number) => () => {
      const { Spur } = defineSpur();
      const def = definePart(Spur, { label: "Spur" } as never);
      insert(def as never, { teeth } as never);
      insert(def as never, { teeth: 40 } as never);
    };
    const discVolume = (teeth: number) => Math.PI * spurRadius(teeth, SPUR_DEFAULTS.module) ** 2 * SPUR_DEFAULTS.width;

    const scene1 = renders.render(gears(24));
    expect(errorsOf(scene1)).toEqual([]);
    const variant = subtree(partWith(scene1, { teeth: 24 }));
    const variantShapes = shapesOf(variant);
    const other = subtree(partWith(scene1, { teeth: 40 }));
    const otherShapes = shapesOf(other);

    watch = new DisposalWatch();
    let scene = renders.render(gears(30));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene)).toEqual([]);
    expect(variant.map(obj => watch!.destroys(obj))).toEqual(variant.map(() => 1));
    expect(variantShapes.every(shape => shape.isReleased())).toBe(true);
    expect(other.map(obj => watch!.destroys(obj))).toEqual(other.map(() => 0));
    expect(otherShapes.some(shape => shape.isReleased())).toBe(false);

    for (const teeth of [24, 30, 24]) {
      scene = renders.render(gears(teeth));
      expect(watch.failures()).toEqual([]);
      expect(errorsOf(scene)).toEqual([]);
      expect(releasedIn(scene)).toBe(0);
      expect(destroyedReferences(scene)).toEqual([]);
      expect(solidVolume(subtree(partWith(scene, { teeth })))).toBeCloseTo(discVolume(teeth), 1);
      expect(solidVolume(subtree(partWith(scene, { teeth: 40 })))).toBeCloseTo(discVolume(40), 1);
    }
  });

  it("frees the parts a cross-part consumer rebuilds with, and keeps the consumer's donor geometry alive when both carry over", () => {
    const renders = new Renders();
    // The consumer extrudes the donor's exposed profile; Other stands apart with a value of its own.
    const model = (donorWidth: number, otherLength: number) => () => {
      const donor = part("Donor", () => {
        const s = sketch("xy", () => { testRect(donorWidth, 20); });
        expose("profile", s);
      });
      const consumer = part("Consumer", () => {
        extrude(15, donor.features.profile);
      });
      insert(donor);
      insert(consumer);
      insert(beamDefinition(), { Length: otherLength });
    };
    const byName = (scene: Scene, name: string) => topParts(scene).find(p => p.partName === name)!;

    const scene1 = renders.render(model(20, 100));
    expect(errorsOf(scene1)).toEqual([]);
    const donor1 = subtree(byName(scene1, "Donor"));
    const consumer1 = subtree(byName(scene1, "Consumer"));
    const pairShapes = shapesOf([...donor1, ...consumer1]);
    expect(solidVolume(subtree(byName(scene1, "Consumer")))).toBeCloseTo(20 * 20 * 15, 3);

    // Only Other changed: donor and consumer carry over, the consumer's
    // solid and the donor's profile with them, and they render on.
    watch = new DisposalWatch();
    const scene2 = renders.render(model(20, 120));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene2)).toEqual([]);
    expect(scene2.isCached(byName(scene2, "Consumer"))).toBe(true);
    expect([...donor1, ...consumer1].map(obj => watch!.destroys(obj))).toEqual([...donor1, ...consumer1].map(() => 0));
    expect(pairShapes.some(shape => shape.isReleased())).toBe(false);
    expect(releasedIn(scene2)).toBe(0);
    expect(destroyedReferences(scene2)).toEqual([]);
    expect(solidVolume(subtree(byName(scene2, "Consumer")))).toBeCloseTo(20 * 20 * 15, 3);

    // The donor changed: the consumer rebuilds with it, and both old subtrees go.
    const donor2 = subtree(byName(scene2, "Donor"));
    const consumer2 = subtree(byName(scene2, "Consumer"));
    const scene3 = renders.render(model(30, 120));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene3)).toEqual([]);
    expect(scene3.isCached(byName(scene3, "Consumer"))).toBe(false);
    expect([...donor2, ...consumer2].map(obj => watch!.destroys(obj))).toEqual([...donor2, ...consumer2].map(() => 1));
    expect(pairShapes.every(shape => shape.isReleased())).toBe(true);
    expect(releasedIn(scene3)).toBe(0);
    expect(destroyedReferences(scene3)).toEqual([]);
    expect(solidVolume(subtree(byName(scene3, "Consumer")))).toBeCloseTo(30 * 20 * 15, 3);
    expect(solidVolume(subtree(partWith(scene3, { Length: 120 })))).toBeCloseTo(beamVolume(120), 3);
  });

  it("leaves the templates it retires to the generated-part cache alone: the cache disposes them once, on eviction", () => {
    const renders = new Renders();
    const cabinet = (width: number) => () => {
      const { Cabinet } = defineCabinet();
      insert(defineAssembly(Cabinet as never, { label: "Cabinet" } as never) as never, { width } as never);
    };
    const scene1 = renders.render(cabinet(600));
    expect(errorsOf(scene1)).toEqual([]);
    const generated = topParts(scene1).filter(p => p.generatedBy);
    expect(generated.map(p => p.generatedBy!.type)).toEqual(["carcass", "door", "drawer"]);
    const retired = generated.flatMap(subtree);
    const retiredShapes = shapesOf(retired);
    const entries = cache.getStats().entries;

    // Every template's inputs change with the width: all three go to the cache, none to the scene's pass.
    watch = new DisposalWatch();
    const release = vi.spyOn(SceneDisposal, "releaseOwned");
    const scene2 = renders.render(cabinet(800));
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene2)).toEqual([]);
    expect(cache.getStats().entries).toBe(entries + 3);
    expect(retired.map(obj => watch!.destroys(obj))).toEqual(retired.map(() => 0));
    expect(retiredShapes.some(shape => shape.isReleased())).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(releasedIn(scene2)).toBe(0);
    expect(destroyedReferences(scene2)).toEqual([]);

    // Evicted: each template disposed once, its shapes released then.
    cache.setLimits({ maxEntries: 0 });
    expect(release).toHaveBeenCalledTimes(3);
    expect(retired.map(obj => watch!.destroys(obj))).toEqual(retired.map(() => 1));
    expect(retiredShapes.every(shape => shape.isReleased())).toBe(true);
    // The live scene's templates are its own: untouched by the eviction.
    expect(releasedIn(scene2)).toBe(0);
    release.mockRestore();
  });

  it("lets a template retired stale be disposed by the cache alone, once", () => {
    const renders = new Renders();
    const cabinet = () => {
      const { Cabinet } = defineCabinet();
      insert(defineAssembly(Cabinet as never, { label: "Cabinet" } as never) as never, {} as never);
    };
    const scene1 = renders.render(cabinet);
    expect(errorsOf(scene1)).toEqual([]);
    const retired = topParts(scene1).filter(p => p.generatedBy).flatMap(subtree);
    const retiredShapes = shapesOf(retired);

    // The generator's code changed: its old templates are stale, disposed as they leave.
    watch = new DisposalWatch();
    const scene2 = renders.render(cabinet, { rebuild: new Set(["acme.cabinet"]) });
    expect(watch.failures()).toEqual([]);
    expect(errorsOf(scene2)).toEqual([]);
    expect(retired.map(obj => watch!.destroys(obj))).toEqual(retired.map(() => 1));
    expect(retiredShapes.every(shape => shape.isReleased())).toBe(true);
    expect(releasedIn(scene2)).toBe(0);
  });

  it("frees nothing comparing a scene with itself, and destroys what an old scene that never rendered declared", () => {
    const scene = getSceneManager().startAssemblyScene();
    insert(beamDefinition(), { Length: 80 });
    getSceneManager().renderScene(scene);
    const shapes = shapesOf(scene.getAllSceneObjects());
    watch = new DisposalWatch();
    expect(getSceneManager().compare(scene, scene)).toBe(scene);
    expect(scene.getAllSceneObjects().map(obj => watch!.destroys(obj))).toEqual(scene.getAllSceneObjects().map(() => 0));
    expect(shapes.some(shape => shape.isReleased())).toBe(false);

    // An old scene that declared a part and never built it: the part is
    // destroyed, there is nothing to release, and the new scene builds.
    const unrendered = getSceneManager().startAssemblyScene();
    insert(beamDefinition(), { Length: 80 });
    const declared = topParts(unrendered).flatMap(subtree);
    const next = getSceneManager().startAssemblyScene();
    insert(beamDefinition(), { Length: 90 });
    getSceneManager().compare(unrendered, next);
    getSceneManager().renderScene(next);
    expect(watch.failures()).toEqual([]);
    expect(declared.map(obj => watch!.destroys(obj))).toEqual(declared.map(() => 1));
    expect(errorsOf(next)).toEqual([]);
    expect(solidVolume(next.getAllSceneObjects())).toBeCloseTo(90 * 20 * 15, 3);
  });

  // The growth check: the kernel memory a session holds is the live wrappers
  // — those of the scene on screen and those the template cache keeps. Before
  // the fix every render left the rebuilt parts' wrappers behind (~60 a
  // render here); the wasm heap numbers are in the generators plan's SL entry.
  it("holds as many live wrappers after 200 renders as after 10: a value alternating, a gear's teeth, a sub-assembly, a generated cabinet dragged", () => {
    cache.setLimits({ maxEntries: 9 });
    const renders = new Renders();
    const scenes: AssemblyScene[] = [];
    const model = (tick: number) => () => {
      const beam = beamDefinition();
      insert(beam, { Length: tick % 2 === 0 ? 100 : 200 });
      insert(beam, { Length: 50 });
      const sub = assembly("Sub", () => ({ beam: insert(beam, { Length: tick % 2 === 0 ? 70 : 80 }) }));
      insert(sub);
      const { Spur } = defineSpur();
      insert(definePart(Spur, { label: "Spur" } as never) as never, { teeth: tick % 2 === 0 ? 24 : 30 } as never);
      // A slider drag: a new width every tick, as preview ticks are.
      const { Cabinet } = defineCabinet();
      insert(defineAssembly(Cabinet as never, { label: "Cabinet" } as never) as never, { width: 600 + tick } as never);
    };
    /** Every wrapper not yet released that a rendered scene or the cache still names. */
    const liveWrappers = () => {
      const named = new Set([...shapesOf(scenes.flatMap(scene => scene.getAllSceneObjects())), ...cache.heldShapes()]);
      return [...named].filter(shape => !shape.isReleased()).length;
    };

    let atTen = 0;
    for (let tick = 0; tick < 200; tick++) {
      scenes.push(renders.render(model(tick)));
      if (tick === 9) {
        atTen = liveWrappers();
      }
    }
    const last = scenes[scenes.length - 1];
    expect(errorsOf(last)).toEqual([]);
    expect(atTen).toBeGreaterThan(0);
    expect(liveWrappers()).toBe(atTen);
    // Nothing outside the scene on screen and the cache.
    const live = new Set(shapesOf(last.getAllSceneObjects()));
    const outside = shapesOf(scenes.flatMap(scene => scene.getAllSceneObjects()))
      .filter(shape => !shape.isReleased() && !live.has(shape) && !cache.heldShapes().has(shape));
    expect(outside).toEqual([]);
    expect(cache.getStats().entries).toBe(9);
  });
});
