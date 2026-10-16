import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import repeat from "../../../core/repeat.js";
import copy from "../../../core/copy.js";
import part from "../../../core/part.js";
import { line, circle, spline, bezier } from "../../../core/2d/index.js";
import { countShapes, getBoundingBoxOfShapes } from "../../utils.js";
import { Scene } from "../../../rendering/scene.js";
import { SceneObject } from "../../../common/scene-object.js";
import { ControlPointCurve } from "../../../features/2d/control-point-curve.js";
import { SolvedLine } from "../../../features/2d/solved/line.js";
import { SolvedPointRef } from "../../../features/2d/solved/refs.js";
import { Solid } from "../../../common/solid.js";

type Curve = 'spline' | 'bezier';

/** One gear-tooth-like profile, its flanks drawn with the curve under test. */
function tooth(curve: Curve) {
  const draw = curve === 'spline' ? spline : bezier;
  sketch("xy", () => {
    draw([13, -2.8], [14.25, -2.8], [18, -2.35], [21, -1.35]);
    line([21, -1.35], [21, 1.35]);
    draw([21, 1.35], [18, 2.35], [14.25, 2.8], [13, 2.8]);
    line([13, 2.8], [13, -2.8]);
  });
  return extrude(8);
}

function expectNoErrors(scene: Scene) {
  const errored = scene.getAllSceneObjects().filter(o => o.getError());
  expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
}

function solids(scene: Scene): Solid[] {
  return scene.getAllSceneObjects().flatMap(o => o.getShapes()).filter((s): s is Solid => s instanceof Solid);
}

describe("repeat / copy of a sketch holding a control-point curve", () => {
  setupOC();

  for (const curve of ['spline', 'bezier'] as Curve[]) {
    describe(curve, () => {
      it("repeats circularly around z", () => {
        tooth(curve);
        repeat("circular", "z", { count: 4, angle: 360 });

        const scene = render();
        expectNoErrors(scene);
        expect(countShapes(scene)).toBe(4);
        // The instance a half turn on sits on the negative x side.
        const boxes = solids(scene).map(s => getBoundingBoxOfShapes([s]));
        expect(boxes.some(b => b.maxX < -12 && b.minX > -22)).toBe(true);
      });

      it("repeats linearly along x", () => {
        tooth(curve);
        repeat("linear", "x", { count: 2, offset: 30 });

        const scene = render();
        expectNoErrors(scene);
        expect(countShapes(scene)).toBe(2);
        const boxes = solids(scene).map(s => getBoundingBoxOfShapes([s]));
        expect(boxes.some(b => b.minX > 42 && b.maxX < 52)).toBe(true);
      });

      it("copies as a solid", () => {
        const e = tooth(curve);
        copy("linear", "x", { count: 2, offset: 30 }, e);

        const scene = render();
        expectNoErrors(scene);
        expect(countShapes(scene)).toBe(2);
      });
    });
  }

  it("builds the gear from the bug report (part-wrapped, 12 spline teeth)", () => {
    part("Gear", () => {
      sketch("xy", () => {
        circle([0, 0], 28);
      });
      extrude(8);
      tooth("spline");
      repeat("circular", "z", { count: 12, angle: 360 });
    });

    const scene = render();
    expectNoErrors(scene);
    // The part fuses hub and teeth into one body; the eleven cloned tooth
    // sketches are there (two spline flanks each) and built without error.
    expect(countShapes(scene)).toBe(1);
    const flanks = scene.getAllSceneObjects().filter(o => o instanceof ControlPointCurve);
    expect(flanks).toHaveLength(2 * 12);
    expect(flanks.every(f => f.getShapes().length === 1)).toBe(true);
  });

  it("re-points an accessor-valued control point at the cloned owner", () => {
    let original: ControlPointCurve;
    let originalLine: SolvedLine;
    sketch("xy", () => {
      originalLine = line([0, 0], [20, 0]) as unknown as SolvedLine;
      original = spline(originalLine.end(), [30, 10], [40, 0], [20, -10]) as unknown as ControlPointCurve;
      line([20, -10], [0, 0]);
    });
    extrude(5);
    repeat("linear", "x", { count: 2, offset: 60 });

    const scene = render();
    expectNoErrors(scene);
    expect(countShapes(scene)).toBe(2);

    const clones = scene.getAllSceneObjects().filter(
      (o): o is ControlPointCurve => o instanceof ControlPointCurve && o !== original,
    );
    expect(clones).toHaveLength(1);
    const clonedStart = clones[0].controlPoints[0];
    expect(clonedStart).toBeInstanceOf(SolvedPointRef);
    const owner = (clonedStart as SolvedPointRef).owner;
    expect(owner).toBeInstanceOf(SolvedLine);
    expect(owner).not.toBe(originalLine!);
    expect(owner.getParent()).toBe(clones[0].getParent());
    // The clone still reads the same solved anchor positions as the source.
    expect(clones[0].controlSources()).toEqual(original!.controlSources());
  });
});
