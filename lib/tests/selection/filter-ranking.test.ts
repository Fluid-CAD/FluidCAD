import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import fuse from "../../core/fuse.js";
import { circle, move, polygon, rect } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { induceConjunction } from "../../selection/induction.js";
import type { Atom } from "../../selection/atoms.js";
import type { PickRef } from "../../selection/types.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, findSolids, setLocation } from "./pick-helpers.js";

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

  it("prefers the bucket index over filters baking unlinked geometry constants", () => {
    // Positions, lengths, and plane offsets that no user parameter tracks —
    // the pentagon side length 107.7·sin 36° = 63.30447167189937…, the rect
    // plane at y = 25.64, the side face at x = 233.74 — silently break on
    // dimension edits, so the verified index form wins and the filter drops
    // to the alternatives dropdown. A constant linked to a user parameter
    // keeps the filter form: the emitted name follows the variable.
    sketch("xy", () => {
      circle([50, 70], 35.77);
      move(33.66, 7.54);
      const r = rect(110.99, -51.9);
      move(-44.65, 74.36);
      const c = circle(72.84);
      fuse(r, c);
      rect(83.74, -54.35);
      move(-233.74, 124.35);
      polygon(5, 107.7);
    });
    const e = extrude() as Extrude;
    setLocation(e, 13);
    const scene = render();

    const edgeAt = (x: number, y: number): PickRef => {
      for (const solid of findSolids(scene)) {
        const refs = edgeRefsWhere(solid, m =>
          Math.abs(m.z - 25) < 1e-6 && Math.abs(m.x - x) < 0.05 && Math.abs(m.y - y) < 0.05);
        if (refs.length === 1) {
          return refs[0];
        }
      }
      throw new Error(`no single edge at (${x}, ${y})`);
    };

    const polygonEdge = synthesizeApplyFeature(scene, [edgeAt(35.25, 144.39)], 'fillet', 2);
    expect(polygonEdge.ok).toBe(true);
    if (polygonEdge.ok) {
      expect(polygonEdge.preview).toMatch(/^fillet\(2, e\.endEdges\(\d+\)\)$/);
      expect(polygonEdge.alternatives[0]).toMatch(/e\.endEdges\(edge\(\)\.line\(63\.304\d+\)/);
    }

    // A clean 2-decimal offset is still unlinked geometry — the index wins.
    const rectEdge = synthesizeApplyFeature(scene, [edgeAt(139.15, 25.64)], 'fillet', 2);
    expect(rectEdge.ok).toBe(true);
    if (rectEdge.ok) {
      expect(rectEdge.preview).toMatch(/^fillet\(2, e\.endEdges\(\d+\)\)$/);
      expect(rectEdge.alternatives[0]).toBe("e.endEdges(edge().onPlane('xz', -25.64))");
    }

    // Faces follow the same rule: a side face isolated only by its plane
    // offset comes out as the index, the onPlane form as the alternative.
    const faceAt = (x: number): PickRef => {
      for (const solid of findSolids(scene)) {
        const refs = faceRefsWhere(solid, m => Math.abs(m.x - x) < 0.05);
        if (refs.length === 1) {
          return refs[0];
        }
      }
      throw new Error(`no single face at x=${x}`);
    };
    const sideFace = synthesizeApplyFeature(scene, [faceAt(233.74)], 'fillet', 2);
    expect(sideFace.ok).toBe(true);
    if (sideFace.ok) {
      expect(sideFace.preview).toMatch(/^fillet\(2, e\.sideFaces\(\d+\)\)$/);
      expect(sideFace.alternatives[0]).toBe("e.sideFaces(face().onPlane('yz', 233.74))");
    }

    // Linked to a user parameter, the same rect offset tracks edits — the
    // filter form keeps winning and the index stays the alternative.
    const linked = synthesizeApplyFeature(scene, [edgeAt(139.15, 25.64)], 'fillet', 2, [], {
      params: [{ name: 'rectY', value: -25.64 }],
    });
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.preview).toBe("fillet(2, e.endEdges(edge().onPlane('xz', rectY)))");
      expect(linked.alternatives.some(a => /^e\.endEdges\(\d+\)$/.test(a))).toBe(true);
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
