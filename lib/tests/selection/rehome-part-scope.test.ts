import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import part from "../../core/part.js";
import { circle } from "../../core/2d/index.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import type { ApplyFeatureKind, PickRef } from "../../selection/types.js";
import { findSolids, setLocation } from "./pick-helpers.js";
import { testRectSketch } from "../helpers/profiles.js";

/**
 * Plane-only consumers (sketch, plane) and extrude's up-to-face target
 * re-home an unattributed face pick onto a classified stand-in on the same
 * plane/surface. The stand-in must live in the picked solid's own part()
 * scope: its variable is only in scope inside that part's callback, and the
 * emitted statement inserts at its producers — a stand-in from another part
 * would drag a sketch on the rod's face into the cap's body.
 *
 * Fixture: a "rod" part whose picked face (a pillar bottom on z=0, facing
 * -z) is unattributed — created by an extrude at a shared loop call site
 * (unbindable) and reshaped by a pocket cut — and a "cap" part built AFTER
 * it with a bindable face on that same plane. The cap's buckets are scanned
 * first (latest feature first), so without part scoping they win.
 */
const CAP_PART_LINE = 12;

const REHOMING_FEATURES: ApplyFeatureKind[] = ['sketch', 'plane', 'extrude'];

/** Refs of the solid's faces with every edge midpoint on z=0 inside the pocketed pillar. */
function pocketedBottomRefs(solids: ReturnType<typeof findSolids>): PickRef[] {
  const refs: PickRef[] = [];
  for (const solid of solids) {
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const edges = f.getEdges();
      const mids = edges.map(e => EdgeOps.getEdgeMidPoint(e));
      const onPlane = mids.length === 5
        && mids.every(m => Math.abs(m.z) < 1e-6 && m.x > 30 - 1e-6 && m.x < 40 + 1e-6);
      if (onPlane) {
        refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
  }
  return refs;
}

/** Two 10×10 pillars from one loop call site, the second pocketed from below. */
function buildRod(withBindableCoplanarFace: boolean): void {
  const rod = part("rod", () => {
    for (const x of [0, 30]) {
      testRectSketch("xy", 10, 10, { at: [x, 0] });
      const e = extrude(20);
      setLocation(e, 4);
    }
    sketch("xy", () => {
      circle([35, 5], 2);
    });
    const c = cut(-5);
    setLocation(c, 7);
    if (withBindableCoplanarFace) {
      testRectSketch("xy", 10, 10, { at: [-30, 0] });
      const e = extrude(20);
      setLocation(e, 9);
    }
  });
  setLocation(rod, 2);
}

/** A slab beside the rod whose face on z=0 faces the same way (-z) or the opposite way (+z). */
function buildCap(facing: 'same' | 'opposite'): void {
  const cap = part("cap", () => {
    testRectSketch("xy", 20, 10, { at: [60, 0] });
    const e = extrude(facing === 'same' ? 20 : -20);
    setLocation(e, 14);
  });
  setLocation(cap, CAP_PART_LINE);
}

describe("re-home stays inside the picked solid's part() scope", () => {
  setupOC();

  for (const feature of REHOMING_FEATURES) {
    it(`${feature}: never re-homes onto a coplanar face of another part`, () => {
      buildRod(false);
      buildCap('same');
      const scene = render();

      const refs = pocketedBottomRefs(findSolids(scene));
      expect(refs).toHaveLength(1);

      const result = synthesizeApplyFeature(scene, refs, feature);
      expect(result.ok).toBe(true);
      if (result.ok) {
        for (const producer of result.spec.producers) {
          expect(producer.line).toBeLessThan(CAP_PART_LINE);
        }
        // No in-scope stand-in exists: the pick keeps its geometric fallback.
        expect(result.args).toMatch(/^select\(/);
      }
    });

    it(`${feature}: still re-homes onto a coplanar face of the same part`, () => {
      buildRod(true);
      buildCap('same');
      const scene = render();

      const refs = pocketedBottomRefs(findSolids(scene));
      expect(refs).toHaveLength(1);

      const result = synthesizeApplyFeature(scene, refs, feature);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.producers).toHaveLength(1);
        expect(result.spec.producers[0].line).toBe(9);
        expect(result.args).not.toMatch(/select\(/);
      }
    });
  }

  it("sketch: ignores an opposite-facing coplanar face of another part", () => {
    buildRod(false);
    buildCap('opposite');
    const scene = render();

    const refs = pocketedBottomRefs(findSolids(scene));
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'sketch');
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const producer of result.spec.producers) {
        expect(producer.line).toBeLessThan(CAP_PART_LINE);
      }
    }
  });
});
