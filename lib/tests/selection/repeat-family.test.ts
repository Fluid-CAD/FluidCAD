import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { Explorer } from "../../oc/explorer.js";
import type { PickRef } from "../../selection/types.js";
import { findSolid, setLocation } from "./pick-helpers.js";

describe("repeat-family selection synthesis", () => {
  setupOC();

  // The reported gear: a bored disc with one flute cut() repeated 8× around
  // z. Every flute instance's arcs are clone-attributed (unbindable), while
  // the original flute's arcs bind to its own buckets — a selection covering
  // the whole family used to strand the clones in a global pool that had to
  // exclude their geometrically identical original, which no filter can do.
  function buildGear() {
    sketch("xy", () => {
      circle([0, 0], 72);
    });
    const body = extrude(34) as Extrude;
    setLocation(body, 4);

    sketch(body.endFaces(), () => {
      circle([0, 0], 30);
    });
    const bore = cut();
    setLocation(bore, 9);

    sketch(body.endFaces(), () => {
      circle([36, 0], 16);
    });
    const flute = cut();
    setLocation(flute, 14);

    const r = repeat("circular", "z", { count: 8, angle: 360 }, flute);
    setLocation(r, 16);
  }

  it("fillet on all rim arcs of a circular-repeated cut", () => {
    buildGear();
    const scene = render();
    const solid = findSolid(scene);

    // The user's "select all arcs": every arc edge on the two rims — the
    // notch arcs (r8) and the outer rim arcs (r36) — but not the bore
    // circles (full circles) or the straight flank edges.
    const refs: PickRef[] = [];
    Explorer.findEdgesWrapped(solid).forEach((e, index) => {
      const props = EdgeProps.getProperties(e.getShape());
      if (props.curveType === "arc") {
        refs.push({ shapeId: solid.id, sub: { type: "edge", index } });
      }
    });
    expect(refs).toHaveLength(32);

    const result = synthesizeApplyFeature(scene, refs, "fillet", 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(1, select(edge().arc()))");
    }
  });

  it("keeps unrelated bucket accessors when only the clone family merges", () => {
    buildGear();
    const scene = render();
    const solid = findSolid(scene);

    // All 32 arcs plus the two bore circles: the flute family collapses into
    // the merged select(), but the bore picks stay on their own bindable
    // buckets instead of being absorbed along with them.
    const refs: PickRef[] = [];
    Explorer.findEdgesWrapped(solid).forEach((e, index) => {
      const props = EdgeProps.getProperties(e.getShape());
      if (props.curveType === "arc" || props.curveType === "circle") {
        refs.push({ shapeId: solid.id, sub: { type: "edge", index } });
      }
    });
    expect(refs).toHaveLength(34);

    const result = synthesizeApplyFeature(scene, refs, "fillet", 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe(
        "fillet(1, c.endEdges(), c.startEdges(), select(edge().arc()))",
      );
    }
  });
});
