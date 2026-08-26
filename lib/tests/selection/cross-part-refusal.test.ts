import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import { testRectSketch } from "../helpers/profiles.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { allEdgeRefs, findSolids, setLocation } from "./pick-helpers.js";

// One statement executes in one part() scope. The global-select and chain
// paths refuse multi-part pools individually, but bucket-tier picks bound to
// producers in two different parts used to sail through synthesis — the
// preview rendered a plausible expression and only the apply failed, deep in
// the transform's scope resolution.
describe("cross-part pick refusal", () => {
  setupOC();

  it("refuses producer-bound picks spanning two part() scopes", () => {
    const left = part("left", () => {
      testRectSketch("xy", 20, 20);
      const e = extrude(10);
      setLocation(e, 3);
    });
    setLocation(left, 2);
    const right = part("right", () => {
      testRectSketch("xy", 30, 30);
      const e = extrude(6);
      setLocation(e, 8);
    });
    setLocation(right, 7);
    const scene = render();

    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    const picks = [allEdgeRefs(solids[0])[0], allEdgeRefs(solids[1])[0]];

    const result = synthesizeApplyFeature(scene, picks, 'fillet', 3);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('across parts');
    }
  });

  it("refuses picks mixing a part() scope with unparted geometry", () => {
    testRectSketch("xy", 40, 40);
    const loose = extrude(4);
    setLocation(loose, 2);
    const boxed = part("boxed", () => {
      testRectSketch("xy", 20, 20);
      const e = extrude(10);
      setLocation(e, 6);
    });
    setLocation(boxed, 5);
    const scene = render();

    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    const picks = [allEdgeRefs(solids[0])[0], allEdgeRefs(solids[1])[0]];

    const result = synthesizeApplyFeature(scene, picks, 'fillet', 3);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('across parts');
    }
  });

  it("keeps synthesizing for picks on two producers inside one part", () => {
    const p = part("solo", () => {
      testRectSketch("xy", 20, 20);
      const a = extrude(10).new();
      setLocation(a, 3);
      testRectSketch("xy", 8, 8);
      const b = extrude(30).new();
      setLocation(b, 5);
    });
    setLocation(p, 2);
    const scene = render();

    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    const picks = [allEdgeRefs(solids[0])[0], allEdgeRefs(solids[1])[0]];

    const result = synthesizeApplyFeature(scene, picks, 'fillet', 3);
    expect(result.ok).toBe(true);
  });
});
