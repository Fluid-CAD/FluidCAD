import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import { ShapeProps } from "../../oc/props.js";
import { testRect } from "../helpers/profiles.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { getFeatureMeta, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { Feature, defineFeature, parseCall, type FeatureBuildContext, type FeatureMeta } from "../../sdk/index.js";
import { Primitives, type Shape } from "../../sdk/kernel.js";
import { defineStandoff, defineStandoffWithMeta, STANDOFF_DEFAULTS, type StandoffDefinition, type StandoffVariant } from "../fixtures/custom-features/standoff.js";

const PLATE = { w: 60, d: 40, t: 10 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;
const TUBE = Math.PI * ((STANDOFF_DEFAULTS.outer / 2) ** 2 - (STANDOFF_DEFAULTS.hole / 2) ** 2) * STANDOFF_DEFAULTS.height;

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function solidVolumes(scene: Scene): number[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3)
    .sort((a, b) => a - b);
}

/** A 60 × 40 × 10 plate centred on the origin, its top face at z = 10. */
function plate(): ExtrudeBase {
  sketch("xy", () => {
    testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
  });
  return extrude(PLATE.t) as unknown as ExtrudeBase;
}

/** A tool that adds a cylinder at the origin: the least a `Feature.with()` class needs. */
function postClass() {
  return class Post extends Feature.with({ height: { type: 'length', default: 5, min: 0 } }) {
    static id = 'acme.post';
    buildTool(): Shape[] {
      return [Primitives.makeCylinder(2, this.values.height)];
    }
  };
}

describe("Feature.with()", () => {
  it("makes an abstract Feature base carrying the values, frozen", () => {
    const params = { height: { type: 'length', default: 5 }, size: { type: 'select', options: [{ label: 'M3', value: 'm3' }] } } as const;
    const Base = Feature.with(params);
    const Post = postClass();

    expect(Base.prototype).toBeInstanceOf(Feature);
    expect(Base.params).toEqual(params);
    expect(Base.params).not.toBe(params);
    expect(Object.isFrozen(Base.params)).toBe(true);
    expect(Object.isFrozen(Base.params.size.options[0])).toBe(true);
    expect(Object.getPrototypeOf(Post).params).toEqual({ height: { type: 'length', default: 5, min: 0 } });
    expect(Post.params).toBe(Object.getPrototypeOf(Post).params);
    // Each evaluation of a module makes its own base.
    expect(Feature.with(params)).not.toBe(Base);
  });

  it("keeps the values as declared when the author's object changes later", () => {
    const params = { height: { type: 'length', default: 5 } };
    const Base = Feature.with(params as { height: { type: 'length'; default: number } });
    params.height.default = 9;
    expect(Base.params.height.default).toBe(5);
  });

  it("refuses anything but an object of values by name", () => {
    for (const bad of [null, undefined, [], 'height', 5]) {
      expect(() => Feature.with(bad as never)).toThrow("Feature.with() takes the feature's values by name, such as { height: { type: 'length', default: 10 } }");
    }
  });

  it("still needs the subclass's static id", () => {
    class Unnamed extends Feature.with({ height: { type: 'length', default: 5 } }) {
      buildTool(): Shape[] {
        return [];
      }
    }
    expect(() => new Unnamed({ height: 5 })).toThrow("Unnamed needs a static id — the feature's type, such as 'standoff'");
  });
});

describe("defineFeature()", () => {
  it("registers the class with its values, its kind read from the class, and the metadata it is given", () => {
    const Post = postClass();
    const post = defineFeature(Post, { label: 'Post', group: 'create', operations: ['add', 'new'], call: [{ height: 'height' }] });
    const meta = getFeatureMeta(post)!;

    expect(meta.id).toBe('acme.post');
    expect(meta.class).toBe(Post);
    expect(meta.kind).toBe('tool');
    expect(meta.params).toEqual(Post.params);
    expect(meta.operations).toEqual(['add', 'new']);
    expect(meta.call).toEqual([{ height: 'height' }]);
  });

  it("reads a class that overrides build() as a modifier", () => {
    class Lift extends Feature.with({ distance: { type: 'length', default: 1 } }) {
      static id = 'acme.lift';
      override build(_ctx: FeatureBuildContext): void {}
    }
    const lift = defineFeature(Lift, { label: 'Lift', group: 'modify', call: ['distance'] });
    expect(getFeatureMeta(lift)!.kind).toBe('modifier');
  });

  it("gives the same snapshot as the whole metadata handed to registerBuilder", () => {
    const defined = snapshotFeatureMeta(defineStandoff().meta);
    const registered = snapshotFeatureMeta(defineStandoffWithMeta().meta);
    expect(defined).toEqual(registered);
    expect(defined.kind).toBe('tool');
    expect(Object.keys(defined.params)).toEqual(['face', 'height', 'outer', 'hole']);
  });

  it("refuses a class that declares no values, pointing at Feature.with()", () => {
    class Bare extends Feature {
      static id = 'acme.bare';
      buildTool(): Shape[] {
        return [];
      }
    }
    expect(() => defineFeature(Bare as never, { label: 'Bare', group: 'create', call: [] }))
      .toThrow("defineFeature(Bare): Bare declares no values — declare them with Feature.with({ … }): class Bare extends Feature.with({ height: { type: 'length' } })");
  });

  it("refuses what is no feature class, and metadata that isn't an object", () => {
    expect(() => defineFeature((() => undefined) as never, { label: 'X', group: 'create', call: [] }))
      .toThrow("defineFeature(): the first argument is the feature's class, one that extends Feature.with({ … }), got a function");
    expect(() => defineFeature({} as never, { label: 'X', group: 'create', call: [] }))
      .toThrow("defineFeature(): the first argument is the feature's class, one that extends Feature.with({ … }), got an object");
    expect(() => defineFeature(postClass(), null as never))
      .toThrow("defineFeature(Post): the second argument describes the feature, such as { label: 'Standoff', group: 'create', call: […] } — got null");
  });

  it.each([
    ['class', "the class is defineFeature()'s first argument"],
    ['params', "the values are the class's own, declared with Feature.with({ … })"],
    ['kind', 'it is read from the class: one that implements buildTool() is a tool, one that overrides build() a modifier'],
  ])("refuses '%s' in the metadata", (field, why) => {
    const meta = { label: 'Post', group: 'create', call: [{ height: 'height' }], [field]: 'tool' };
    expect(() => defineFeature(postClass(), meta as never)).toThrow(`defineFeature(Post): leave '${field}' out — ${why}`);
  });

  it("refuses a class that implements neither buildTool() nor build()", () => {
    class Empty extends Feature.with({ height: { type: 'length', default: 5 } }) {
      static id = 'acme.empty';
    }
    expect(() => defineFeature(Empty, { label: 'Empty', group: 'create', call: ['height'] }))
      .toThrow("defineFeature(Empty): Empty implements neither buildTool() nor build() — a tool returns its solids from buildTool(ctx), a modifier overrides build(ctx)");
  });

  it("checks the rest of the metadata as registerBuilder does", () => {
    expect(() => defineFeature(postClass(), { label: 'Post', group: 'creat' as never, call: ['height'] }))
      .toThrow("feature 'acme.post': 'group' must be one of create, modify, got 'creat'");
    expect(() => defineFeature(postClass(), { label: 'Post', group: 'create', call: ['heigth' as never] }))
      .toThrow("feature 'acme.post': the call shape names 'heigth', which is not one of the feature's values");
    const Shared = postClass();
    expect(() => defineFeature(Shared, { label: 'Post', group: 'create', call: [{ height: 'height' }], operations: ['cut' as never] }))
      .toThrow("feature 'acme.post': 'operations' must be one of add, new, remove, got 'cut'");
    expect(() => defineFeature(postClass(), { label: 'Post', group: 'create', call: [{ height: 'height' }], illustration: './post.svg' } as never))
      .toThrow("feature metadata: leave 'illustration' out — illustrations aren't supported (custom controls are planned)");
    expect(() => defineFeature(postClass(), { label: 'Post', group: 'create', call: [{ height: 'height' }], onChange: () => undefined } as never))
      .toThrow("feature metadata: leave 'onChange' out — onChange hooks aren't supported (custom controls are planned)");
  });

  it("refuses an edge value's tangents by name: tangent chains are for fillet and chamfer only", () => {
    class Rim extends Feature.with({ edges: { picker: 'edge', multiple: true, tangents: true } as never }) {
      static id = 'acme.rim';
      buildTool(): Shape[] {
        return [];
      }
    }
    expect(() => defineFeature(Rim, { label: 'Rim', group: 'create', call: ['...edges'] as never }))
      .toThrow("feature 'acme.rim': param 'edges': leave 'tangents' out — tangent chains are for fillet and chamfer only");
  });
});

describe("a defineFeature() feature called without its select and toggle", () => {
  setupOC();

  /** A post whose diameter is a select and whose height a toggle, neither with a default; an optional finish without one. */
  function definePost() {
    class Post extends Feature.with({
      size: { type: 'select', options: [{ label: 'Small', value: 4 }, { label: 'Large', value: 8 }] },
      tall: { type: 'boolean' },
      finish: { type: 'select', optional: true, options: [{ label: 'Low', value: 'low' }] },
    }) {
      static id = 'acme.post';
      buildTool(): Shape[] {
        const { size, tall, finish } = this.values;
        return [Primitives.makeCylinder(size / 2, tall ? 10 : finish === 'low' ? 1 : 3)];
      }
    }
    return defineFeature(Post, { label: 'Post', group: 'create', call: [{ size: 'size', tall: 'tall', finish: 'finish' }] });
  }

  it("builds on what the dialog shows untouched: the first option, the toggle off, no finish", () => {
    const post = definePost();
    const made = post();
    expect(made.values).toEqual({ size: 4, tall: false, finish: undefined });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)).toHaveLength(1);
    expect(solidVolumes(scene)[0]).toBeCloseTo(Math.PI * 2 ** 2 * 3, 3);
  });

  it("builds on what the call passes", () => {
    const post = definePost();
    expect(post({ size: 8, tall: true, finish: 'low' }).values).toEqual({ size: 8, tall: true, finish: 'low' });
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(Math.PI * 4 ** 2 * 10, 3);
  });
});

/** Both ways of writing the standoff, each held to the same behaviour. */
const AUTHORING_PATHS: [string, (variant?: StandoffVariant) => StandoffDefinition][] = [
  ['Feature.with() and defineFeature()', defineStandoff],
  ['a Feature subclass and registerBuilder()', defineStandoffWithMeta],
];

describe.each(AUTHORING_PATHS)("the standoff written with %s", (_path, define) => {
  setupOC();

  it("reads its call by its metadata: defaults filled, each value checked", () => {
    const { standoff } = define();
    const p = plate();
    const s = standoff(p.endFaces(), { height: 8 });
    expect(s.values).toEqual({ face: expect.anything(), ...STANDOFF_DEFAULTS, height: 8 });
    expect(() => standoff(p.endFaces(), { height: -1 })).toThrow("standoff(): 'height' must be at least 0, got -1");
    expect(() => standoff(p.endFaces(), { heigth: 4 } as never))
      .toThrow("standoff(): unknown option 'heigth' — the options are 'height', 'outer' and 'hole'");
    expect(() => (standoff as unknown as () => void)()).toThrow("standoff(): 'face' is required");
  });

  it("stands on the picked face, fused into the plate", () => {
    const { standoff } = define();
    const p = plate();
    const s = standoff(p.endFaces()) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(s.getType()).toBe('acme.standoff');
    expect(solidVolumes(scene)).toHaveLength(1);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME + TUBE, 3);
  });

  it("hits the render cache when the module is evaluated again, and misses when a value changes", () => {
    const first = define();
    const second = define();
    expect(first.Standoff).not.toBe(second.Standoff);

    const cachedAcross = (height: number): boolean => {
      const manager = getSceneManager();
      manager.startScene();
      first.standoff(plate().endFaces());
      render();
      const previous = manager.currentScene;
      const next = manager.startScene();
      const feature = second.standoff(plate().endFaces(), { height }) as unknown as SceneObject;
      SceneCompare.compare(previous, next);
      const cached = next.isCached(feature);
      expect(errorsOf(render())).toEqual([]);
      return cached;
    };
    expect(cachedAcross(STANDOFF_DEFAULTS.height)).toBe(true);
    expect(cachedAcross(12)).toBe(false);
  });

  it("repeats along a line, each copy fused into the one plate", () => {
    const { standoff } = define();
    const s = standoff(plate().endFaces()) as unknown as SceneObject;
    repeat("linear", "x", { count: 3, offset: 15 }, s);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)).toHaveLength(1);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME + 3 * TUBE, 2);
  });

  it("copies a new() standoff as a solid of its own per slot", () => {
    const { standoff } = define();
    const s = (standoff(plate().endFaces()) as unknown as SceneObject).new();
    copy("linear", "y", { count: 3, offset: 12 }, s);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene).filter(v => Math.abs(v - TUBE) < 1e-3)).toHaveLength(3);
  });

  it("applies its default operation without a chain, a repeat's copies too, and refuses one it doesn't offer", () => {
    const { standoff, meta } = define({ operations: ['new'] });
    expect(meta.defaultOperation).toBe('new');
    const s = standoff(plate().endFaces()) as unknown as SceneObject;
    repeat("linear", "x", { count: 3, offset: 15 }, s);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)).toHaveLength(4);
    expect(solidVolumes(scene).filter(v => Math.abs(v - TUBE) < 1e-3)).toHaveLength(3);

    const added = (define({ operations: ['new'] }).standoff(plate().endFaces()) as unknown as SceneObject).add();
    render();
    expect(added.getError()).toBe("standoff(): .add() is not an operation this feature offers — it offers 'new'; 'new' is its default and needs no chain");
  });
});

describe("a custom feature's timeline row", () => {
  setupOC();

  /** A ring of nothing: a tool whose id's last segment reads differently from its label. */
  function boltCircleClass() {
    return class BoltCircle extends Feature.with({ count: { type: 'integer', default: 4, min: 1 } }) {
      static id = 'acme.boltCircle';
      buildTool(): Shape[] {
        return [Primitives.makeCylinder(1, this.values.count)];
      }
    };
  }

  it("reads the metadata's label with defineFeature()", () => {
    const boltCircle = defineFeature(boltCircleClass(), { label: 'Bolt circle', group: 'create', call: [{ count: 'count' }] });
    const row = boltCircle() as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(row.getDisplayType()).toBe('Bolt circle');
    expect(scene.getRenderedObject(row)!.name).toBe('Bolt circle 1');
  });

  it("reads the metadata's label with registerBuilder()", () => {
    const BoltCircle = boltCircleClass();
    const meta: FeatureMeta = {
      class: BoltCircle, label: 'Bolt circle', group: 'create', kind: 'tool', params: BoltCircle.params, call: [{ count: 'count' }],
    };
    const boltCircle = registerBuilder(context => (...args: unknown[]) => new BoltCircle(parseCall(meta, args) as never).addTo(context), { feature: meta });
    const row = boltCircle() as unknown as SceneObject;
    const scene = render();

    expect(scene.getRenderedObject(row)!.name).toBe('Bolt circle 1');
  });

  it("falls back to the id's last segment for a class no builder registered, and a name() still wins", () => {
    const BoltCircle = boltCircleClass();
    expect(new BoltCircle({ count: 4 }).getDisplayType()).toBe('BoltCircle');

    const boltCircle = defineFeature(boltCircleClass(), { label: 'Bolt circle', group: 'create', call: [{ count: 'count' }] });
    const named = (boltCircle() as unknown as SceneObject).name('Fan mount');
    const scene = render();
    expect(scene.getRenderedObject(named)!.name).toBe('Fan mount');
  });
});

describe("a defineFeature() feature with a radio", () => {
  it("fills a radio left out with its first option, leaves an optional one unset, and refuses a value that is no option", () => {
    const options = [{ label: 'Plain', value: 'plain' }, { label: 'Counterbore', value: 'counterbore', image: './cbore.svg' }] as const;
    class Hole extends Feature.with({
      head: { type: 'radio', display: 'cards', columns: 2, options },
      finish: { type: 'radio', optional: true, options },
    }) {
      static id = 'acme.hole';
      buildTool(): Shape[] {
        return [];
      }
    }
    const hole = defineFeature(Hole, { label: 'Hole', group: 'create', call: [{ head: 'head', finish: 'finish' }] });
    const meta = getFeatureMeta(hole)!;

    expect(meta.params.head).toEqual({ type: 'radio', display: 'cards', columns: 2, options, default: 'plain' });
    expect(parseCall(meta, [])).toEqual({ head: 'plain', finish: undefined });
    const head: 'plain' | 'counterbore' = new Hole({ head: 'counterbore', finish: undefined }).values.head;
    expect(head).toBe('counterbore');
    expect(() => parseCall(meta, [{ head: 'pan' }])).toThrow(`hole(): 'head' must be one of "plain", "counterbore", got 'pan'`);
  });
});

describe("defineFeature() with a layout", () => {
  function plateClass(values: Record<string, unknown> = {}) {
    return class Plate extends Feature.with({
      face: { picker: 'face' },
      width: { type: 'length', default: 20 },
      depth: { type: 'length', default: 10 },
      ...values,
    }) {
      static id = 'acme.plate';
      buildTool(): Shape[] {
        return [];
      }
    };
  }
  const CALL = ['face', { width: 'width', depth: 'depth' }] as const;

  it("lays the dialog out over the class's values, with a width and an aside", () => {
    const layout = ['face', { section: 'Size', items: [{ row: ['width', 'depth'] }] }] as const;
    const plate = defineFeature(plateClass(), {
      label: 'Plate', group: 'create', call: CALL, width: 'wide', layout,
      aside: [{ image: './plate-dims.svg', alt: 'Width and depth' }],
    });
    const meta = getFeatureMeta(plate)!;
    expect(meta.layout).toEqual(layout);
    expect(meta.width).toBe('wide');
    expect(snapshotFeatureMeta(meta).aside).toEqual([{ image: './plate-dims.svg', alt: 'Width and depth' }]);
  });

  it("derives the layout from the values' group and tab when none is given", () => {
    const plate = defineFeature(plateClass({ width: { type: 'length', default: 20, group: 'Size' }, depth: { type: 'length', default: 10, group: 'Size' } }), {
      label: 'Plate', group: 'create', call: CALL,
    });
    expect(getFeatureMeta(plate)!.layout).toEqual(['face', { section: 'Size', items: ['width', 'depth'] }]);
  });

  it("refuses a layout that misplaces a value, and a value's group beside a layout", () => {
    const define = (featureClass: ReturnType<typeof plateClass>, layout: unknown) => () => getFeatureMeta(defineFeature(featureClass, {
      label: 'Plate', group: 'create', call: CALL, layout: layout as ['face'],
    }));
    expect(define(plateClass(), ['face', 'width'])).toThrow("feature 'acme.plate': the value 'depth' has no place in the layout");
    expect(define(plateClass({ depth: { type: 'length', default: 10, group: 'Size' } }), ['face', 'width', 'depth']))
      .toThrow("feature 'acme.plate': param 'depth': leave 'group' out — the layout places it");
  });
});
