import { SceneObject } from "../../../common/scene-object.js";
import { Part } from "../../../features/part.js";
import { Scene } from "../../../rendering/scene.js";

/** A row with no geometry — the render's bookkeeping is what is under test. */
export class InertObject extends SceneObject {
  constructor(private readonly kind: string, private readonly container = false) {
    super();
  }

  build(): void {}

  isContainer(): boolean {
    return this.container;
  }

  getType(): string {
    return this.kind;
  }

  serialize() {
    return {};
  }
}

export type HeavyAssemblyOptions = {
  /** Part templates in the scene. */
  parts: number;
  /** Points of each part's constrained polygon — 3 rows per point. */
  polygonPoints: number;
  /**
   * Materialize the next part in the middle of each part's body, the way a
   * donor definition inserted mid-body does: its rows land between the
   * consumer's children in the flat list.
   */
  interleave?: boolean;
};

/**
 * The shape of scene an LLM-authored assembly produces — thousands of
 * sketch-internal rows, a handful of features — without any geometry, so it
 * builds in milliseconds at any size. Every row is marked cached: a render of
 * it is pure bookkeeping, which is what must stay linear in scene size.
 */
export function buildHeavyAssemblyScene(options: HeavyAssemblyOptions): Scene {
  const scene = new Scene();
  const add = (obj: SceneObject, parent: SceneObject | null): SceneObject => {
    if (parent) {
      parent.addChildObject(obj);
    }
    scene.addSceneObject(obj);
    scene.markCached(obj);
    return obj;
  };

  const heads: (() => void)[] = [];
  const tails: (() => void)[] = [];
  for (let p = 0; p < options.parts; p++) {
    const part = new Part(`part-${p}`);
    heads.push(() => {
      add(part, null);
      const sketch = add(new InertObject("sketch", true), part);
      for (let k = 0; k < options.polygonPoints; k++) {
        add(new InertObject("line"), sketch);
        add(new InertObject("fix"), sketch);
        add(new InertObject("coincident"), sketch);
      }
    });
    tails.push(() => {
      add(new InertObject("extrude"), part);
      add(new InertObject("fillet"), part);
    });
  }

  let headsEmitted = 0;
  for (let p = 0; p < options.parts; p++) {
    if (headsEmitted <= p) {
      heads[headsEmitted++]();
    }
    if (options.interleave && headsEmitted < options.parts) {
      heads[headsEmitted++]();
    }
    tails[p]();
  }
  add(new InertObject("extrude"), null);
  return scene;
}
