import { afterEach, describe, expect, it, vi } from "vitest";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import sweep from "../../core/sweep.js";
import { circle, line } from "../../core/2d/index.js";
import { fix } from "../../core/constraints/index.js";
import type { Extrude } from "../../features/extrude.js";
import type { Sweep } from "../../features/sweep.js";
import { getOC } from "../../oc/init.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { render, setupOC } from "../setup.js";

afterEach(() => vi.restoreAllMocks());

function stock(x = 0) {
  const profile = sketch("xy", () => { circle([x, 0], 4); });
  return extrude(5, profile).new() as Extrude;
}

function remove(x: number, diameter: number) {
  const profile = sketch("xy", () => { circle([x, 0], diameter); });
  const path = sketch("xz", () => {
    const edge = line([x, 0], [x, 10]);
    fix(edge.start(), [x, 0]); fix(edge.end(), [x, 10]);
  });
  return sweep(path, profile).remove() as Sweep;
}

describe("validated sweep subtraction", () => {
  setupOC();

  it("accepts a disjoint cut and keeps its stock unchanged", () => {
    const original = stock();
    const cut = remove(20, 2);
    const scene = render();
    expect(cut.getError()).toBeNull();
    expect(cut.getShapes()).toHaveLength(0);
    const visible = original.getShapes({}, "solid", new Set(scene.getAllSceneObjects()));
    expect(visible).toHaveLength(1);
    expect(ShapeValidator.signedVolume(visible[0].getShape())).toBeCloseTo(20 * Math.PI, 6);
  });

  it("accepts complete removal and removes the stock from the scene", () => {
    const original = stock();
    const cut = remove(0, 8);
    const scene = render();
    expect(cut.getError()).toBeNull();
    expect(cut.getShapes()).toHaveLength(0);
    expect(original.getShapes({}, "solid", new Set(scene.getAllSceneObjects()))).toHaveLength(0);
  });

  it("removes one stock completely and preserves a disjoint second stock", () => {
    const removed = stock();
    const retained = stock(20);
    const cut = remove(0, 8);
    const scene = render();
    expect(cut.getError()).toBeNull();
    const scope = new Set(scene.getAllSceneObjects());
    expect(removed.getShapes({}, "solid", scope)).toHaveLength(0);
    expect(retained.getShapes({}, "solid", scope)).toHaveLength(1);
    expect(cut.getShapes()).toHaveLength(0);
  });

  it("rejects a failed native result check before replacing the stock", () => {
    const original = stock();
    const cut = remove(0, 2);
    // First native check is the cutter, second is the cut result.
    vi.spyOn(getOC().BRepAlgoAPI_Check.prototype, "HasErrors")
      .mockReturnValueOnce(false).mockReturnValueOnce(true);
    const scene = render();
    expect(String(cut.getError())).toMatch(/sweep cut result validation failed/);
    expect(original.getShapes({}, "solid", new Set(scene.getAllSceneObjects()))).toHaveLength(1);
    expect(cut.getShapes()).toHaveLength(0);
  });

  it("rejects an empty result whose history does not confirm stock removal", () => {
    const original = stock();
    const cut = remove(0, 8);
    vi.spyOn(getOC().BRepAlgoAPI_Cut.prototype, "IsDeleted").mockReturnValue(false);
    const scene = render();
    expect(String(cut.getError())).toMatch(/empty result without complete stock-removal history/);
    expect(original.getShapes({}, "solid", new Set(scene.getAllSceneObjects()))).toHaveLength(1);
  });

  it("does not adopt invalid cleanup geometry", () => {
    const original = stock();
    const cut = remove(0, 2);
    const cleanup = ShapeOps.cleanShapeWithLineage;
    vi.spyOn(ShapeOps, "cleanShapeWithLineage").mockImplementation((...args) => {
      const result = cleanup(...args);
      result.shape.getShape().Reverse();
      // Reverse mutates only the handle orientation; native shape identity
      // ignores it, so the validity gate must also compare orientation.
      return result;
    });
    const scene = render();
    expect(String(cut.getError())).toMatch(/sweep cut cleanup validation failed.*nonPositiveVolume/);
    expect(original.getShapes({}, "solid", new Set(scene.getAllSceneObjects()))).toHaveLength(1);
  });
});
