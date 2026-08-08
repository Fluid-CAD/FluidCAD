import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { induceConjunction } from "../../selection/induction.js";
import type { Atom } from "../../selection/atoms.js";
import { edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

describe("filter ranking robustness", () => {
  setupOC();

  it("prefers the datum half-space over onPlane with a derived constant", () => {
    // Three overlapping circles: the union outline's seam lines sit at
    // y = ±20·√3 — a derived constant no parameter edit keeps stable. The
    // two seams above the xz plane must come out as the constant-free
    // half-space, not onPlane with the baked offset.
    sketch("xy", () => {
      circle(80);
      circle([40, 0], 80);
      circle([80, 0], 80);
    });
    const e = extrude(100) as Extrude;
    setLocation(e, 6);
    shell(-2, e.endFaces());

    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m =>
      Math.abs(m.z - 50) < 1e-6 && Math.abs(m.y - 20 * Math.sqrt(3)) < 0.1);
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, e.sideEdges(edge().below('xz')))");
    }
  });
});

describe("constant-free induction pass", () => {
  const atom = (code: string, weight: number, constants: number): Atom<object> => ({
    code, addTo: () => {}, weight, constants, needsScope: false,
  });

  it("prefers a constant-free conjunction over a shorter constant-bearing one", () => {
    // The constant atom isolates the targets alone (best greedy opener); the
    // constant-free pair needs two steps. The constant-free pass must win.
    const magic = atom(".onPlane('xz', -34.64)", 20, 1);
    const line = atom('.line()', 30, 0);
    const half = atom(".below('xz')", 21, 0);
    const targets = new Set([1, 2]);
    const universe = new Set([1, 2, 3, 4, 5]);
    const matches = new Map([
      [magic, new Set([1, 2])],
      [line, new Set([1, 2, 3])],
      [half, new Set([1, 2, 4, 5])],
    ]);

    const conjunction = induceConjunction([magic, line, half], matches, targets, universe);
    expect(conjunction).not.toBeNull();
    expect(conjunction!.map(a => a.code)).toEqual(['.line()', ".below('xz')"]);
  });

  it("falls back to constant-bearing atoms when nothing constant-free resolves", () => {
    const magic = atom(".onPlane('xz', -34.64)", 20, 1);
    const half = atom(".below('xz')", 21, 0);
    const targets = new Set([1, 2]);
    const universe = new Set([1, 2, 3, 4, 5]);
    const matches = new Map([
      [magic, new Set([1, 2])],
      [half, new Set([1, 2, 4, 5])],
    ]);

    const conjunction = induceConjunction([magic, half], matches, targets, universe);
    expect(conjunction).not.toBeNull();
    expect(conjunction!.map(a => a.code)).toEqual([".onPlane('xz', -34.64)"]);
  });
});
