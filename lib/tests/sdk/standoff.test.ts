import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import copy from "../../core/copy.js";
import select from "../../core/select.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { SceneObject } from "../../common/scene-object.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from "../../selection/resolve-selection.js";
import type { PickRef } from "../../selection/types.js";
import type { ISelection } from "../../core/interfaces.js";
import { setLocation } from "../selection/pick-helpers.js";
import { defineStandoff, Standoff, standoff, STANDOFF_DEFAULTS, type StandoffFunction, type StandoffOptions } from "../fixtures/custom-features/standoff.js";
import { Feature } from "../../sdk/index.js";

const PLATE = { w: 60, d: 40, t: 10 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;

function tubeVolume({ height, outer, hole }: typeof STANDOFF_DEFAULTS): number {
  return Math.PI * ((outer / 2) ** 2 - (hole / 2) ** 2) * height;
}

const TUBE = tubeVolume(STANDOFF_DEFAULTS);

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

function solidBounds(scene: Scene) {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => ShapeOps.getExactBoundingBox(sh));
}

/** A lazy accessor's shapes — built here the way a consuming statement would build it. */
function resolved(selection: ISelection): unknown[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

/** A 60 × 40 × 10 plate centred on the origin, its top face at z = 10. */
function plate(): ExtrudeBase {
  sketch("xy", () => {
    testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
  });
  return extrude(PLATE.t) as unknown as ExtrudeBase;
}

/** The plate with a standoff on its top face; `as` builds it with another definition of the class. */
function plateWithStandoff(options: StandoffOptions = {}, as: StandoffFunction = standoff) {
  const p = plate();
  const s = as(p.endFaces(), options) as unknown as SceneObject;
  return { plate: p, standoff: s };
}

describe("a custom feature: the standoff", () => {
  setupOC();

  it("stands on the picked face, fused into the plate", () => {
    const { standoff: s } = plateWithStandoff();
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(s.getType()).toBe('acme.standoff');
    expect(s.getDisplayType()).toBe('Standoff');
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toBeCloseTo(PLATE_VOLUME + TUBE, 3);
    const [bounds] = solidBounds(scene);
    expect(bounds.maxZ).toBeCloseTo(PLATE.t + STANDOFF_DEFAULTS.height, 6);
  });

  it("stands on a face whatever way it faces", () => {
    const p = plate();
    // The plate's -x side face: the standoff grows along -x from its centre.
    standoff(select(face().planar().onPlane("yz", -PLATE.w / 2)), { height: 8 });
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(p.getError()).toBeNull();
    const [bounds] = solidBounds(scene);
    expect(bounds.minX).toBeCloseTo(-PLATE.w / 2 - 8, 6);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME + tubeVolume({ ...STANDOFF_DEFAULTS, height: 8 }), 3);
  });

  it("keeps the selection it stands on readable, and only takes it off the screen", () => {
    plate();
    const picked = select(face().planar().onPlane("xy", PLATE.t));
    standoff(picked);
    const top = picked as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(top.getShapes()).toHaveLength(1);
    expect(top.getShapes(undefined, undefined, new Set(scene.getAllSceneObjects()))).toEqual([]);
  });

  it("refuses a value that is neither a scalar nor a scene object", () => {
    const p = plate();
    const values = { face: p.endFaces(), ...STANDOFF_DEFAULTS };
    expect(() => new Standoff({ ...values, height: (() => 4) as unknown as number }))
      .toThrow(/value 'height' is a function/);
    expect(() => new Standoff({ ...values, height: { mm: 4 } as unknown as number }))
      .toThrow(/value 'height' is a plain object/);
  });

  it("reads its call by its metadata: defaults filled, each value checked", () => {
    const p = plate();
    const s = standoff(p.endFaces(), { height: 8 });
    expect(s.values).toEqual({ face: expect.anything(), ...STANDOFF_DEFAULTS, height: 8 });
    expect(() => standoff(p.endFaces(), { height: (() => 4) as unknown as number }))
      .toThrow("standoff(): 'height' must be a number, got a function");
    expect(() => standoff(p.endFaces(), { height: -1 })).toThrow("standoff(): 'height' must be at least 0, got -1");
    expect(() => standoff(p.endFaces(), { heigth: 4 } as StandoffOptions))
      .toThrow("standoff(): unknown option 'heigth' — the options are 'height', 'outer' and 'hole'");
    expect(() => (standoff as unknown as () => void)()).toThrow("standoff(): 'face' is required");
    expect(() => standoff(5 as never)).toThrow(/standoff\(\): 'face' must be a scene object .*, got 5/);
  });

  it("reports a build failure on its own row", () => {
    plateWithStandoff({ outer: 3, hole: 4 });
    const scene = render();

    expect(errorsOf(scene)).toEqual(['acme.standoff: standoff: the hole (4) must be narrower than the boss (3)']);
  });
});

describe("the standoff's operations", () => {
  setupOC();

  it("adds by default, fusing into the solid it stands on", () => {
    plateWithStandoff();
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)).toHaveLength(1);
  });

  it("keeps a new() standoff a solid of its own", () => {
    const p = plate();
    (standoff(p.endFaces()) as unknown as SceneObject).new();
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(TUBE, 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);
  });

  /** The plate with a 20 mm block sitting on it, a new solid the standoff grows into. */
  function plateAndBlock(): { plate: ExtrudeBase; block: SceneObject } {
    const p = plate();
    sketch(p.endFaces(), () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    return { plate: p, block: extrude(20).new() as unknown as SceneObject };
  }

  /** The block with an 8 mm deep groove cut into it, and the plate as it was. */
  function expectGroovedBlock(scene: Scene): void {
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 20 - tubeVolume({ ...STANDOFF_DEFAULTS, height: 8 }), 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);
  }

  it("cuts a remove() standoff out of the solid in scope when its metadata offers remove", () => {
    const { standoff: cutting } = defineStandoff({ operations: ['add', 'new', 'remove'] });
    const { plate: p, block } = plateAndBlock();
    const s = (cutting(p.endFaces(), { height: 8 }) as unknown as SceneObject).remove().scope(block);
    const scene = render();

    expectGroovedBlock(scene);
    // The cut classifies its rims from the start plane: two circles where
    // the tool enters the block, two at the groove's floor.
    const feature = s as unknown as { startEdges(): ISelection; endEdges(): ISelection };
    expect(resolved(feature.startEdges())).toHaveLength(2);
    expect(resolved(feature.endEdges())).toHaveLength(2);
  });

  it("refuses an operation its metadata doesn't offer, as a build error on its own row", () => {
    const p = plate();
    const s = (standoff(p.endFaces()) as unknown as SceneObject).remove();
    const scene = render();

    expect(s.getError()).toBe("standoff(): .remove() is not an operation this feature offers — it offers 'add' and 'new'; 'add' is its default and needs no chain");
    expect(errorsOf(scene)).toHaveLength(1);
    expect(p.getError()).toBeNull();
    expect(solidVolumes(scene)).toEqual([expect.closeTo(PLATE_VOLUME, 3)]);
  });

  it("cuts without a chain when remove is its only operation — remove is its default", () => {
    const { standoff: cutOnly } = defineStandoff({ operations: ['remove'] });
    const { plate: p, block } = plateAndBlock();
    const s = (cutOnly(p.endFaces(), { height: 8 }) as unknown as SceneObject).scope(block);
    expect(s.getOperationMode()).toBe('remove');
    expectGroovedBlock(render());
  });

  it("reads an explicit chain of its default operation as that operation, and refuses add", () => {
    const { standoff: cutOnly } = defineStandoff({ operations: ['remove'] });
    const { plate: p, block } = plateAndBlock();
    (cutOnly(p.endFaces(), { height: 8 }) as unknown as SceneObject).remove().scope(block);
    expectGroovedBlock(render());

    const { standoff: again } = defineStandoff({ operations: ['remove'] });
    const q = plate();
    const added = (again(q.endFaces()) as unknown as SceneObject).add();
    const scene = render();
    expect(added.getError()).toBe("standoff(): .add() is not an operation this feature offers — it offers 'remove'; 'remove' is its default and needs no chain");
    expect(q.getError()).toBeNull();
  });

  it("keeps a standoff apart without a chain when new is its default", () => {
    const { standoff: apart } = defineStandoff({ operations: ['new', 'remove'] });
    const p = plate();
    const s = apart(p.endFaces()) as unknown as SceneObject;
    expect(s.getOperationMode()).toBe('new');
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(TUBE, 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);
  });

  it("adds by default when no builder registered its class", () => {
    const { Standoff: Registered } = defineStandoff({ operations: ['remove'] });
    class Unregistered extends Feature.with({ face: { picker: 'face' } }) {
      static id = 'acme.unregistered';
    }
    const p = plate();
    expect(new Registered({ face: p.endFaces(), ...STANDOFF_DEFAULTS }).getOperationMode()).toBe('remove');
    expect(new Unregistered({ face: p.endFaces() }).getOperationMode()).toBe('add');
  });
});

describe("the standoff in the render cache", () => {
  setupOC();

  /**
   * Render `first`, then compare a scene authored by `second` against it:
   * whether the standoff is cached. The second render reports `errors`.
   */
  function cachedAcross(first: () => SceneObject, second: () => SceneObject, errors: string[] = []): boolean {
    const manager = getSceneManager();
    first();
    render();
    const previous = manager.currentScene;

    const next = manager.startScene();
    const feature = second();
    SceneCompare.compare(previous, next);
    const cached = next.isCached(feature);
    expect(errorsOf(render())).toEqual(errors);
    return cached;
  }

  it("hits when the class is defined again, as a re-evaluated module defines it", () => {
    const first = defineStandoff();
    const second = defineStandoff();
    expect(first.Standoff).not.toBe(second.Standoff);

    expect(cachedAcross(
      () => plateWithStandoff({}, first.standoff).standoff,
      () => plateWithStandoff({}, second.standoff).standoff,
    )).toBe(true);
  });

  it.each([
    ['height', { height: 12 }],
    ['outer', { outer: 7 }],
    ['hole', { hole: 2 }],
  ] as const)("misses when the %s changes", (_name, change) => {
    expect(cachedAcross(
      () => plateWithStandoff().standoff,
      () => plateWithStandoff(change).standoff,
    )).toBe(false);
  });

  it("misses when the face changes", () => {
    expect(cachedAcross(
      () => plateWithStandoff().standoff,
      () => {
        const p = plate();
        return standoff(p.startFaces()) as unknown as SceneObject;
      },
    )).toBe(false);
  });

  it("misses when the operation changes", () => {
    expect(cachedAcross(
      () => plateWithStandoff().standoff,
      () => plateWithStandoff().standoff.new(),
    )).toBe(false);
  });

  it("misses when the default operation changes under a statement without a chain", () => {
    expect(cachedAcross(
      () => plateWithStandoff().standoff,
      () => plateWithStandoff({}, defineStandoff({ operations: ['new'] }).standoff).standoff,
    )).toBe(false);
  });

  it("hits when a statement spells out the default operation it applied without a chain", () => {
    expect(cachedAcross(
      () => plateWithStandoff({}, defineStandoff({ operations: ['new'] }).standoff).standoff,
      () => plateWithStandoff({}, defineStandoff({ operations: ['new'] }).standoff).standoff.new(),
    )).toBe(true);
  });

  it("misses when the metadata stops offering the operation the statement chose", () => {
    expect(cachedAcross(
      () => plateWithStandoff().standoff.new(),
      () => plateWithStandoff({}, defineStandoff({ operations: ['add'] }).standoff).standoff.new(),
      ["acme.standoff: standoff(): .new() is not an operation this feature offers — it offers 'add'; 'add' is its default and needs no chain"],
    )).toBe(false);
  });
});

describe("the standoff under repeat and copy", () => {
  setupOC();

  it("repeats along a line, each copy fused into the one plate", () => {
    const { standoff: s } = plateWithStandoff();
    repeat("linear", "x", { count: 3, offset: 15 }, s);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toBeCloseTo(PLATE_VOLUME + 3 * TUBE, 2);
    // The plate is never copied with the face the standoff stands on.
    expect(scene.getAllSceneObjects().filter(o => o.getType() === 'extrude')).toHaveLength(1);
  });

  it("mirrors, its copy standing where the mirror puts it", () => {
    const p = plate();
    const s = standoff(p.endFaces()) as unknown as SceneObject;
    // Off the plate's centre, so the mirror lands it somewhere else.
    const moved = repeat("linear", "x", { count: 2, offset: 20 }, s);
    repeat("mirror", "xz", moved);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME + 2 * TUBE, 2);
  });

  it("keeps its buckets on every repeated copy", () => {
    const { standoff: s } = plateWithStandoff();
    const r = repeat("linear", "x", { count: 2, offset: 15 }, s) as unknown as {
      instance(k: number): { endEdges(): ISelection };
    };
    fillet(0.5, r.instance(1).endEdges());
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeLessThan(PLATE_VOLUME + 2 * TUBE);
  });

  it("copies a new() standoff as a solid of its own per slot", () => {
    const p = plate();
    const s = (standoff(p.endFaces()) as unknown as SceneObject).new();
    copy("linear", "y", { count: 3, offset: 12 }, s);
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes.filter(v => Math.abs(v - TUBE) < 1e-3)).toHaveLength(3);
  });
});

describe("the standoff's buckets", () => {
  setupOC();

  function resolveOk(scene: Scene, request: ResolveSelectionRequest): Extract<ResolveSelectionResult, { ok: true }> {
    const result = SelectionResolver.resolve(scene, request, {});
    expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
    return result as Extract<ResolveSelectionResult, { ok: true }>;
  }

  function pickWhere(scene: Scene, expression: string, where: (m: ResolvedSelectionMatch) => boolean): PickRef {
    const hits = resolveOk(scene, { expression }).matches.filter(where);
    expect(hits).toHaveLength(1);
    return { shapeId: hits[0].shapeId, sub: { type: hits[0].kind, index: hits[0].index } };
  }

  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

  it("classifies its faces and edges, carried across the fusion", () => {
    const { standoff: s } = plateWithStandoff();
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const feature = s as unknown as Record<string, () => ISelection>;
    // The start annulus merged into the plate's top face: re-homed there.
    expect(resolved(feature.startFaces())).toHaveLength(1);
    expect(resolved(feature.endFaces())).toHaveLength(1);
    expect(resolved(feature.sideFaces())).toHaveLength(1);
    expect(resolved(feature.internalFaces())).toHaveLength(1);
    expect(resolved(feature.endEdges())).toHaveLength(2);
    expect(resolved(feature.startEdges())).toHaveLength(2);
  });

  it("takes a downstream fillet on its end edges", () => {
    const { standoff: s } = plateWithStandoff();
    const before = render();
    const unfilleted = solidVolumes(before)[0];

    const manager = getSceneManager();
    manager.startScene();
    const again = plateWithStandoff();
    fillet(0.5, (again.standoff as unknown as { endEdges(): ISelection }).endEdges());
    const scene = render();

    expect(s.getError()).toBeNull();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeLessThan(unfilleted);
  });

  it("is indexed: a pick on its top rim is written through endEdges()", () => {
    const p = plate();
    setLocation(p, 2);
    const s = standoff(p.endFaces());
    setLocation(s, 3);
    const scene = render();
    expect(errorsOf(scene)).toEqual([]);

    const rim = pickWhere(scene, 'edge().circle()', m =>
      near(m.summary.center![2], PLATE.t + STANDOFF_DEFAULTS.height) && near(m.summary.diameter!, STANDOFF_DEFAULTS.outer));
    const result = resolveOk(scene, { picks: [rim] });
    const synthesized = result.synthesized!;
    expect(synthesized.ok, synthesized.ok === false ? synthesized.reason : '').toBe(true);
    const ok = synthesized as Extract<typeof synthesized, { ok: true }>;
    expect(ok.parts[0].accessor).toBe('endEdges');
    expect(ok.parts[0].producer).toBe((s as unknown as SceneObject).id);
  });
});
