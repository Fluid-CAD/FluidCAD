import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import { circle, line, arc, spline } from "../../core/2d/index.js";
import revolve from "../../core/revolve.js";
import loft from "../../core/loft.js";
import plane from "../../core/plane.js";
import { FaceProps } from "../../oc/face-props.js";
import type { PickRef } from "../../selection/types.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { Extrude } from "../../features/extrude.js";
import { listSelectionGroups, SelectionGroup, SelectionGroupKind } from "../../selection/selection-groups.js";
import { Solid } from "../../common/solid.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, findSolids } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";

function groupsFor(result: ReturnType<typeof listSelectionGroups>): SelectionGroup[] {
  expect(result.ok).toBe(true);
  return result.ok ? result.groups : [];
}

function byKind(groups: SelectionGroup[], kind: SelectionGroupKind): SelectionGroup | undefined {
  return groups.find(g => g.kind === kind);
}

describe("selection groups (right-click multi-select menu)", () => {
  setupOC();

  it("offers classified, same-type and equal-length groups for a box edge", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(30);

    const scene = render();
    const solid = findSolid(scene);
    // A top edge along x (length 100).
    const seeds = edgeRefsWhere(solid, m => Math.abs(m.y) < 1e-6 && Math.abs(m.z - 30) < 1e-6);
    expect(seeds).toHaveLength(1);

    const groups = groupsFor(listSelectionGroups(scene, seeds[0]));

    // Box corners are square — no tangent chain beyond the seed.
    expect(byKind(groups, 'tangent')).toBeUndefined();

    const classified = byKind(groups, 'classified')!;
    expect(classified.label).toBe('Extrude End Edges');
    expect(classified.members).toHaveLength(4);
    expect(classified.members.some(m =>
      m.shapeId === seeds[0].shapeId && m.sub.index === seeds[0].sub.index)).toBe(true);

    // "Select other": the extrude's other edge buckets.
    const siblings = groups.filter(g => g.kind === 'sibling');
    expect(siblings.map(g => [g.label, g.members.length])).toEqual([
      ['Extrude Start Edges', 4],
      ['Extrude Side Edges', 4],
    ]);

    const sameType = byKind(groups, 'same-type')!;
    expect(sameType.label).toBe('All Lines');
    expect(sameType.members).toHaveLength(12);

    // The four length-100 edges (top and bottom pairs).
    const equal = byKind(groups, 'equal')!;
    expect(equal.label).toBe('Equal Length Lines');
    expect(equal.members).toHaveLength(4);
    for (const m of equal.members) {
      const edge = Explorer.findEdgesWrapped(solid)[m.sub.index];
      expect(EdgeProps.getProperties(edge.getShape()).length).toBeCloseTo(100, 6);
    }
  });

  it("offers the tangent chain on a rounded rim, and drops an equal group identical to its same-type group", () => {
    sketch("xy", () => {
        testRect(100, 50);
        fillet(5);
      });
    extrude(20);

    const scene = render();
    const solid = findSolid(scene);

    // A straight top-rim edge: tangent chain covers the whole rim (4 lines + 4 arcs).
    const lineSeed = edgeRefsWhere(solid, m => Math.abs(m.y) < 1e-6 && Math.abs(m.z - 20) < 1e-6);
    expect(lineSeed).toHaveLength(1);
    const lineGroups = groupsFor(listSelectionGroups(scene, lineSeed[0]));
    const tangent = byKind(lineGroups, 'tangent')!;
    expect(tangent.label).toBe('Tangent Edges');
    expect(tangent.members).toHaveLength(8);
    expect(byKind(lineGroups, 'classified')!.label).toBe('Extrude End Edges');

    // An arc: every arc in the solid shares the fillet radius, so the equal
    // group would duplicate "All Arcs" and is omitted.
    const arcSeed = edgeRefsWhere(solid, m =>
      Math.abs(m.z - 20) < 1e-6 && m.x < 5 && m.y < 5);
    expect(arcSeed).toHaveLength(1);
    const arcGroups = groupsFor(listSelectionGroups(scene, arcSeed[0]));
    const arcs = byKind(arcGroups, 'same-type')!;
    expect(arcs.label).toBe('All Arcs');
    expect(arcs.members).toHaveLength(8);
    expect(byKind(arcGroups, 'equal')).toBeUndefined();
  });

  it("groups equal-radius hole rims apart from differently sized ones", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const e = extrude(10) as Extrude;
    sketch(e.endFaces(), () => {
      circle([25, 25], 16);
    });
    cut(10);
    sketch(e.endFaces(), () => {
      circle([70, 25], 30);
    });
    cut(10);

    const scene = render();
    const solid = findSolid(scene);
    // The small hole's top rim (radius 8 around x=25).
    const seeds = edgeRefsWhere(solid, m =>
      Math.abs(m.z - 10) < 1e-6 && Math.abs(m.x - 25) < 8.5 && m.x > 16);
    expect(seeds).toHaveLength(1);

    const groups = groupsFor(listSelectionGroups(scene, seeds[0]));
    expect(byKind(groups, 'same-type')!.label).toBe('All Circles');
    expect(byKind(groups, 'same-type')!.members).toHaveLength(4);

    const equal = byKind(groups, 'equal')!;
    expect(equal.label).toBe('Equal Radius Circles');
    expect(equal.members).toHaveLength(2);
  });

  it("never counts a cylinder's seam in the same-type or equal-length groups", () => {
    // A spoke half as tall as its round boss, joined at the boss's +X side:
    // above the spoke the boss's face still wraps all the way round, so its
    // seam survives there as a 15 mm line — as long as the spoke's vertical
    // edges, but never drawn. A group counting it would select more than the
    // viewport shows (the handwheel's "17 of 16 spoke junctions").
    sketch("xy", () => {
      circle([0, 0], 40);
    });
    extrude(30);
    sketch("xy", () => {
      testRect(40, 10, { at: [10, -5] });
    });
    extrude(15);

    const scene = render();
    expect(findSolids(scene)).toHaveLength(1);
    const solid = findSolid(scene) as Solid;
    const raw = Explorer.findEdgesWrapped(solid);
    const isLine15 = (index: number) => {
      const props = EdgeProps.getProperties(raw[index].getShape());
      return props.curveType === 'line' && Math.abs(props.length! - 15) < 1e-6;
    };
    const seams = raw.map((_, i) => i).filter(i => isLine15(i) && solid.isHiddenEdge(raw[i].getShape()));
    expect(seams).toHaveLength(1);

    // The spoke's outer corner at (50, -5).
    const seeds = edgeRefsWhere(solid, m => Math.abs(m.x - 50) < 1e-6 && Math.abs(m.y + 5) < 1e-6 && Math.abs(m.z - 7.5) < 1e-6);
    expect(seeds).toHaveLength(1);
    const groups = groupsFor(listSelectionGroups(scene, seeds[0]));

    const sameType = byKind(groups, 'same-type')!;
    expect(sameType.members.some(m => m.sub.index === seams[0])).toBe(false);

    // The spoke's two outer corners and its two junctions with the boss.
    const equal = byKind(groups, 'equal')!;
    expect(equal.label).toBe('Equal Length Lines');
    expect(equal.members).toHaveLength(4);
    for (const m of equal.members) {
      expect(isLine15(m.sub.index)).toBe(true);
      expect(solid.isHiddenEdge(raw[m.sub.index].getShape())).toBe(false);
    }
  });

  it("offers face groups (classified only) for a face pick", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(30);

    const scene = render();
    const solid = findSolid(scene);
    // A side face: every edge midpoint sits on y = 0.
    const seeds = faceRefsWhere(solid, m => Math.abs(m.y) < 1e-6);
    expect(seeds).toHaveLength(1);

    const groups = groupsFor(listSelectionGroups(scene, seeds[0]));
    const classified = byKind(groups, 'classified')!;
    expect(classified.label).toBe('Extrude Side Faces');
    expect(classified.members).toHaveLength(4);
    expect(classified.members.every(m => m.sub.type === 'face')).toBe(true);
    // "Select other": the extrude's other FACE buckets (single members kept).
    const siblings = groups.filter(g => g.kind === 'sibling');
    expect(siblings.map(g => [g.label, g.members.length])).toEqual([
      ['Extrude End Faces', 1],
      ['Extrude Start Faces', 1],
    ]);
    expect(siblings.every(g => g.members.every(m => m.sub.type === 'face'))).toBe(true);
    // No geometric edge groups on a face pick; box sides aren't tangent.
    expect(byKind(groups, 'same-type')).toBeUndefined();
    expect(byKind(groups, 'equal')).toBeUndefined();
    expect(byKind(groups, 'tangent')).toBeUndefined();
  });

  it("offers All Splines for a spline edge, with no equal group", () => {
    sketch("xy", () => {
      line([0, 0], [40, 0]);
      spline([40, 0], [44, 10], [36, 20], [40, 30]);
      line([40, 30], [0, 30]);
      spline([0, 30], [4, 20], [-4, 10], [0, 0]);
    });
    extrude(10);

    const scene = render();
    const solid = findSolid(scene);
    const splines: PickRef[] = [];
    Explorer.findEdgesWrapped(solid).forEach((e, index) => {
      if (EdgeProps.getProperties(e.getShape()).curveType === 'spline') {
        splines.push({ shapeId: solid.id, sub: { type: 'edge', index } });
      }
    });
    expect(splines).toHaveLength(4);

    const groups = groupsFor(listSelectionGroups(scene, splines[0]));
    const sameType = byKind(groups, 'same-type')!;
    expect(sameType.label).toBe('All Splines');
    expect(sameType.members.map(m => m.sub.index).sort()).toEqual(splines.map(m => m.sub.index).sort());
    expect(byKind(groups, 'equal')).toBeUndefined();
  });

  /** The refs of every face of `solid` whose surface type is `type`. */
  function facesOfType(solid: Solid, type: string): PickRef[] {
    const refs: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      if (FaceProps.getProperties(f.getShape()).surfaceType === type) {
        refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    return refs;
  }

  it("offers All Spheres for a spherical face", () => {
    // A capsule: two hemispherical ends around a cylindrical middle.
    sketch("xz", () => {
      arc([0, -10], [10, 0], [0, 0]);
      line([10, 0], [10, 20]);
      arc([10, 20], [0, 30], [0, 20]);
      line([0, 30], [0, -10]);
    });
    revolve("z");

    const scene = render();
    const solid = findSolid(scene) as Solid;
    const spheres = facesOfType(solid, 'sphere');
    expect(spheres).toHaveLength(2);

    const sameType = byKind(groupsFor(listSelectionGroups(scene, spheres[0])), 'same-type')!;
    expect(sameType.label).toBe('All Spheres');
    expect(sameType.members).toEqual(spheres);
  });

  it("offers All Freeform Faces for a free-form face, and nothing for a plane", () => {
    // A loft from a square to a circle: four free-form walls between flat ends.
    const base = sketch(plane("xy", 0), () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const top = sketch(plane("xy", 20), () => {
      circle([0, 0], 12);
    });
    loft(base, top);

    const scene = render();
    const solid = findSolid(scene) as Solid;
    const walls = facesOfType(solid, 'freeform');
    expect(walls.length).toBeGreaterThan(1);

    const sameType = byKind(groupsFor(listSelectionGroups(scene, walls[0])), 'same-type')!;
    expect(sameType.label).toBe('All Freeform Faces');
    expect(sameType.members).toEqual(walls);

    const ends = facesOfType(solid, 'plane');
    expect(byKind(groupsFor(listSelectionGroups(scene, ends[0])), 'same-type')).toBeUndefined();
  });

  it("reports a clear reason for an unresolvable pick", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    extrude(30);

    const scene = render();
    const result = listSelectionGroups(scene, { shapeId: 'nope', sub: { type: 'edge', index: 0 } });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('does not resolve');
    }
  });

  it("prefixes sibling labels with the feature and drops a single-member own bucket (bore circles)", async () => {
    // A cut sketched on the body's top face runs sketch-side to exit, so its
    // start is the solid's top and its end the bottom. The sibling labels
    // carry the feature prefix ("Cut End Edges") so they read as the cut's
    // frame, not as a name for the picked circle; the pick's own
    // single-member bucket selects nothing new and stays out of the menu.
    sketch("xy", () => {
      circle([0, 0], 72);
    });
    const body = extrude(34) as Extrude;
    sketch(body.endFaces(), () => {
      circle([0, 0], 30);
    });
    cut();

    const scene = render();
    const solid = findSolid(scene);
    const topCircle = edgeRefsWhere(solid, m =>
      Math.abs(m.z - 34) < 1e-6 && Math.hypot(m.x, m.y) < 20);
    expect(topCircle).toHaveLength(1);

    const groups = groupsFor(listSelectionGroups(scene, topCircle[0]));

    // No group for the pick's own single-member bucket, and no unprefixed
    // accessor labels anywhere.
    expect(groups.some(g => g.label === 'Cut Start Edges')).toBe(false);
    expect(groups.some(g => g.label.startsWith('End Edges'))).toBe(false);

    const siblings = groups.filter(g => g.kind === 'sibling');
    expect(siblings.map(g => g.label)).toContain('Cut End Edges');
    const endEdges = siblings.find(g => g.label === 'Cut End Edges')!;
    expect(endEdges.members).toHaveLength(1);
    // The sibling really is the other circle, at the cut's exit side (z=0).
    const endEdge = Explorer.findEdgesWrapped(solid)[endEdges.members[0].sub.index];
    expect(EdgeProps.getProperties(endEdge.getShape()).curveType).toBe('circle');
    const { EdgeOps } = await import("../../oc/edge-ops.js");
    expect(EdgeOps.getEdgeMidPoint(endEdge).z).toBeCloseTo(0, 6);
  });
});
