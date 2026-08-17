import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import expose from "../../core/expose.js";
import { rect } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { resolvePickExposure } from "../../selection/expose-lookup.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

describe("resolvePickExposure", () => {
  setupOC();

  /** Donor (100×50×30 box, part at line 2) + consumer (10×10×5, line 10). */
  function makeTwoPartScene(donorBody?: () => void) {
    const donor = part("Donor", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 5);
      donorBody?.();
    });
    setLocation(donor, 2);
    const consumer = part("Consumer", () => {
      sketch("xy", () => {
        rect(10, 10);
      });
      extrude(5);
    });
    setLocation(consumer, 10);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(tops).toHaveLength(1);
    return { scene, topFace: tops[0] };
  }

  it("resolves the donor part with no match when nothing is exposed", () => {
    const { scene, topFace } = makeTwoPartScene();

    const result = resolvePickExposure(scene, topFace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor).toEqual({
        partName: "Donor",
        filePath: "/ws/model.fluid.js",
        line: 2,
        column: 0,
        matched: null,
        existingNames: [],
      });
    }
  });

  it("matches an exposure whose source serves the picked face", () => {
    const { scene, topFace } = makeTwoPartScene(() => {
      expose("endFace", select(face().planar().onPlane("xy", 30)));
    });

    const result = resolvePickExposure(scene, topFace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.matched).toBe("endFace");
      expect(result.donor?.existingNames).toEqual(["endFace"]);
    }
  });

  it("reports existing names without matching a different face's exposure", () => {
    const { scene, topFace } = makeTwoPartScene(() => {
      expose("bottom", select(face().planar().onPlane("xy")));
    });

    const result = resolvePickExposure(scene, topFace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.matched).toBe(null);
      expect(result.donor?.existingNames).toEqual(["bottom"]);
    }
  });

  it("a sketch-sourced exposure never matches a face pick", () => {
    const { scene, topFace } = makeTwoPartScene(() => {
      const s = sketch("xy", () => rect(4, 4)).reusable();
      expose("profile", s);
    });

    const result = resolvePickExposure(scene, topFace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor?.matched).toBe(null);
    }
  });

  it("resolves to a null donor outside any part()", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 3);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const result = resolvePickExposure(scene, tops[0]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.donor).toBe(null);
    }
  });

  it("refuses assembly scenes with a pointed authoring-frame message", () => {
    const scene = getSceneManager().startAssemblyScene();

    const result = getSceneManager().resolvePickExposure(scene, {
      shapeId: "any",
      sub: { type: "face", index: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain("part file");
    }
  });
});
