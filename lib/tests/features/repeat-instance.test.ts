import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { Solid } from "../../common/solid.js";
import { Scene } from "../../rendering/scene.js";
import { FaceProps } from "../../oc/face-props.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { testRect } from "../helpers/profiles.js";

/** Distinct non-container solids of the scene, ordered by their min x. */
function solidsByX(scene: Scene): Solid[] {
  const solids: Solid[] = [];
  const seen = new Set<string>();
  for (const obj of scene.getAllSceneObjects()) {
    if (obj.isContainer()) {
      continue;
    }
    for (const shape of obj.getShapes()) {
      if (shape.getType() === "solid" && !seen.has(shape.id)) {
        seen.add(shape.id);
        solids.push(shape as Solid);
      }
    }
  }
  return solids.sort((a, b) => ShapeOps.getBoundingBox(a).minX - ShapeOps.getBoundingBox(b).minX);
}

function cylinderFaceCount(solid: Solid): number {
  return solid.getFaces()
    .filter(f => FaceProps.getProperties(f.getShape()).surfaceType === "cylinder").length;
}

function box(size: number = 20): ExtrudeBase {
  sketch("xy", () => {
    testRect(size, size);
  });
  return extrude(10).new() as ExtrudeBase;
}

describe("repeat instance() accessor", () => {
  setupOC();

  it("records one slot per linear instance with the original at slot 0", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e) as unknown as RepeatBase;

    const slots = r.getInstanceSlots();
    expect(slots).toHaveLength(3);
    expect(r.getOriginalSlot()).toBe(0);
    expect(slots[0]).toEqual([e]);
    expect(slots[1]).toHaveLength(1);
    expect(slots[2]).toHaveLength(1);
    expect(slots[1]![0]).not.toBe(e);
    expect(slots[1]![0].getCloneSource()).toBe(e);
    expect(slots[1]![0]).not.toBe(slots[2]![0]);
    expect(r.slotOf(e)).toBe(0);
    expect(r.slotOf(slots[2]![0])).toBe(2);
  });

  it("forwards endEdges() to the slot's clone so only that instance is filleted", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    fillet(2, r.instance(1).endEdges());

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids).toHaveLength(3);
    expect(solids.map(cylinderFaceCount)).toEqual([0, 4, 0]);
  });

  it("forwards accessor arguments (indices and filters) unchanged", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    fillet(2, r.instance(2).endEdges(0, 1));

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids.map(cylinderFaceCount)).toEqual([0, 0, 2]);
  });

  it("slot 0 forwards to the original feature", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    fillet(2, r.instance(0).endEdges());

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids.map(cylinderFaceCount)).toEqual([4, 0, 0]);
  });

  it("is a whole-geometry from() scope for select()", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    fillet(2, select(edge().from(r.instance(1)).line()));

    const scene = render();
    const solids = solidsByX(scene);
    // Every edge of the middle box is a line: all 12 fillet, the twins stay plain.
    expect(solids.map(cylinderFaceCount)).toEqual([0, 12, 0]);
  });

  it("places a centered linear original at the center slot", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40, centered: true }, e) as unknown as RepeatBase;
    expect(r.getOriginalSlot()).toBe(1);
    expect(r.getInstanceSlots()[1]).toEqual([e]);
    fillet(2, r.instance(0).endEdges());

    const scene = render();
    const solids = solidsByX(scene);
    // Slot 0 sits one offset in −x from the original.
    expect(solids.map(cylinderFaceCount)).toEqual([4, 0, 0]);
    expect(ShapeOps.getBoundingBox(solids[0]).minX).toBeCloseTo(-40, 1);
  });

  it("linearizes a two-axis grid with the first axis slowest", () => {
    const e = box();
    const r = repeat("linear", ["x", "y"], { count: [2, 3], offset: [40, 40] }, e) as unknown as RepeatBase;
    expect(r.getInstanceSlots()).toHaveLength(6);
    // Slot 4 = x index 1, y index 1.
    fillet(2, r.instance(4).endEdges());

    const scene = render();
    const filleted = solidsByX(scene).filter(s => cylinderFaceCount(s) === 4);
    expect(filleted).toHaveLength(1);
    const bbox = ShapeOps.getBoundingBox(filleted[0]);
    expect(bbox.minX).toBeCloseTo(40, 1);
    expect(bbox.minY).toBeCloseTo(40, 1);
  });

  it("keeps skipped slots addressable-but-empty so numbering matches skip", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 4, offset: 40, skip: [[2]] }, e) as unknown as RepeatBase;
    expect(r.getInstanceSlots()).toHaveLength(4);
    expect(r.getInstanceSlots()[2]).toBeNull();
    expect(() => r.instance(2)).toThrow(/instance\(2\) was skipped/);
    fillet(2, r.instance(3).endEdges());

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids).toHaveLength(3);
    expect(solids.map(cylinderFaceCount)).toEqual([0, 0, 4]);
    expect(ShapeOps.getBoundingBox(solids[2]).minX).toBeCloseTo(120, 1);
  });

  it("rejects out-of-range slots at the statement", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    expect(() => r.instance(3)).toThrow(/instance\(3\) is out of range — valid slots: 0–2/);
    expect(() => r.instance(-1)).toThrow(/out of range/);
  });

  it("numbers circular instances by rotation step", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [60, 0] });
    });
    const e = extrude(10).new() as ExtrudeBase;
    const r = repeat("circular", "z", { count: 4, angle: 360 }, e) as unknown as RepeatBase;
    expect(r.getInstanceSlots()).toHaveLength(4);
    fillet(2, r.instance(1).endEdges());

    const scene = render();
    const filleted = solidsByX(scene).filter(s => cylinderFaceCount(s) === 4);
    expect(filleted).toHaveLength(1);
    // Step 1 of four over 360° turns the box (x 60–80, y 0–20) by 90°: onto
    // y 60–80, x −20–0.
    const bbox = ShapeOps.getBoundingBox(filleted[0]);
    expect((bbox.minY + bbox.maxY) / 2).toBeCloseTo(70, 1);
    expect((bbox.minX + bbox.maxX) / 2).toBeCloseTo(-10, 1);
  });

  it("gives mirror, rotate and matrix repeats slots 0 and 1", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [40, 0] });
    });
    const e = extrude(10).new() as ExtrudeBase;
    const m = repeat("mirror", "yz", e) as unknown as RepeatBase;
    expect(m.getInstanceSlots()).toHaveLength(2);
    expect(m.getInstanceSlots()[0]).toEqual([e]);
    expect(m.getInstanceSlots()[1]![0].getCloneSource()).toBe(e);
    fillet(2, m.instance(1).endEdges());

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids).toHaveLength(2);
    // The mirrored clone sits at −x.
    expect(solids.map(cylinderFaceCount)).toEqual([4, 0]);
  });

  it("refuses to forward accessors when a slot repeats several features", () => {
    const a = box();
    sketch("xy", () => {
      testRect(20, 20, { at: [0, 40] });
    });
    const b = extrude(10).new() as ExtrudeBase;
    const r = repeat("linear", "x", { count: 2, offset: 40 }, a, b) as unknown as RepeatBase;
    expect(r.getInstanceSlots()[1]).toHaveLength(2);
    expect(() => r.instance(1).endEdges()).toThrow(/clones 2 features per instance/);
    // The whole-geometry form still works: both clones fillet through from().
    fillet(2, select(edge().from(r.instance(1)).line()));

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids).toHaveLength(4);
    expect(solids.filter(s => cylinderFaceCount(s) === 12)).toHaveLength(2);
  });

  it("errors when the repeated feature lacks the accessor", () => {
    const e = box();
    const f = fillet(2, e.endEdges());
    const r = repeat("linear", "x", { count: 2, offset: 40 }, f);
    expect(() => r.instance(1).endEdges()).toThrow(/fillet\(\) has no endEdges\(\) accessor/);
  });

  it("is a whole-geometry operand for modifiers", () => {
    const e = box();
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    fillet(1, r.instance(2));

    const scene = render();
    const solids = solidsByX(scene);
    expect(solids.map(cylinderFaceCount)).toEqual([0, 0, 12]);
    expect(ShapeOps.getBoundingBox(solids[2]).minX).toBeCloseTo(80, 1);
  });
});
