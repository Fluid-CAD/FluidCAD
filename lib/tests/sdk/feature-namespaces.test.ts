import { describe, it, expect, afterEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { testRect } from "../helpers/profiles.js";
import { getFeatureMeta, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { Feature, type FeatureMeta } from "../../sdk/index.js";
import type { Shape } from "../../sdk/kernel.js";
import { FeatureNamespaces } from "../../sdk/feature-namespaces.js";
import { defineStandoff, defineStandoffWithMeta } from "../fixtures/custom-features/standoff.js";
import type { ExtrudeBase } from "../../features/extrude-base.js";
import type { SceneObject } from "../../common/scene-object.js";

/**
 * A host's source, the way the server's scene host keeps one: the package
 * whose module is evaluating, held in an async context around it.
 */
class FakeHost {
  private readonly evaluating = new AsyncLocalStorage<string | null>();

  install(): void {
    FeatureNamespaces.use(() => this.evaluating.getStore() ?? null);
  }

  /** Run `body` as the evaluation of a module `owner` owns (null: a workspace module). */
  evaluate<T>(owner: string | null, body: () => T): T {
    return this.evaluating.run(owner, body);
  }
}

function bossClass(id = 'boss') {
  return class extends Feature {
    static id = id;
    buildTool(): Shape[] {
      return [];
    }
  };
}

function bossMeta(featureClass: Function, patch: Record<string, unknown> = {}): FeatureMeta {
  return {
    class: featureClass,
    label: 'Boss',
    group: 'create',
    kind: 'tool',
    params: { face: { picker: 'face' }, height: { type: 'length', default: 5 } },
    call: ['face', { height: 'height' }],
    ...patch,
  } as unknown as FeatureMeta;
}

function register(meta: FeatureMeta, options: Record<string, unknown> = {}) {
  return registerBuilder(() => () => undefined, { feature: meta, ...options });
}

describe("FeatureNamespaces", () => {
  afterEach(() => {
    FeatureNamespaces.use(null);
  });

  it("keys every feature by its plain id when no host source is installed", () => {
    const { standoff, Standoff, meta } = defineStandoff();
    expect(meta.id).toBe('acme.standoff');
    expect(getFeatureMeta(standoff)!.id).toBe('acme.standoff');
    expect(Feature.idOf(Standoff as unknown as typeof Feature)).toBe('acme.standoff');
    expect(FeatureNamespaces.packageOf(Standoff)).toBeNull();
  });

  it("keys a class registered while a package's module evaluates by that package", () => {
    const host = new FakeHost();
    host.install();
    const { standoff, Standoff, meta } = host.evaluate('@acme/kit', () => defineStandoff());

    expect(meta.id).toBe('@acme/kit:acme.standoff');
    expect(getFeatureMeta(standoff)!.id).toBe('@acme/kit:acme.standoff');
    expect(snapshotFeatureMeta(meta).id).toBe('@acme/kit:acme.standoff');
    expect(Feature.idOf(Standoff as unknown as typeof Feature)).toBe('@acme/kit:acme.standoff');
    expect(Feature.plainIdOf(Standoff as unknown as typeof Feature)).toBe('acme.standoff');
    expect(FeatureNamespaces.packageOf(Standoff)).toBe('@acme/kit');
  });

  it("keys the registerBuilder({ feature }) path the same way", () => {
    const host = new FakeHost();
    host.install();
    const { meta } = host.evaluate('@acme/kit', () => defineStandoffWithMeta());
    expect(meta.id).toBe('@acme/kit:acme.standoff');
  });

  it("leaves a class registered by a workspace module plain", () => {
    const host = new FakeHost();
    host.install();
    const { meta } = host.evaluate(null, () => defineStandoff());
    expect(meta.id).toBe('acme.standoff');
    const outside = defineStandoff();
    expect(outside.meta.id).toBe('acme.standoff');
  });

  it("keeps the context across awaits, and nested evaluations their own", async () => {
    const host = new FakeHost();
    host.install();
    const [outer, inner, after] = await host.evaluate('@acme/feature-tests', async () => {
      await Promise.resolve();
      const first = register(bossMeta(bossClass('standoff')));
      const nested = await host.evaluate('@bea-tools/feature-tests', async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return register(bossMeta(bossClass('standoff')));
      });
      const last = register(bossMeta(bossClass('boltCircle')));
      return [first, nested, last];
    });
    expect(getFeatureMeta(outer)!.id).toBe('@acme/feature-tests:standoff');
    expect(getFeatureMeta(inner)!.id).toBe('@bea-tools/feature-tests:standoff');
    expect(getFeatureMeta(after)!.id).toBe('@acme/feature-tests:boltCircle');
  });

  it("lets the first claim win", () => {
    const host = new FakeHost();
    host.install();
    const Boss = bossClass();
    host.evaluate('@acme/kit', () => register(bossMeta(Boss)));
    const again = host.evaluate(null, () => register(bossMeta(Boss, { label: 'Boss again' })));
    expect(getFeatureMeta(again)!.id).toBe('@acme/kit:boss');

    const Other = bossClass();
    host.evaluate(null, () => register(bossMeta(Other)));
    const later = host.evaluate('@acme/kit', () => register(bossMeta(Other, { label: 'Later' })));
    expect(getFeatureMeta(later)!.id).toBe('boss');
  });

  it("records nothing while no source is installed, so a later registration is still asked", () => {
    const Boss = bossClass();
    expect(getFeatureMeta(register(bossMeta(Boss)))!.id).toBe('boss');
    const host = new FakeHost();
    host.install();
    const keyed = host.evaluate('@acme/kit', () => register(bossMeta(Boss, { label: 'Keyed' })));
    expect(getFeatureMeta(keyed)!.id).toBe('@acme/kit:boss');
  });

  it("never keys the engine's own builders, and reads a failing source as no package", () => {
    const host = new FakeHost();
    host.install();
    const builtIn = host.evaluate('@acme/kit', () => register(bossMeta(bossClass('extrude')), { builtIn: true }));
    expect(getFeatureMeta(builtIn)!.id).toBe('extrude');

    FeatureNamespaces.use(() => {
      throw new Error('no host');
    });
    expect(getFeatureMeta(register(bossMeta(bossClass())))!.id).toBe('boss');
  });

  it("answers the source it replaces", () => {
    const first = () => '@acme/kit';
    expect(FeatureNamespaces.use(first)).toBeNull();
    expect(FeatureNamespaces.use(null)).toBe(first);
  });
});

describe("a keyed feature in the scene", () => {
  setupOC();

  afterEach(() => {
    FeatureNamespaces.use(null);
  });

  function plate(): ExtrudeBase {
    sketch("xy", () => {
      testRect(60, 40, { at: [-30, -20] });
    });
    return extrude(10) as unknown as ExtrudeBase;
  }

  it("carries the key as its type, its label as its display type, and the plain callee in messages", () => {
    const host = new FakeHost();
    host.install();
    const { standoff } = host.evaluate('@acme/feature-tests', () => defineStandoff());
    const p = plate();
    const s = standoff(p.endFaces(), { height: 8 }) as unknown as SceneObject;
    const scene = render();

    expect(scene.getAllSceneObjects().flatMap(o => o.getError() ? [o.getError()] : [])).toEqual([]);
    expect(s.getType()).toBe('@acme/feature-tests:acme.standoff');
    expect(s.getDisplayType()).toBe('Standoff');
    expect(() => standoff(p.endFaces(), { height: -1 })).toThrow("standoff(): 'height' must be at least 0, got -1");
  });

  it("names a class no builder registered by its plain id", () => {
    class Bare extends Feature {
      static id = 'bare';
      buildTool(): Shape[] {
        return [];
      }
    }
    const host = new FakeHost();
    host.install();
    const bare = host.evaluate('@acme/kit', () => new Bare({}));
    expect(bare.getType()).toBe('bare');
    expect(bare.getDisplayType()).toBe('Bare');
  });
});
