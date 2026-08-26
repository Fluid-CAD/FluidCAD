import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import { circle } from "../../core/2d/index.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { Extrude } from "../../features/extrude.js";
import { listSelectionGroups, SelectionGroup, SelectionGroupKind } from "../../selection/selection-groups.js";
import { edgeRefsWhere, faceRefsWhere, findSolid } from "./pick-helpers.js";
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
      ['Start Edges', 4],
      ['Side Edges', 4],
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
      ['End Faces', 1],
      ['Start Faces', 1],
    ]);
    expect(siblings.every(g => g.members.every(m => m.sub.type === 'face'))).toBe(true);
    // No geometric edge groups on a face pick; box sides aren't tangent.
    expect(byKind(groups, 'same-type')).toBeUndefined();
    expect(byKind(groups, 'equal')).toBeUndefined();
    expect(byKind(groups, 'tangent')).toBeUndefined();
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
});
