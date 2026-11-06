import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { AssemblyCompare } from "../../rendering/assembly-compare.js";
import { AssemblyScene } from "../../rendering/assembly-scene.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Part } from "../../features/part.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { testRect } from "../helpers/profiles.js";
import { ShapeProps } from "../../oc/props.js";
import { Primitives, ShapeOps, type Shape } from "../../sdk/kernel.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { Matrix4 } from "../../math/index.js";

// A feature module saved with new code: the render that follows rebuilds the
// statements of the features it defines, though their values match the
// cached ones. The server tells the compare which feature types changed
// (`rebuild`); everything before the first of them stays cached, as the
// prefix match always keeps it, and nothing changes when it names none.

const BASE = { side: 20, height: 10 };
const POST_RADIUS = 2;
const PAD_RADIUS = 4;

/**
 * One evaluation of a post module: a Ø4 post standing on the prism's top,
 * its height plus `extra` tall. Saving the module with other code is a new
 * evaluation — `extra` stands for that code edit, while the statement's
 * values stay the same.
 */
function definePost(extra = 0) {
  class Post extends Feature.with({ height: { type: 'length', default: 5, min: 0 } }) {
    static id = 'acme.post';

    buildTool(): Shape[] {
      const post = Primitives.makeCylinder(POST_RADIUS, this.values.height + extra);
      const placed = ShapeOps.transform(post, Matrix4.fromTranslation(0, 0, BASE.height));
      post.dispose();
      return [placed];
    }
  }
  return defineFeature(Post, { label: 'Post', group: 'create', call: ['height'] });
}

/** Another workspace feature, unchanged: a Ø8 pad under the prism, `thickness` thick. */
function definePad() {
  class Pad extends Feature.with({ thickness: { type: 'length', default: 1, min: 0 } }) {
    static id = 'acme.pad';

    buildTool(): Shape[] {
      const pad = Primitives.makeCylinder(PAD_RADIUS, this.values.thickness);
      const placed = ShapeOps.transform(pad, Matrix4.fromTranslation(0, 0, -this.values.thickness));
      pad.dispose();
      return [placed];
    }
  }
  return defineFeature(Pad, { label: 'Pad', group: 'create', call: ['thickness'] });
}

/** A 20 × 20 × 10 prism centred on the origin. */
function prism(): SceneObject {
  sketch("xy", () => {
    testRect(BASE.side, BASE.side, { at: [-BASE.side / 2, -BASE.side / 2] });
  });
  return extrude(BASE.height) as unknown as SceneObject;
}

/** A block well away from the prism: a statement after the post. */
function block(): SceneObject {
  sketch("xy", () => {
    testRect(5, 5, { at: [40, 40] });
  });
  return extrude(5) as unknown as SceneObject;
}

/** The model: the prism, a pad under it, the post on it, then a block of its own. */
function model(post: ReturnType<typeof definePost>, pad: ReturnType<typeof definePad>) {
  const base = prism();
  const padded = pad(1) as unknown as SceneObject;
  const posted = post(5) as unknown as SceneObject;
  const after = block();
  return { base, padded, posted, after };
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getUniqueType()}: ${o.getError()}`] : []);
}

function totalVolume(scene: Scene): number {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .reduce((sum, sh) => sum + ShapeProps.getProperties(sh.getShape()).volumeMm3, 0);
}

const PRISM_VOLUME = BASE.side * BASE.side * BASE.height;
const PAD_VOLUME = Math.PI * PAD_RADIUS ** 2;
const BLOCK_VOLUME = 5 * 5 * 5;
const postVolume = (height: number) => Math.PI * POST_RADIUS ** 2 * height;

describe("a feature module saved with new code", () => {
  setupOC();

  it("is served from the cache when nobody says its code changed — its values are the same", () => {
    const manager = getSceneManager();
    model(definePost(0), definePad());
    const first = render();
    expect(errorsOf(first)).toEqual([]);
    expect(totalVolume(first)).toBeCloseTo(PRISM_VOLUME + PAD_VOLUME + postVolume(5) + BLOCK_VOLUME, 3);

    const next = manager.startScene();
    const objects = model(definePost(5), definePad());
    SceneCompare.compare(first, next);
    expect(next.isCached(objects.posted)).toBe(true);
    // The old post, 5 tall, though the new code builds it 10 tall.
    expect(totalVolume(render())).toBeCloseTo(PRISM_VOLUME + PAD_VOLUME + postVolume(5) + BLOCK_VOLUME, 3);
  });

  it("rebuilds the features its compare is told changed, and keeps what comes before them cached", () => {
    const manager = getSceneManager();
    model(definePost(0), definePad());
    const first = render();

    const next = manager.startScene();
    const objects = model(definePost(5), definePad());
    manager.compare(first, next, undefined, { rebuild: new Set(["acme.post"]) });

    // The prism (built-ins) and the pad (another custom feature) stand before
    // the post: cached. The post rebuilds, and the block after it with it —
    // the cache is a prefix.
    expect(next.isCached(objects.base)).toBe(true);
    expect(next.isCached(objects.padded)).toBe(true);
    expect(next.isCached(objects.posted)).toBe(false);
    expect(next.isCached(objects.after)).toBe(false);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(totalVolume(scene)).toBeCloseTo(PRISM_VOLUME + PAD_VOLUME + postVolume(10) + BLOCK_VOLUME, 3);
  });

  it("changes nothing when the types it names are not in the scene", () => {
    const manager = getSceneManager();
    model(definePost(0), definePad());
    const first = render();

    const next = manager.startScene();
    const objects = model(definePost(0), definePad());
    manager.compare(first, next, undefined, { rebuild: new Set(["acme.elsewhere"]) });
    for (const obj of Object.values(objects)) {
      expect(next.isCached(obj)).toBe(true);
    }
    expect(errorsOf(render())).toEqual([]);
  });

  it("rebuilds the part that holds one in an assembly, and keeps the others", () => {
    function assembly(post: ReturnType<typeof definePost>): AssemblyScene {
      const scene = getSceneManager().startAssemblyScene();
      const holder = part("Holder", () => {
        prism();
        post(5);
      });
      const plain = part("Plain", () => {
        prism();
      });
      insert(holder);
      insert(plain);
      return scene;
    }
    const topPart = (scene: AssemblyScene, name: string): Part => scene.getAllSceneObjects().find(
      o => o instanceof Part && o.getParent() === null && o.partName === name,
    ) as Part;

    const before = assembly(definePost(0));
    const unchanged = AssemblyCompare.compare(before, assembly(definePost(5)));
    expect(unchanged.isCached(topPart(unchanged, "Holder"))).toBe(true);

    const after = AssemblyCompare.compare(before, assembly(definePost(5)), undefined, { rebuild: new Set(["acme.post"]) });
    expect(after.isCached(topPart(after, "Holder"))).toBe(false);
    for (const child of topPart(after, "Holder").getChildren()) {
      expect(after.isCached(child)).toBe(false);
    }
    expect(after.isCached(topPart(after, "Plain"))).toBe(true);
  });
});
