import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import expose from "../../core/expose.js";
import { face } from "../../filters/index.js";
import { resolvePickExposure, resolveStatementPart, samePartSite } from "../../selection/expose-lookup.js";
import { faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

describe("resolvePickExposure", () => {
  setupOC();

  /** Donor (100×50×30 box, part at line 2) + consumer (10×10×5, line 10). */
  function makeTwoPartScene(donorBody?: () => void) {
    const donor = part("Donor", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
      donorBody?.();
    });
    setLocation(donor, 2);
    const consumer = part("Consumer", () => {
      sketch("xy", () => {
          testRect(10, 10);
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
      const s = sketch("xy", () => {
        testRect(4, 4);
      }).reusable();
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
        testRect(100, 50);
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

describe("resolveStatementPart", () => {
  setupOC();

  /** Donor (line 2) with its extrude at line 5; consumer (line 10) with a sketch at line 11. */
  function makeScene() {
    const donor = part("Donor", () => {
      sketch("xy", () => {
          testRect(100, 50);
        });
      const e = extrude(30);
      setLocation(e, 5);
    });
    setLocation(donor, 2);
    const consumer = part("Consumer", () => {
      const s = sketch("xy", () => {
          testRect(10, 10);
        });
      setLocation(s, 11);
      extrude(5);
    });
    setLocation(consumer, 10);
    const scene = render();
    const solid = findSolid(scene);
    const tops = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    return { scene, topFace: tops[0] };
  }

  it("resolves a sketch's location to the part whose body holds it", () => {
    const { scene } = makeScene();
    const site = resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 11 });
    expect(site).toEqual({ partName: "Consumer", filePath: "/ws/model.fluid.js", line: 10, column: 0 });
  });

  it("compares in the same terms as a pick's donor", () => {
    const { scene, topFace } = makeScene();
    const consumer = resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 11, column: 0 })!;
    const pick = resolvePickExposure(scene, topFace);
    expect(pick.ok && pick.donor !== null).toBe(true);
    if (pick.ok && pick.donor) {
      // The donor's top face is foreign to the consumer's sketch, and the
      // donor's own statement resolves to the donor.
      expect(samePartSite(pick.donor, consumer)).toBe(false);
      const donorSite = resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 5 })!;
      expect(samePartSite(pick.donor, donorSite)).toBe(true);
    }
  });

  it("is null for a location no rendered statement carries, and for a mismatched column", () => {
    const { scene } = makeScene();
    expect(resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 99 })).toBe(null);
    expect(resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 11, column: 7 })).toBe(null);
    expect(resolveStatementPart(scene, { filePath: "/ws/other.fluid.js", line: 11 })).toBe(null);
  });

  it("is null for a statement outside every part()", () => {
    const s = sketch("xy", () => {
        testRect(100, 50);
      });
    setLocation(s, 3);
    extrude(30);
    const scene = render();
    expect(resolveStatementPart(scene, { filePath: "/ws/model.fluid.js", line: 3 })).toBe(null);
  });

  it("resolves to null in assembly scenes", () => {
    const scene = getSceneManager().startAssemblyScene();
    expect(getSceneManager().resolveStatementPart(scene, { filePath: "/ws/a.assembly.js", line: 1 })).toBe(null);
  });
});
