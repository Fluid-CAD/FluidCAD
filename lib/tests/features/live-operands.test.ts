import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import mirror from "../../core/mirror.js";
import translate from "../../core/translate.js";
import rotate from "../../core/rotate.js";
import fuse from "../../core/fuse.js";
import subtract from "../../core/subtract.js";
import common from "../../core/common.js";
import copy from "../../core/copy.js";
import remove from "../../core/remove.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeOps } from "../../oc/shape-ops.js";

// A feature variable names the body it built wherever the features between
// left it. The breakpoint workflow makes this routine: paused after `f`, the
// user adds a fillet, and the fillet takes `f`'s solid — every later
// `mirror("xy", f)`, `translate(v, f)` or `fuse(f, g)` must still find the
// body, as `.scope(f)` always has.
describe("whole-feature operands follow their solid through later features", () => {
  setupOC();

  /** A box `f` filleted on top, then (inserted later) along its sides — `f` holds nothing after `f2`. */
  function filletedBox() {
    sketch("xy", () => { testRect(100, 50); });
    const e = extrude(30) as any;
    const f = fillet(3, e.endEdges()) as unknown as SceneObject;
    const f2 = fillet(2, select(edge().verticalTo("xy"))) as unknown as SceneObject;
    return { e: e as SceneObject, f, f2 };
  }

  function solidsOf(obj: SceneObject) {
    return obj.getShapes({}, "solid");
  }

  function sceneSolids(scene: Scene) {
    return scene.getAllSceneObjects().flatMap(obj => obj.getShapes({}, "solid"));
  }

  function errorsOf(scene: Scene): string[] {
    return scene.getAllSceneObjects().map(obj => obj.getError()).filter((e): e is string => !!e);
  }

  it("mirror(plane, f) reflects the body as the later fillet left it", () => {
    const { f, f2 } = filletedBox();
    const m = mirror("xz", f) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(f)).toHaveLength(0);
    expect(solidsOf(f2)).toHaveLength(0);
    // The fused reflection spans both halves and carries the side fillets.
    const [solid] = solidsOf(m);
    expect(solidsOf(m)).toHaveLength(1);
    const box = ShapeOps.getBoundingBox(solid);
    expect(box.maxY - box.minY).toBeCloseTo(100, 0);
    expect(sceneSolids(scene)).toHaveLength(1);
  });

  it("translate(v, f) moves the body out of the fillet that holds it", () => {
    const { f, f2 } = filletedBox();
    const t = translate([0, 0, 100], f) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(f2)).toHaveLength(0);
    expect(solidsOf(t)).toHaveLength(1);
    expect(ShapeOps.getBoundingBox(solidsOf(t)[0]).minZ).toBeCloseTo(100, 0);
    expect(sceneSolids(scene)).toHaveLength(1);
  });

  it("rotate(axis, angle, f) turns the body the later fillet holds", () => {
    const { f, f2 } = filletedBox();
    const r = rotate("x", 90, f) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(f2)).toHaveLength(0);
    expect(solidsOf(r)).toHaveLength(1);
    const box = ShapeOps.getBoundingBox(solidsOf(r)[0]);
    expect(box.maxZ - box.minZ).toBeCloseTo(50, 0);
    expect(sceneSolids(scene)).toHaveLength(1);
  });

  it.each(["fuse", "subtract", "common"] as const)("%s(f, g) reads f where the fillet left it", (op) => {
    const { f, f2 } = filletedBox();
    sketch("xy", () => { testRect(40, 40); });
    const g = extrude(80).new() as unknown as SceneObject;
    const b = (op === "fuse" ? fuse(f, g) : op === "subtract" ? subtract(f, g) : common(f, g)) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(f2)).toHaveLength(0);
    expect(solidsOf(g)).toHaveLength(0);
    expect(solidsOf(b).length).toBeGreaterThanOrEqual(1);
    expect(sceneSolids(scene)).toEqual(solidsOf(b));
  });

  it("copy(…, f) clones the body the later fillet holds and takes it from there", () => {
    const { f, f2 } = filletedBox();
    const c = copy("linear", "x", { count: 3, offset: 150 }, f) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(f2)).toHaveLength(0);
    expect(solidsOf(c)).toHaveLength(3);
    expect(sceneSolids(scene)).toHaveLength(3);
  });

  it("a body nothing stands for any more still fails, naming its taker", () => {
    sketch("xy", () => { testRect(100, 50); });
    const e = extrude(30) as unknown as SceneObject;
    remove(e);
    const m = mirror("xz", e) as unknown as SceneObject;
    render();

    expect(m.getError()).toMatch(/mirror: target 1 \(extrude\) has no shapes.*consumed by remove/);
  });

  it("a target that still holds its body is read as before", () => {
    sketch("xy", () => { testRect(100, 50); });
    const e = extrude(30) as unknown as SceneObject;
    const t = translate([0, 0, 100], e) as unknown as SceneObject;
    const scene = render();

    expect(errorsOf(scene)).toEqual([]);
    expect(solidsOf(e)).toHaveLength(0);
    expect(solidsOf(t)).toHaveLength(1);
    expect(sceneSolids(scene)).toHaveLength(1);
  });
});
