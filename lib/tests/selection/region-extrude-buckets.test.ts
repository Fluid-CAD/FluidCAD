import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { Explorer } from "../../oc/explorer.js";
import { SceneObject } from "../../common/scene-object.js";
import { Face } from "../../common/face.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { listSelectionGroups } from "../../selection/selection-groups.js";
import { expandBucket } from "../../selection/expand.js";
import { runFluid } from "../helpers/run-fluid.js";
import { findSolids } from "./pick-helpers.js";

/**
 * Two regions of one sketch extruded together. The right region's concave
 * arc straddles the circle's periodic seam, so its face carries the seam
 * vertex and the prism comes out with the arc side split in two. The fusion
 * cleanup merges the seam back, rebuilding both caps and the flats next to
 * the arc — faces the boolean itself never touched. The classified buckets
 * must follow that cleanup lineage, or the whole second solid loses its
 * start/end/side classification (and the right-click menu offers nothing).
 */
describe("classified buckets on a two-region extrude with a seam-split solid", () => {
  setupOC();

  function build() {
    const { e } = runFluid(`
      const s = sketch('xy', () => {
        const l1 = line([-94.18, -33.42], [-44.23, -33.42]);
        const l6 = line([44.23, -33.42], [94.18, -33.42]);
        const l2 = line([94.18, -33.42], [94.18, 33.42]);
        const l3 = line([94.18, 33.42], [44.23, 33.42]);
        const l5 = line([-44.23, 33.42], [-94.18, 33.42]);
        const l4 = line([-94.18, 33.42], [-94.18, -33.42]);
        const c1 = circle([0, 0], 110.87);
        coincident(l6.end(), l2.start());
        coincident(l2.end(), l3.start());
        coincident(l5.end(), l4.start());
        coincident(l4.end(), l1.start());
        horizontal(l1);
        horizontal(l6);
        horizontal(l3);
        horizontal(l5);
        vertical(l2);
        vertical(l4);
        midpoint(origin(), l1.start(), l3.start());
        coincident(c1.center(), origin());
        coincident(l3.end(), c1);
        coincident(l5.start(), c1);
        coincident(l1.end(), c1);
        coincident(l6.start(), c1);
      }).close();
      const e = extrude(25, s).region('l1 c1- l5 l4', 'l6 l2 l3 c1-');
      return { e };
    `) as { e: SceneObject };
    const scene = render();
    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    return { e, scene, solids };
  }

  it("classifies every face of both solids", () => {
    const { e, scene, solids } = build();

    expect((e.getState('start-faces') as Face[]).length).toBe(2);
    expect((e.getState('end-faces') as Face[]).length).toBe(2);

    const index = new SelectionIndex(scene);
    try {
      for (const solid of solids) {
        const faces = Explorer.findFacesWrapped(solid);
        expect(faces).toHaveLength(6);
        const accessors = faces.map(face => {
          const hits = index.findHits(index.keyOf(face), 'face');
          expect(hits.length).toBeGreaterThan(0);
          return hits[0].bucket.def.accessor;
        });
        expect(accessors.filter(a => a === 'startFaces')).toHaveLength(1);
        expect(accessors.filter(a => a === 'endFaces')).toHaveLength(1);
        expect(accessors.filter(a => a === 'sideFaces')).toHaveLength(4);
      }
    } finally {
      index.dispose();
    }
  });

  it("offers the extrude's buckets across both solids from either top face", () => {
    const { scene, solids } = build();
    const solidIds = solids.map(s => s.id).sort();

    for (const solid of solids) {
      const faces = Explorer.findFacesWrapped(solid);
      const top = faces.findIndex(face => Math.abs(face.center().z - 25) < 1e-6);
      expect(top).toBeGreaterThanOrEqual(0);

      const result = listSelectionGroups(scene, { shapeId: solid.id, sub: { type: 'face', index: top } });
      expect(result.ok).toBe(true);
      const groups = result.ok ? result.groups : [];
      // The pick's own bucket spans both bodies, so it is a real group here.
      const own = groups.find(g => g.kind === 'classified')!;
      expect(own.label).toBe('Extrude End Faces');
      expect(own.members.map(m => m.shapeId).sort()).toEqual(solidIds);
      expect(own.members.some(m => m.shapeId === solid.id && m.sub.index === top)).toBe(true);

      const siblings = groups.filter(g => g.kind === 'sibling');
      expect(siblings.map(g => [g.label, g.members.length])).toEqual([
        ['Extrude Start Faces', 2],
        ['Extrude Side Faces', 8],
      ]);
      const starts = siblings[0].members;
      expect(starts.map(m => m.shapeId).sort()).toEqual(solidIds);
      for (const member of starts) {
        const face = Explorer.findFacesWrapped(solids.find(s => s.id === member.shapeId)!)[member.sub.index];
        expect(face.center().z).toBeCloseTo(0, 6);
      }
    }
  });

  it("double-click expansion of a start face reaches the other solid's start face", () => {
    const { scene, solids } = build();
    const solid = solids[0];
    const bottom = Explorer.findFacesWrapped(solid).findIndex(face => Math.abs(face.center().z) < 1e-6);

    const result = expandBucket(scene, { shapeId: solid.id, sub: { type: 'face', index: bottom } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accessor).toBe('startFaces');
      expect(result.members.map(m => m.shapeId).sort()).toEqual(solids.map(s => s.id).sort());
    }
  });
});
