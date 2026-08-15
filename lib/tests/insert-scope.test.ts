import { describe, it, expect, beforeEach } from "vitest";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import part from "../core/part.js";
import insert from "../core/insert.js";
import mate from "../core/mate.js";
import { rect } from "../core/2d/index.js";
import { Part } from "../features/part.js";

describe("insert scope", () => {
  describe("inside a part scene", () => {
    beforeEach(() => {
      getSceneManager().startScene();
    });

    it("throws when insert() is called in a part file", () => {
      const p = part("housing", () => {
        sketch("xy", () => rect(20, 20));
        extrude(10);
      }) as unknown as Part;

      expect(() => insert(p)).toThrow(/assembly\.js/i);
    });
  });

  describe("inside an assembly scene", () => {
    let p: Part;

    beforeEach(() => {
      // Build a part inside a regular scene first.
      getSceneManager().startScene();
      p = part("housing", () => {
        sketch("xy", () => rect(20, 20));
        extrude(10);
      }) as unknown as Part;
      // Now switch to assembly mode.
      getSceneManager().startAssemblyScene();
    });

    it("throws when extrude() is called at top level of assembly", () => {
      expect(() => extrude(10)).toThrow(/part-design only/i);
    });

    it("returns an Instance with grounded=false by default", () => {
      const inst = insert(p);
      expect(inst.record.grounded).toBe(false);
    });

    it(".grounded() flips the ground flag", () => {
      const inst = insert(p);
      inst.grounded();
      expect(inst.record.grounded).toBe(true);
    });

    it("mate() rejects non-connector arguments", () => {
      expect(() => mate("fastened", null as any, null as any)).toThrow(/connector/i);
    });

    it(".translate() writes record.position", () => {
      const inst = insert(p);
      inst.translate(1, 2, 3);
      expect(inst.record.position).toEqual({ x: 1, y: 2, z: 3 });
    });

    it(".translate() defaults y and z to 0 when omitted", () => {
      const inst = insert(p);
      inst.translate(7);
      expect(inst.record.position).toEqual({ x: 7, y: 0, z: 0 });
    });

    it(".translate() defaults z to 0 when only x and y are given", () => {
      const inst = insert(p);
      inst.translate(7, 8);
      expect(inst.record.position).toEqual({ x: 7, y: 8, z: 0 });
    });

    it("default position is the origin without .translate()", () => {
      const inst = insert(p);
      expect(inst.record.position).toEqual({ x: 0, y: 0, z: 0 });
    });

    it(".translate() chains with .grounded() and .name() in any order", () => {
      const inst = insert(p).translate(5, 6, 7).grounded().name("foo");
      expect(inst.record.position).toEqual({ x: 5, y: 6, z: 7 });
      expect(inst.record.grounded).toBe(true);
      expect(inst.record.name).toBe("foo");
    });
  });
});
