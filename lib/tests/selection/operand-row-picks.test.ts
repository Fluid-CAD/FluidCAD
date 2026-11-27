import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { SceneObject } from "../../common/scene-object.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import type { PickRef } from "../../selection/types.js";
import { testRect } from "../helpers/profiles.js";

/**
 * One row of a curve or surface operand is synthesized on its own: the
 * rule names the first pick that is not of a kind the row's tool takes, or
 * not of the kind the row's first pick is.
 */
describe("an operand row's picks", () => {
  setupOC();

  /** A box written on line 2, rendered, and a pick maker over its solid. */
  function boxPicks(): { scene: ReturnType<typeof render>; pick: (type: PickRef['sub']['type'], index: number) => PickRef } {
    sketch("xy", () => {
      testRect(20, 10);
    });
    const box = extrude(5).new() as unknown as SceneObject;
    box.setSourceLocation({ filePath: "/ws/model.fluid.js", line: 2, column: 0 });
    const scene = render();
    const id = box.getShapes()[0].id;
    return { scene, pick: (type, index) => ({ shapeId: id, sub: { type, index } }) };
  }

  it("names the first edge after a face in a row of faces, not the row's first pick", () => {
    const { scene, pick } = boxPicks();
    const odd = pick("edge", 0);

    const result = synthesizeApplyFeature(scene, [pick("face", 0), pick("face", 1), odd, pick("edge", 1)], "intersection-curve");

    expect(result).toEqual({ ok: false, reason: "intersect takes faces — pick faces only", pick: odd });
  });

  it("names the row's first pick when it is of no kind the tool takes", () => {
    const { scene, pick } = boxPicks();
    const vertex = pick("vertex", 0);

    const result = synthesizeApplyFeature(scene, [vertex, pick("edge", 0)], "projected-curve");

    expect(result).toMatchObject({ ok: false, pick: vertex });
  });

  it("takes a row of one kind the tool takes, edges or faces alike", () => {
    const { scene, pick } = boxPicks();

    expect(synthesizeApplyFeature(scene, [pick("edge", 0)], "projected-curve").ok).toBe(true);
    expect(synthesizeApplyFeature(scene, [pick("face", 0)], "projected-curve").ok).toBe(true);
    expect(synthesizeApplyFeature(scene, [pick("face", 0), pick("edge", 1)], "projected-curve")).toMatchObject({ ok: false, pick: pick("edge", 1) });
  });
});
