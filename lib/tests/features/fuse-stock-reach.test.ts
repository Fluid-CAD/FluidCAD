import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, extrude, circle } from "../../core/index.js";
import { Feature, defineFeature } from "../../sdk/index.js";
import { ShapeFactory } from "../../sdk/kernel.js";
import { ShapeProps } from "../../oc/props.js";
import type { SceneObject } from "../../common/scene-object.js";
import { testRect } from "../helpers/profiles.js";

/**
 * An add fuses its tool into the solids it reaches, and only those. A solid
 * the tool misses comes out exactly as it went in — the face merge after the
 * boolean must not rebuild it, or the add takes it for a new body and the
 * scene holds it twice. Solids the tool does reach are fused whole, even
 * when they overlap each other: bundled into one argument, an overlapping
 * pair was a self-interfering input and the fuse dropped one of them.
 */

/**
 * A 20×10×10 block standing at (x, y, z), built as two 10 mm cubes fused
 * without the face merge: its top, bottom and long sides stay split in two,
 * so a merge that reaches it rebuilds it into a different solid.
 */
class SplitBlock extends Feature.with({
  x: { type: 'number', default: 0 },
  y: { type: 'number', default: 0 },
  z: { type: 'number', default: 0 },
}) {
  static id = 'split-block';

  buildTool() {
    const { x, y, z } = this.values;
    return this.occ(({ oc, track }) => {
      const left = track(new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(x, y, z), 10, 10, 10).Shape());
      const right = track(new oc.BRepPrimAPI_MakeBox(new oc.gp_Pnt(x + 10, y, z), 10, 10, 10).Shape());
      const fuse = new oc.BRepAlgoAPI_Fuse(left, right, new oc.Message_ProgressRange());
      const solids = new oc.TopExp_Explorer(track(fuse.Shape()), oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      return [ShapeFactory.fromShape(track(oc.TopoDS.Solid(track(solids.Current()))))];
    });
  }
}

const splitBlock = defineFeature(SplitBlock, {
  label: 'Split block',
  group: 'create',
  operations: ['new'],
  call: [{ x: 'x', y: 'y', z: 'z' }],
});

/** Every solid the given objects hold now, as volumes, smallest first. */
function volumes(...objects: SceneObject[]): number[] {
  return objects
    .flatMap(o => o.getShapes())
    .filter(s => s.getType() === 'solid')
    .map(s => ShapeProps.getProperties(s.getShape()).volumeMm3)
    .sort((a, b) => a - b);
}

/** A 100×60×30 box on the XY plane, its corner on the origin. */
function box() {
  sketch("xy", () => testRect(100, 60));
  return extrude(30) as unknown as SceneObject;
}

describe("fusing into the solids an add reaches", () => {
  setupOC();

  it("leaves a new body the tool misses as it is, though the face merge would rebuild it", () => {
    const body = box();
    // Touches the box's front face, far from the tool.
    const block = splitBlock({ x: 80, y: -10, z: 0 }) as unknown as SceneObject;
    sketch("xy", () => circle([0, 0], 40));
    const add = extrude(40) as unknown as SceneObject;

    render();

    expect(block.getShapes()).toHaveLength(1);
    // The tool (r = 20, z 0..40) overlaps the box in a quarter cylinder 30 high.
    expect(volumes(body, block, add)).toEqual([
      expect.closeTo(2000, 3),
      expect.closeTo(180000 + Math.PI * 20 * 20 * 40 - Math.PI * 20 * 20 * 30 / 4, 1),
    ]);
  });

  it("hands back the one solid near the tool unmerged when the tool doesn't touch it", () => {
    const block = splitBlock({ x: 0, y: 0, z: 0 }) as unknown as SceneObject;
    // Its box overlaps the block's corner at (20, 10), the cylinder 0.33 mm clear of it.
    sketch("xy", () => circle([22, 12], 5));
    const add = extrude(10) as unknown as SceneObject;

    render();

    expect(block.getShapes()).toHaveLength(1);
    expect(volumes(block, add)).toEqual([
      expect.closeTo(Math.PI * 2.5 * 2.5 * 10, 3),
      expect.closeTo(2000, 3),
    ]);
  });

  it("fuses a new body overlapping the stock when the tool reaches both", () => {
    const body = box();
    // A 20×20 bar along X, centred on the box's top front edge (y = 0, z = 30).
    sketch("yz", () => testRect(20, 20, { at: [-10, 20] }));
    const bar = extrude(200).new() as unknown as SceneObject;
    sketch("xy", () => circle([0, 0], 40));
    const add = extrude(40) as unknown as SceneObject;

    render();

    // The box and the bar overlap in 100×10×10; the tool (r = 20, z 0..40)
    // overlaps the box in a quarter cylinder 30 high, and the bar where |y| ≤ 10
    // between z = 20 and 40, x ≥ 0 minus what the box already holds.
    const boxAndBar = 180000 + 80000 - 100 * 10 * 10;
    const tool = Math.PI * 20 * 20 * 40;
    const toolInBox = Math.PI * 20 * 20 * 30 / 4;
    const halfStrip = 2 * (5 * Math.sqrt(300) + 200 * Math.asin(0.5));
    const toolInBarOnly = halfStrip * 20 - (halfStrip / 2) * 10;
    expect(volumes(body, bar, add)).toEqual([
      expect.closeTo(boxAndBar + tool - toolInBox - toolInBarOnly, 1),
    ]);
  });

  it("counts an overlap between reached solids once", () => {
    const body = box();
    // A cylinder (r = 10, z 0..35) a quarter inside the box's corner.
    sketch("xy", () => circle([0, 0], 20));
    const post = extrude(35).new() as unknown as SceneObject;
    sketch("xy", () => circle([0, 0], 40));
    const add = extrude(10) as unknown as SceneObject;

    render();

    const postVolume = Math.PI * 10 * 10 * 35;
    const postInBox = Math.PI * 10 * 10 * 30 / 4;
    const tool = Math.PI * 20 * 20 * 10;
    const toolInBox = Math.PI * 20 * 20 * 10 / 4;
    const toolInPost = Math.PI * 10 * 10 * 10 * 3 / 4;
    expect(volumes(body, post, add)).toEqual([
      expect.closeTo(180000 + postVolume + tool - postInBox - toolInBox - toolInPost, 1),
    ]);
  });
});
