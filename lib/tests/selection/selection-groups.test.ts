import { describe, it, expect, vi } from "vitest";
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
import type { Shape } from "../../common/shape.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, findSolids } from "./pick-helpers.js";
import { testRect } from "../helpers/profiles.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";
import { TestSheets } from "../helpers/sheets.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import type { SceneObject } from "../../common/scene-object.js";

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

  it("classifies the seed alone when no group names its kind, and leaves no wrapper of its own behind", () => {
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
    const [flatEnd] = facesOfType(solid, 'plane');
    const [wall] = facesOfType(solid, 'freeform');
    // The body's own face and edge lists, which it keeps: the groups read them.
    const kept = new Set<unknown>([...solid.getIndexedShapes('face'), ...solid.getIndexedShapes('edge')]);

    const made: Shape[] = [];
    const wraps = [vi.spyOn(Explorer, 'findFacesWrapped'), vi.spyOn(Explorer, 'findEdgesWrapped')];
    const classified = vi.spyOn(FaceProps, 'of');
    try {
      const onPlane = groupsFor(listSelectionGroups(scene, flatEnd));
      expect(byKind(onPlane, 'same-type')).toBeUndefined();
      // The seed is read, a plane has no group, and no other face is classified.
      expect(classified.mock.calls.map(([face]) => face)).toEqual([solid.getIndexedShapes('face')[flatEnd.sub.index]]);

      classified.mockClear();
      const onWall = byKind(groupsFor(listSelectionGroups(scene, wall)), 'same-type')!;
      expect(onWall.members).toHaveLength(4);
      // Every face is read off the body's kept wrappers, whose classes stay with them.
      expect(classified.mock.calls.every(([face]) => kept.has(face))).toBe(true);

      for (const wrap of wraps) {
        made.push(...wrap.mock.results.flatMap(result => result.value as Shape[]));
      }
    } finally {
      classified.mockRestore();
      wraps.forEach(wrap => wrap.mockRestore());
    }
    // What a right-click wrapped to resolve its pick is freed again; the body's own lists are untouched.
    expect(made.length).toBeGreaterThan(0);
    expect(made.filter(shape => !shape.isReleased())).toEqual([]);
    expect([...kept].every(shape => !(shape as Shape).isReleased())).toBe(true);
  });

  it("reads an edge's groups off the body's kept edges, and nothing at all for a seam", () => {
    sketch("xy", () => {
      circle([0, 0], 40);
    });
    extrude(10);
    const scene = render();
    const solid = findSolid(scene) as Solid;
    const indexed = solid.getIndexedShapes('edge');
    const seam = indexed.findIndex(edge => !solid.getEdges().includes(edge as never));
    const rim = indexed.findIndex(edge => solid.getEdges().includes(edge as never));
    expect(seam).toBeGreaterThanOrEqual(0);

    const classified = vi.spyOn(EdgeProps, 'of');
    try {
      const circles = byKind(groupsFor(listSelectionGroups(scene, { shapeId: solid.id, sub: { type: 'edge', index: rim } })), 'same-type')!;
      expect(circles.label).toBe('All Circles');
      // The seam is a line the viewport never draws: it joins no group and is never classified for one.
      expect(circles.members.map(m => m.sub.index)).not.toContain(seam);
      expect(classified.mock.calls.every(([edge]) => indexed.includes(edge) && edge !== indexed[seam])).toBe(true);
    } finally {
      classified.mockRestore();
    }
    const onSeam = groupsFor(listSelectionGroups(scene, { shapeId: solid.id, sub: { type: 'edge', index: seam } }));
    expect(onSeam.filter(g => g.kind === 'same-type' || g.kind === 'equal')).toEqual([]);
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

describe("loop groups (right-click)", () => {
  setupOC();
  useLoadedBodies();

  const loops = (groups: SelectionGroup[]) => groups.filter(g => g.kind === 'loop');
  const mid = (shape: Shape, ref: PickRef) => EdgeOps.getEdgeMidPoint(Explorer.findEdgesWrapped(shape)[ref.sub.index]);
  /** Which of a 30-wide plate's two square loops an edge lies on, read from its middle. */
  const squareOf = (shape: Shape, ref: PickRef) => {
    const m = mid(shape, ref);
    return Math.max(Math.abs(m.x), Math.abs(m.y)) > 10 ? 'outer' : 'inner';
  };

  it("offers a rim edge of a surface its Boundary Loop, and no face loop", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    const scene = render();
    const sheet = s.getShapes()[0];
    const all = edgeRefsWhere(sheet, () => true);
    expect(all).toHaveLength(8);

    for (const seed of all) {
      const offered = loops(groupsFor(listSelectionGroups(scene, seed)));
      expect(offered.map(g => g.label)).toEqual(['Boundary Loop']);
      const members = offered[0].members;
      expect(members).toHaveLength(4);
      expect(members).toContainEqual(seed);
      expect(new Set(members.map(m => squareOf(sheet, m)))).toEqual(new Set([squareOf(sheet, seed)]));
    }
  });

  it("offers a loaded surface's rim edge its loop too, though it has no bucket", () => {
    const l = loadShapes([TopologySheets.squareTube(10, 10, 20)]) as unknown as SceneObject;
    const scene = render();
    const tube = l.getShapes()[0];
    const [bottom] = edgeRefsWhere(tube, m => Math.abs(m.z) < 1e-6);

    const offered = loops(groupsFor(listSelectionGroups(scene, bottom)));
    expect(offered.map(g => [g.label, g.members.length])).toEqual([['Boundary Loop', 4]]);
    expect(offered[0].members.every(m => Math.abs(mid(tube, m).z) < 1e-6)).toBe(true);
  });

  it("offers an edge of a solid the loop of each face it bounds, numbered when their names coincide", () => {
    sketch("xy", () => {
      testRect(30, 30, { at: [-15, -15] });
      testRect(10, 10, { at: [-5, -5] });
    });
    extrude(10);
    const scene = render();
    const solid = findSolid(scene);

    // A top edge of the outer square: the top face's outer loop and the side wall's.
    const [outerTop] = edgeRefsWhere(solid, m => Math.abs(m.y + 15) < 1e-6 && Math.abs(m.z - 10) < 1e-6);
    const outer = loops(groupsFor(listSelectionGroups(scene, outerTop)));
    expect(outer.map(g => g.label).sort()).toEqual(['Outer Loop of Planar Face 1', 'Outer Loop of Planar Face 2']);
    for (const group of outer) {
      expect(group.members).toHaveLength(4);
      expect(group.members).toContainEqual(outerTop);
    }
    const onTop = outer.find(g => g.members.every(m => Math.abs(mid(solid, m).z - 10) < 1e-6))!;
    expect(onTop.members.every(m => squareOf(solid, m) === 'outer')).toBe(true);

    // A top edge of the hole: the top face's hole loop, and the hole wall's outer loop.
    const [holeTop] = edgeRefsWhere(solid, m => Math.abs(m.y + 5) < 1e-6 && Math.abs(m.z - 10) < 1e-6);
    const hole = loops(groupsFor(listSelectionGroups(scene, holeTop)));
    expect(hole.map(g => g.label).sort()).toEqual(['Hole Loop of Planar Face', 'Outer Loop of Planar Face']);
    const holeLoop = hole.find(g => g.label === 'Hole Loop of Planar Face')!;
    expect(holeLoop.members).toHaveLength(4);
    expect(holeLoop.members.every(m => squareOf(solid, m) === 'inner' && Math.abs(mid(solid, m).z - 10) < 1e-6)).toBe(true);
  });

  it("offers an interior edge of a surface the loops of its two faces, and leaves a seam out of a cylinder's loop", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    sketch("xy", () => {
      circle([100, 0], 20);
    });
    extrude(10);
    const scene = render();
    const box = s.getShapes()[0];
    // A fold between the floor and a wall.
    const [fold] = edgeRefsWhere(box, m => Math.abs(m.z) < 1e-6 && Math.abs(m.y) < 1e-6);
    const folds = loops(groupsFor(listSelectionGroups(scene, fold)));
    expect(folds.map(g => [g.label, g.members.length])).toEqual([
      ['Outer Loop of Planar Face 1', 4],
      ['Outer Loop of Planar Face 2', 4],
    ]);

    // The cylinder's top circle: its wall's outer loop holds both circles, never the seam;
    // the disc's loop is the circle alone, which is no group.
    const cylinder = findSolid(scene);
    const [rim] = edgeRefsWhere(cylinder, m => Math.abs(m.z - 10) < 1e-6);
    const onRim = loops(groupsFor(listSelectionGroups(scene, rim)));
    expect(onRim.map(g => [g.label, g.members.length])).toEqual([['Outer Loop of Cylindrical Face', 2]]);
  });

  it("offers a face its connected faces of the same kind, and nothing when it has no such neighbour", () => {
    sketch("xy", () => {
      testRect(100, 50);
      fillet(5);
    });
    extrude(20);
    const scene = render();
    const solid = findSolid(scene) as Solid;

    // The top reaches the bottom through the four flat sides; the four rounded corners stay out.
    const [top] = faceRefsWhere(solid, m => Math.abs(m.z - 20) < 1e-6);
    const connected = loops(groupsFor(listSelectionGroups(scene, top)));
    expect(connected.map(g => [g.label, g.members.length])).toEqual([['Connected Planar Faces', 6]]);
    expect(connected[0].members).toContainEqual(top);

    // A rounded corner touches only flats: no corner is its neighbour.
    const [corner] = facesOfKind(solid, 'cylinder');
    expect(loops(groupsFor(listSelectionGroups(scene, corner)))).toEqual([]);

    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    const scene2 = render();
    const box = s.getShapes()[0];
    const [floor] = faceRefsWhere(box, m => Math.abs(m.z) < 1e-6);
    const flats = loops(groupsFor(listSelectionGroups(scene2, floor)));
    expect(flats.map(g => [g.label, g.members.length])).toEqual([['Connected Planar Faces', 5]]);
    expect(flats[0].members).toContainEqual(floor);
  });

  /** The refs of every face of `solid` whose surface type is `type`. */
  function facesOfKind(solid: Solid, type: string): PickRef[] {
    const refs: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      if (FaceProps.getProperties(f.getShape()).surfaceType === type) {
        refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    return refs;
  }
});
