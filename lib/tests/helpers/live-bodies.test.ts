import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import rotate from "../../core/rotate.js";
import remove from "../../core/remove.js";
import { SceneObject } from "../../common/scene-object.js";
import { Sheet } from "../../common/sheet.js";
import { Solid } from "../../common/solid.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import {
  bodiesBuiltBy,
  heldBodiesOf,
  heldSolidsOf,
  liveBodiesOf,
  liveOperandShapes,
  liveSolidsOf,
} from "../../helpers/live-solids.js";
import { TestSheets } from "./sheets.js";
import { TestCurves } from "./curves.js";
import { testRect } from "./profiles.js";
import { useLoadedBodies, loadShapes } from "./loaded-bodies.js";

const asObject = (value: unknown) => value as SceneObject;

describe("body lineage over surfaces", () => {
  setupOC();
  useLoadedBodies();

  it("a surface is a body its builder built", () => {
    const l = loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]);
    render();

    const built = bodiesBuiltBy(l);
    expect(built.length).toBe(1);
    expect(built[0]).toBeInstanceOf(Sheet);
  });

  it("follows a surface through two rotates to where it is now", () => {
    const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
    const first = asObject(rotate("z", 90, l));
    const second = asObject(rotate("x", 90, l));
    render();

    expect(l.getShapes()).toEqual([]);
    expect(first.getShapes()).toEqual([]);
    const live = liveBodiesOf(l);
    expect(live.length).toBe(1);
    expect(live[0].holder).toBe(second);
    expect(live[0].body).toBeInstanceOf(Sheet);
    // The plate lay on XY over [0, 10]²; z turned it onto [-10, 0] × [0, 10], x stood it up.
    const box = ShapeOps.getBoundingBox(live[0].body);
    expect(box.centerX).toBeCloseTo(-5, 6);
    expect(box.centerZ).toBeCloseTo(5, 6);

    expect(liveOperandShapes(l).map(entry => entry.shape)).toEqual([live[0].body]);
    expect(liveOperandShapes(l, {}, "surface").map(entry => entry.shape)).toEqual([live[0].body]);
    expect(liveOperandShapes(l, {}, "solid")).toEqual([]);
  });

  it("a surface removed at the end of its walk leaves nothing live", () => {
    const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
    const turned = asObject(rotate("z", 90, l));
    remove(turned);
    render();

    expect(liveBodiesOf(l)).toEqual([]);
    expect(liveOperandShapes(l)).toEqual([]);
  });

  it("the solid helpers stay solids only beside a surface", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [50, 0] });
    });
    const e = asObject(extrude(10));
    const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
    render();

    const objects = [e, l];
    expect(heldBodiesOf(objects).map(({ body }) => body.constructor)).toEqual([Solid, Sheet]);
    expect(heldSolidsOf(objects).map(({ holder }) => holder)).toEqual([e]);
    expect(liveSolidsOf(l)).toEqual([]);
    expect(liveBodiesOf(l).map(({ holder }) => holder)).toEqual([l]);
  });

  it("a surface keeps its lineage key through a rotate, as a solid does", () => {
    const l = asObject(loadShapes([TestSheets.plate(10, 10)]));
    const before = render();
    const key = (scene: typeof before) => scene.getRenderedObjects()
      .flatMap(row => row.sceneShapes)
      .find(shape => shape.shapeType === "surface")?.lineageKey;

    const original = key(before);
    expect(typeof original).toBe("string");

    rotate("z", 90, l);
    expect(key(render())).toBe(original);
  });
});
