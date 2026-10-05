import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import translate from "../../core/translate.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { Shape } from "../../common/shape.js";
import { ShapeProps } from "../../oc/props.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { liveSolidsOf } from "../../helpers/live-solids.js";

// An explicit `.scope()` names the features that built its solids, and a
// solid moves on to whichever feature changes it next. These pin that the
// scope follows its solids there, for every scoped feature.

const W = 60;
const D = 20;
const BASE_T = 20;
const COVER_T = 8;
const BASE_VOLUME = W * D * BASE_T;
const COVER_VOLUME = W * D * COVER_T;

/** A 60 × 20 × 20 base with an 8 thick cover of the same footprint on top, a solid of its own. */
function coverOnBase(): { base: ExtrudeBase; cover: ExtrudeBase } {
  sketch("xy", () => {
    testRect(W, D, { at: [-W / 2, -D / 2] });
  });
  const base = extrude(BASE_T) as unknown as ExtrudeBase;
  sketch(base.endFaces(), () => {
    testRect(W, D, { at: [-W / 2, -D / 2] });
  });
  const cover = extrude(COVER_T).new() as unknown as ExtrudeBase;
  return { base, cover };
}

function volumeOf(shape: Shape): number {
  return ShapeProps.getProperties(shape.getShape()).volumeMm3;
}

function solidVolumes(scene: Scene): number[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes({}, 'solid'))
    .map(volumeOf)
    .sort((a, b) => a - b);
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getType()}: ${o.getError()}`] : []);
}

describe("an explicit scope follows its solids", () => {
  setupOC();

  it("repeats a scoped cut, every copy cutting the solid the copy before it cut", () => {
    const { cover } = coverOnBase();
    sketch(cover.endFaces(), () => {
      testRect(4, 4, { at: [-22, -2] });
    });
    // Deeper than the cover: unscoped, it would pocket the base as well.
    cut(12).scope(cover);
    repeat("linear", "x", { count: 3, offset: 20 });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - 3 * 4 * 4 * COVER_T, 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME, 3);
  });

  it("fuses a scoped extrude into the solid an earlier cut holds", () => {
    const { cover } = coverOnBase();
    const pocket = sketch(cover.endFaces(), () => {
      testRect(4, 4, { at: [-22, -2] });
    });
    const boss = sketch(cover.endFaces(), () => {
      testRect(10, 10, { at: [5, -5] });
    });
    cut(4, pocket);
    extrude(5, boss).scope(cover);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - 4 * 4 * 4 + 10 * 10 * 5, 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME, 3);
  });

  it("follows a solid into the result it was fused into, not every solid the fuse made", () => {
    const { cover } = coverOnBase();
    sketch(cover.endFaces(), () => {
      // One boss on the cover, one off its footprint: the extrude holds both.
      testRect(10, 10, { at: [-25, -5] });
      testRect(10, 10, { at: [40, -5] });
    });
    extrude(5);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const live = liveSolidsOf(cover);
    expect(live).toHaveLength(1);
    expect(volumeOf(live[0].solid)).toBeCloseTo(COVER_VOLUME + 10 * 10 * 5, 3);
  });

  it("follows a solid moved together with another, to its own moved copy", () => {
    const { base, cover } = coverOnBase();
    translate(100, cover, base);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const live = liveSolidsOf(cover);
    expect(live).toHaveLength(1);
    expect(volumeOf(live[0].solid)).toBeCloseTo(COVER_VOLUME, 3);
  });
});
