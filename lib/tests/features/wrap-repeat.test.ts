import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import wrap from "../../core/wrap.js";
import cylinder from "../../core/cylinder.js";
import select from "../../core/select.js";
import plane from "../../core/plane.js";
import repeat from "../../core/repeat.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Scene } from "../../rendering/scene.js";
import { ShapeProps } from "../../oc/props.js";

const CYLINDER_VOLUME = Math.PI * 25 * 25 * 80;
// Developed pad between radii 25 and 26, arc width 20, height 40:
// (s/R)/2 · ((R+t)² - R²) · h
const PAD_VOLUME = ((20 / 25) / 2) * (26 * 26 - 25 * 25) * 40;

function buildErrors(scene: Scene): { type: string; err: string | null }[] {
  return scene.getSceneObjects()
    .map(o => ({ type: o.getType(), err: o.getError() }))
    .filter(e => e.err);
}

function solidVolumes(scene: Scene): number[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3)
    .sort((a, b) => a - b);
}

/** Cylinder R=25 over z ∈ [0, 80] plus a sketch facing it on plane front+40. */
function setupWrapScene() {
  cylinder(25, 80);
  const s = sketch(plane("front", 40), () => {
    rect([-10, 50], 20, -40);
  });
  const f = select(face().cylinder());
  return { s, f };
}

describe("wrap under repeat", () => {
  setupOC();

  it("circular-repeats a wrap .new() pad onto the base cylinder", () => {
    const { s, f } = setupWrapScene();
    wrap(1, s, f).new();
    repeat("circular", "z", { count: 2, angle: 360 });

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(3);
    expect(volumes[0]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[1]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[2]).toBeCloseTo(CYLINDER_VOLUME, 0);
  });

  it("repeats across three instances without leaking earlier pads into the selection", () => {
    const { s, f } = setupWrapScene();
    wrap(1, s, f).new();
    repeat("circular", "z", { count: 3, angle: 360 });

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(4);
    expect(volumes[0]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[1]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[2]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[3]).toBeCloseTo(CYLINDER_VOLUME, 0);
  });

  it("circular-repeats an embossing wrap fused with the cylinder", () => {
    const { s, f } = setupWrapScene();
    wrap(1, s, f);
    repeat("circular", "z", { count: 2, angle: 360 });

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(1);
    expect(volumes[0]).toBeCloseTo(CYLINDER_VOLUME + 2 * PAD_VOLUME, 0);
  });

  it("repeats wrap together with an explicitly included cylinder", () => {
    const c = cylinder(25, 80);
    const s = sketch(plane("front", 40), () => {
      rect([-10, 50], 20, -40);
    });
    const f = select(face().cylinder());
    const w = wrap(1, s, f).new();
    repeat("circular", "z", { count: 2, angle: 180 },
      c as unknown as SceneObject, w as unknown as SceneObject);

    const scene = render();
    expect(buildErrors(scene)).toEqual([]);

    // original + cloned cylinder, original + cloned pad
    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(4);
    expect(volumes[0]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[1]).toBeCloseTo(PAD_VOLUME, 0);
    expect(volumes[2]).toBeCloseTo(CYLINDER_VOLUME, 0);
    expect(volumes[3]).toBeCloseTo(CYLINDER_VOLUME, 0);
  });
});
