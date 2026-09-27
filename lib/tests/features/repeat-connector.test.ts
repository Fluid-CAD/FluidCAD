import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { SceneCompare } from "../../rendering/scene-compare.js";
import { Scene } from "../../rendering/scene.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import repeat from "../../core/repeat.js";
import { face } from "../../filters/index.js";
import { SceneObject } from "../../common/scene-object.js";
import { Connector } from "../../features/connector.js";
import { Part } from "../../features/part.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { Matrix4 } from "../../math/matrix4.js";
import { testRect } from "../helpers/profiles.js";

/** What a linear or circular repeat says when handed the connector `top`. */
function patternRefusal(kind: "linear" | "circular"): string {
  return `repeat() re-applies features — copy a connector with copy('${kind}', axis, options, top), `
    + `or copy(<this repeat>, top) to follow it`;
}

/** What a mirror, rotate or matrix repeat says — it has no copy() form of its own. */
const pairRefusal = "repeat() re-applies features — copy a connector with "
  + "copy('linear', axis, options, top) or copy('circular', axis, options, top)";

type Block = { e: SceneObject; top: Connector; r: RepeatBase };

/**
 * A 20 × 20 × 10 block with a connector on its top face, then the repeat
 * `repeatIt` writes — inside a part, where connectors live.
 */
function block(repeatIt: (e: SceneObject, top: Connector) => unknown): Block {
  const out = {} as Block;
  part("block", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    out.e = extrude(10).new() as unknown as SceneObject;
    out.top = connector("top", select(face().planar().onPlane("xy", 10))) as unknown as Connector;
    out.r = repeatIt(out.e, out.top) as RepeatBase;
  });
  return out;
}

/**
 * The repeat carries `message` as its build error, and nothing else broke:
 * no clone was made, the seed connector still built on its face, and the part
 * still registers it as its only connector.
 */
function expectRefused(scene: Scene, { top, r }: Block, message: string): void {
  expect(r.getError()).toBe(message);
  const rendered = scene.getRenderedObject(r)!;
  expect(rendered.hasError).toBe(true);
  expect(rendered.errorMessage).toBe(message);

  const others = scene.getAllSceneObjects().filter(o => o !== r && o.getError());
  expect(others.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);

  expect(r.getChildren()).toEqual([]);
  expect(r.getInstanceSlots()).toEqual([]);
  expect(scene.getAllSceneObjects().filter(o => o.getCloneSource() !== null)).toEqual([]);
  expect(scene.getAllSceneObjects().filter(o => o instanceof Connector)).toEqual([top]);

  const blockPart = scene.getAllSceneObjects().find(o => o instanceof Part) as Part;
  expect(blockPart.getConnectors()).toEqual([top]);
  expect(top.getFrame().origin.z).toBeCloseTo(10, 6);
}

describe("repeat() refuses connectors", () => {
  setupOC();

  it("refuses an explicit connector target", () => {
    const made = block((_e, top) => repeat("linear", "x", { count: 3, offset: 40 }, top));

    expectRefused(render(), made, patternRefusal("linear"));
  });

  it("refuses the implicit last object when it is a connector", () => {
    const made = block(() => repeat("linear", "x", { count: 3, offset: 40 }));

    expectRefused(render(), made, patternRefusal("linear"));
  });

  it("names the circular form for a circular repeat", () => {
    const made = block((_e, top) => repeat("circular", "z", { count: 4, angle: 360 }, top));

    expectRefused(render(), made, patternRefusal("circular"));
  });

  it("names the axes of a two-axis linear repeat", () => {
    const made = block((_e, top) => repeat("linear", ["x", "y"], { count: [2, 2], offset: [40, 40] }, top));

    expectRefused(render(), made,
      "repeat() re-applies features — copy a connector with copy('linear', axes, options, top), "
      + "or copy(<this repeat>, top) to follow it");
  });

  it("refuses a connector among other targets, cloning none of them", () => {
    const made = block((e, top) => repeat("linear", "x", { count: 3, offset: 40 }, e, top));
    const scene = render();

    expectRefused(scene, made, patternRefusal("linear"));
    // The block was not repeated either: the one solid in the scene is the original.
    const solids = new Set(scene.getAllSceneObjects()
      .filter(o => !o.isContainer())
      .flatMap(o => o.getShapes())
      .filter(s => s.getType() === "solid")
      .map(s => s.id));
    expect([...solids]).toEqual(made.e.getShapes().map(s => s.id));
  });

  const defaultTargetForms: { name: string; repeatIt: () => unknown; message: string }[] = [
    { name: "circular", repeatIt: () => repeat("circular", "z", { count: 4, angle: 360 }), message: patternRefusal("circular") },
    { name: "mirror", repeatIt: () => repeat("mirror", "yz"), message: pairRefusal },
    { name: "rotate", repeatIt: () => repeat("rotate", "z", 90), message: pairRefusal },
    { name: "matrix", repeatIt: () => repeat(Matrix4.fromTranslation(50, 0, 0)), message: pairRefusal },
  ];

  for (const form of defaultTargetForms) {
    it(`refuses the implicit last object on the ${form.name} form`, () => {
      const made = block(() => form.repeatIt());

      expectRefused(render(), made, form.message);
    });
  }

  it("keeps a refusal across a cached render and drops it once the target is a feature", () => {
    // A mirror repeat compares nothing but its kind, so without the refusal
    // taking part in compareTo the cached, refused mirror would stand in for
    // the working one — carrying its error onto a repeat that now builds.
    const author = (target: "connector" | "feature") => block((e, top) =>
      repeat("mirror", "yz", target === "connector" ? top : e));
    const manager = getSceneManager();

    const first = author("connector");
    render();
    const firstScene = manager.currentScene;
    expect(first.r.getError()).toBe(pairRefusal);

    const again = manager.startScene();
    const second = author("connector");
    again.materializeLeftoverDefinitions();
    SceneCompare.compare(firstScene, again);
    expect(again.isCached(second.r)).toBe(true);
    expectRefused(render(), second, pairRefusal);

    const fixed = manager.startScene();
    const third = author("feature");
    fixed.materializeLeftoverDefinitions();
    SceneCompare.compare(again, fixed);
    expect(fixed.isCached(third.r)).toBe(false);
    const scene = render();

    const errored = scene.getAllSceneObjects().filter(o => o.getError());
    expect(errored.map(o => `${o.getUniqueType()}: ${o.getError()}`)).toEqual([]);
    expect(third.r.getInstanceSlots()).toHaveLength(2);
  });
});
