import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import { SceneObject } from "../../common/scene-object.js";
import type { Edge } from "../../common/edge.js";
import type { Face } from "../../common/face.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { synthesizeSelectors, SelectorPart } from "../../selection/synthesis.js";
import { listSelectionGroups } from "../../selection/selection-groups.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { edge } from "../../filters/index.js";
import { addToScene } from "../setup.js";
import { globalContext, induceFilterCandidates } from "../../selection/filter-search.js";
import type { EdgeSource, FaceSource } from "../../selection/atoms.js";
import type { PickRef } from "../../selection/types.js";
import type { Scene } from "../../rendering/scene.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

/**
 * What the topology atoms write for picks on surfaces — and, through the
 * gate, that they stay out of an ordinary solid's picks. There is no fill
 * tool yet: the edge "where a fill meets a wall" is the edge where a test
 * surface's two faces meet (a cup: a cylinder's wall and the disc closing
 * its bottom), or where a fillet on a spline meets the flat top of a solid.
 * Every candidate below is verified by the synthesizer's oracle — the
 * builders run exactly as the emitted code would — and the scene-wide ones
 * again here.
 */

function partText(part: SelectorPart): string {
  if (part.accessor === "select") {
    return `select(${part.filterArgs})`;
  }
  return `${part.accessor}(${part.indices ? part.indices.join(", ") : part.filterArgs ?? ""})`;
}

/**
 * The ranked selector texts for the picks, winner first: through the
 * producing feature's bucket where it binds, or scene-wide, as for a
 * statement that cannot be bound to a variable.
 */
function written(scene: Scene, refs: PickRef[], route: "bucket" | "sceneWide"): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    const result = synthesizeSelectors(scene, index, attrs, [], [], false, route === "bucket" ? undefined : () => false);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok === false) {
      return [];
    }
    expect(result.groups).toHaveLength(1);
    return [result.groups[0].winner, ...result.groups[0].alternatives].map(partText);
  } finally {
    index.dispose();
  }
}

/** A surface tool's `faces` and `boundaryEdges` buckets, as the reference sources synthesis collects. */
function sourcesOf(s: SceneObject): { faces: FaceSource[]; edges: EdgeSource[] } {
  const tool = s as unknown as { faces(): SceneObject; boundaryEdges(): SceneObject };
  const sheet = s.getShapes()[0];
  return {
    faces: [{ feature: s, accessor: "faces", members: sheet.getSubShapes("face") as Face[], plane: null, resolve: () => tool.faces() }],
    edges: [{
      feature: s, accessor: "boundaryEdges",
      members: (sheet.getSubShapes("edge") as Edge[]).filter(e => (sheet as unknown as { isBoundaryEdge(raw: unknown): boolean }).isBoundaryEdge(e.getShape())),
      resolve: () => tool.boundaryEdges(),
    }],
  };
}

/**
 * The scene-wide atoms offered for the picks and every verified candidate,
 * each re-run here through the emitted builders and required to resolve to
 * exactly the picks.
 */
function sceneWide(scene: Scene, refs: PickRef[], sources: { faces: FaceSource[]; edges: EdgeSource[] } = { faces: [], edges: [] }) {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    const ctx = globalContext(scene, index, refs[0].sub.type as "edge" | "face", [], null, sources.faces, [], sources.edges);
    const pickKeys = new Set(attrs.map(a => a.pickedKey!));
    const candidates = induceFilterCandidates(index, ctx, attrs, pickKeys);
    for (const candidate of candidates) {
      expect(new Set(ctx.evaluate(candidate.builders).map(s => index.keyOf(s))), candidate.filterArgs).toEqual(pickKeys);
    }
    return { offered: ctx.instantiate(attrs).map(atom => atom.code), candidates: candidates.map(c => c.filterArgs) };
  } finally {
    index.dispose();
  }
}

const TOPOLOGY = /^\.(boundary|between|boundaryOf|adjacentTo)\(/;

/** A 20 × 20 × 10 block at x = 100, the solid beside every surface below. */
function blockBeside(): void {
  sketch("xy", () => {
    testRect(20, 20, { at: [100, 0] });
  });
  setLocation(extrude(10), 9);
}

describe("synthesis over the topology predicates", () => {
  setupOC();
  useLoadedBodies();

  it("a surface's whole rim: the boundaryEdges() bucket, or boundary() scene-wide", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const rim = edgeRefsWhere(s.getShapes()[0], m => Math.abs(m.z - 10) < 1e-6);
    expect(rim).toHaveLength(4);

    expect(written(scene, rim, "bucket")[0]).toBe("boundaryEdges()");
    expect(written(scene, rim, "sceneWide")[0]).toBe("select(edge().boundary())");
    expect(sceneWide(scene, rim).candidates[0]).toBe("edge().boundary()");
  });

  it("a loaded surface's rim, which no bucket names: boundary()", () => {
    const l = loadShapes([TopologySheets.cup(10, 20)]) as unknown as SceneObject;
    setLocation(l, 2);
    blockBeside();
    const scene = render();
    const rim = edgeRefsWhere(l.getShapes()[0], m => Math.abs(m.z - 20) < 1e-6);
    expect(rim).toHaveLength(1);

    expect(written(scene, rim, "bucket")[0]).toBe("select(edge().boundary())");
  });

  it("the edge where a surface's two faces meet: between(…), by reference and by kind", () => {
    const s = surface(() => [TopologySheets.cup(10, 20)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const seam = edgeRefsWhere(s.getShapes()[0], m => Math.abs(m.z) < 1e-6);
    expect(seam).toHaveLength(1);

    // The only edge inside the cup, and the only one between a flat face and a round one.
    const bucket = written(scene, seam, "bucket");
    expect(bucket[0]).toBe("select(edge().between({{r0}}.faces(), {{r0}}.faces()))");
    expect(bucket).toContain("select(edge().between(face().planar(), face().cylinder()))");
    expect(written(scene, seam, "sceneWide")[0]).toBe("select(edge().between(face().planar(), face().cylinder()))");

    const { offered, candidates } = sceneWide(scene, seam, sourcesOf(s));
    expect(offered).toContain(".between({{ref}}.faces(), {{ref2}}.faces())");
    expect(candidates[0]).toBe("edge().between({{r0}}.faces(), {{r0}}.faces())");
  });

  it("the edge where a fillet on a spline meets a solid's flat top: between(face().planar(), face().freeform())", () => {
    const slab = FreeformBodies.splineSlab();
    setLocation(slab, 2);
    setLocation(fillet(1.5, slab.endEdges()), 3);
    const scene = render();
    const solid = findSolid(scene);
    const onTop = edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    expect(onTop).toHaveLength(4);

    const offered = sceneWide(scene, [onTop[1]]).offered;
    expect(offered).toContain(".between(face().planar(), face().freeform())");
    expect(written(scene, [onTop[1]], "sceneWide")[0]).toBe("select(edge().between(face().planar(), face().freeform()).farthest('y'))");
  });

  it("boundaryOf() names a face group's perimeter, and adjacentTo() the faces along a rim", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const box = s.getShapes()[0];
    const sources = sourcesOf(s);

    const rim = edgeRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6);
    const onRim = sceneWide(scene, rim, sources);
    expect(onRim.offered).toContain(".boundaryOf({{ref}}.faces())");
    expect(onRim.candidates[0]).toBe("edge().boundary()");

    const [floor] = faceRefsWhere(box, m => Math.abs(m.z) < 1e-6);
    const walls = faceRefsWhere(box, () => true).filter(ref => ref.sub.index !== floor.sub.index);
    expect(walls).toHaveLength(4);
    const onWalls = sceneWide(scene, walls, sources);
    expect(onWalls.offered).toContain(".adjacentTo({{ref}}.boundaryEdges())");
    expect(onWalls.candidates[0]).toBe("face().adjacentTo({{r0}}.boundaryEdges())");
  });

  it("offers no topology atom for picks on a solid bounded by planes and cylinders", () => {
    sketch("xy", () => {
      testRect(30, 20);
    });
    const e = extrude(10);
    setLocation(e, 2);
    const scene = render();
    const solid = findSolid(scene);

    const edges = [
      edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6),
      edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6).slice(0, 1),
      edgeRefsWhere(solid, m => m.z > 1 && m.z < 9),
    ];
    for (const picks of edges) {
      expect(sceneWide(scene, picks).offered.filter(code => TOPOLOGY.test(code))).toEqual([]);
    }
    const faces = faceRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6);
    expect(sceneWide(scene, faces).offered.filter(code => TOPOLOGY.test(code))).toEqual([]);
  });
});

describe("what the topology atoms write for picks on surfaces", () => {
  setupOC();

  type Golden = { bucket: string[]; sceneWide: string[] };

  function expectWritten(scene: Scene, refs: PickRef[], picks: number, golden: Golden) {
    expect(refs).toHaveLength(picks);
    expect(written(scene, refs, "bucket")).toEqual(golden.bucket);
    expect(written(scene, refs, "sceneWide")).toEqual(golden.sceneWide);
  }

  it("a cup beside a block: its seam with the floor, its rim", () => {
    const s = surface(() => [TopologySheets.cup(10, 20)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const cup = s.getShapes()[0];

    expectWritten(scene, edgeRefsWhere(cup, m => Math.abs(m.z) < 1e-6), 1, {
      bucket: [
        "select(edge().between({{r0}}.faces(), {{r0}}.faces()))",
        "select(edge().between(face().planar(), face().cylinder()))",
        "select(edge().circle().onPlane('xy'))",
      ],
      sceneWide: [
        "select(edge().between(face().planar(), face().cylinder()))",
        "select(edge().circle().onPlane('xy'))",
        "select(edge().ofSurface().onPlane('xy'))",
      ],
    });
    expectWritten(scene, edgeRefsWhere(cup, m => Math.abs(m.z - 20) < 1e-6), 1, {
      bucket: ["boundaryEdges()", "boundaryEdges(0)"],
      sceneWide: ["select(edge().boundary())", "select(edge().farthest('z'))", "select(edge().circle().nth('z', 1))"],
    });
  });

  it("an open box beside a block: its rim, one rim edge, the folds round its floor", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const box = s.getShapes()[0];

    expectWritten(scene, edgeRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6), 4, {
      bucket: ["boundaryEdges()", "boundaryEdges(0, 1, 2, 3)"],
      sceneWide: [
        "select(edge().boundary())",
        "select(edge().ofSurface().farthest('z'))",
        "select(edge().parallelTo('xy').farthest('z').smallest())",
      ],
    });
    expectWritten(scene, edgeRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6).slice(0, 1), 1, {
      bucket: [
        "boundaryEdges(edge().onPlane('yz'))",
        "boundaryEdges(edge().nearest('x'))",
        "boundaryEdges(edge().verticalTo('xz').nth('x', -2))",
        "boundaryEdges(0)",
      ],
      sceneWide: [
        "select(edge().boundary().onPlane('yz'))",
        "select(edge().onPlane('yz').farthest('z'))",
        "select(edge().verticalTo('xz').ofSurface().nearest('x').farthest('z'))",
      ],
    });
    expectWritten(scene, edgeRefsWhere(box, m => Math.abs(m.z) < 1e-6), 4, {
      bucket: [
        "select(edge().onPlane('xy').ofSurface())",
        "select(edge().below({{r0}}.endFaces()).ofSurface())",
        "select(edge().onPlane({{r0}}.startFaces()).ofSurface())",
      ],
      sceneWide: [
        "select(edge().onPlane('xy').ofSurface())",
        "select(edge().ofSurface().nearest('z'))",
        "select(edge().parallelTo('xy').between(face().planar(), face().planar()).smallest())",
      ],
    });
  });

  it("a plate with a square hole: the hole's four edges, every rim edge", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const plate = s.getShapes()[0];

    expectWritten(scene, edgeRefsWhere(plate, m => Math.max(Math.abs(m.x), Math.abs(m.y)) < 10), 4, {
      bucket: [
        "boundaryEdges(edge().smallest())",
        "boundaryEdges(4, 5, 6, 7)",
        "boundaryEdges(edge().line(10))",
        "boundaryEdges(edge().below('xz', 10).below('yz', 10))",
      ],
      sceneWide: [
        "select(edge().boundary().smallest())",
        "select(edge().ofSurface().smallest())",
        "select(edge().below('yz', 10).line(10))",
      ],
    });
    expectWritten(scene, edgeRefsWhere(plate, () => true), 8, {
      bucket: ["boundaryEdges()", "boundaryEdges(0, 1, 2, 3, 4, 5, 6, 7)"],
      sceneWide: ["select(edge().boundary())", "select(edge().ofSurface())", "select(edge().below('yz', 60))"],
    });
  });
});

/** The right-click `loop` group a pick offers (the one labelled `label`, else the first). */
function loopGroup(scene: Scene, seed: PickRef, label?: string): PickRef[] {
  const result = listSelectionGroups(scene, seed);
  expect(result.ok).toBe(true);
  const loops = result.ok ? result.groups.filter(g => g.kind === "loop") : [];
  const group = label ? loops.find(g => g.label === label) : loops[0];
  expect(group, `no loop group ${label ?? ""}`).toBeDefined();
  return group!.members;
}

/** The ranked selector texts for a loop chain — a `loop` group kept whole — winner first. */
function writtenLoop(scene: Scene, seed: PickRef, members: PickRef[], route: "bucket" | "sceneWide"): string[] {
  const index = new SelectionIndex(scene);
  try {
    const chain = {
      seed: attributePick(scene, index, seed),
      members: members.map(ref => attributePick(scene, index, ref)),
      kind: "loop" as const,
    };
    const result = synthesizeSelectors(scene, index, [], [chain], [], false, route === "bucket" ? undefined : () => false);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok === false) {
      return [];
    }
    expect(result.groups).toHaveLength(1);
    return [result.groups[0].winner, ...result.groups[0].alternatives].map(partText);
  } finally {
    index.dispose();
  }
}

/** A `.withChain()` form always carries its seed rule: `at(k)`, or a rank as the stage before it. */
const SEEDED_CHAIN = /(\.at\(\d+\)|\.(nearest|farthest)\('[xyz]'\)|\.(largest|smallest)\(('radius')?\))\.withChain\(\)\)$/;

function expectSeeded(texts: string[]) {
  for (const text of texts.filter(t => t.includes(".withChain()"))) {
    expect(text).toMatch(SEEDED_CHAIN);
  }
}

/** Which of a 30-wide plate's two square loops an edge lies on, read from its middle. */
const squareOf = (mid: { x: number; y: number }) => Math.max(Math.abs(mid.x), Math.abs(mid.y)) > 10 ? "outer" : "inner";

describe("loop chains: a loop group written as a loop", () => {
  setupOC();

  it("a loop of a surface with two loops: a seed rule and withChain(), in the bucket and scene-wide", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const plate = s.getShapes()[0];
    const [inner] = edgeRefsWhere(plate, m => squareOf(m) === "inner");
    const [outer] = edgeRefsWhere(plate, m => squareOf(m) === "outer");

    const innerLoop = loopGroup(scene, inner, "Boundary Loop");
    const bucket = writtenLoop(scene, inner, innerLoop, "bucket");
    expect(bucket[0]).toBe("boundaryEdges(edge().smallest().withChain())");
    expect(bucket).toContain("boundaryEdges(edge().at(4).withChain())");
    const wide = writtenLoop(scene, inner, innerLoop, "sceneWide");
    expect(wide[0]).toBe("select(edge().boundary().smallest().withChain())");
    expectSeeded([...bucket, ...wide]);

    const outerLoop = loopGroup(scene, outer, "Boundary Loop");
    expect(writtenLoop(scene, outer, outerLoop, "bucket")[0]).toBe("boundaryEdges(edge().nearest('x').withChain())");
  });

  it("runs the loop's code as written: the bucket form takes exactly the hole's loop", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]);
    const loop = s.boundaryEdges(edge().smallest().withChain()) as unknown as SceneObject;
    addToScene(loop);
    const scene = render();
    const plate = (s as unknown as SceneObject).getShapes()[0];
    const [inner] = edgeRefsWhere(plate, m => squareOf(m) === "inner");
    const shapes = loop.getShapes();
    expect(shapes).toHaveLength(4);
    const index = new SelectionIndex(scene);
    try {
      const expected = new Set(loopGroup(scene, inner).map(ref => attributePick(scene, index, ref).pickedKey));
      expect(new Set(shapes.map(shape => index.keyOf(shape)))).toEqual(expected);
    } finally {
      index.dispose();
    }
  });

  it("a hole no rank tells from its twin: at(k), ahead of a filter that bakes a dimension", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHoles(40, 6, [[10, 20], [25, 20]])]) as unknown as SceneObject;
    setLocation(s, 2);
    const scene = render();
    const plate = s.getShapes()[0];
    const [left] = edgeRefsWhere(plate, m => m.x > 5 && m.x < 15 && m.y > 15 && m.y < 25);
    const loop = loopGroup(scene, left);
    expect(loop).toHaveLength(4);

    const bucket = writtenLoop(scene, left, loop, "bucket");
    expect(bucket[0]).toMatch(/^boundaryEdges\(edge\(\)\.at\(\d+\)\.withChain\(\)\)$/);
    expect(bucket[1]).toBe("boundaryEdges(edge().below('yz', 20).line(6))");
    expect(writtenLoop(scene, left, loop, "sceneWide")[0]).toMatch(/^select\(edge\(\)\.boundary\(\)\.at\(\d+\)\.withChain\(\)\)$/);
  });

  it("the whole rim of a one-loop surface: the plain bucket, or boundary()", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    blockBeside();
    const scene = render();
    const [rimEdge] = edgeRefsWhere(s.getShapes()[0], m => Math.abs(m.z - 10) < 1e-6);
    const loop = loopGroup(scene, rimEdge, "Boundary Loop");
    expect(loop).toHaveLength(4);

    expect(writtenLoop(scene, rimEdge, loop, "bucket")[0]).toBe("boundaryEdges()");
    expect(writtenLoop(scene, rimEdge, loop, "sceneWide")[0]).toBe("select(edge().boundary())");
  });

  it("a face's loop on a solid keeps the atoms that always described it", () => {
    sketch("xy", () => {
      testRect(30, 30, { at: [-15, -15] });
      testRect(10, 10, { at: [-5, -5] });
    });
    setLocation(extrude(10), 2);
    const scene = render();
    const solid = findSolid(scene);
    const [holeTop] = edgeRefsWhere(solid, m => Math.abs(m.y + 5) < 1e-6 && Math.abs(m.z - 10) < 1e-6);
    const hole = loopGroup(scene, holeTop, "Hole Loop of Planar Face");

    const bucket = writtenLoop(scene, holeTop, hole, "bucket");
    expect(bucket).toEqual(["endEdges(edge().smallest())", "endEdges(4, 5, 6, 7)"]);
    expect(writtenLoop(scene, holeTop, hole, "sceneWide").every(text => !text.includes("withChain"))).toBe(true);
  });

  it("connected faces of a kind: the kind, a seed rule and withChain()", () => {
    const tube = surface(() => [TopologySheets.squareTube(10, 10, 20)]) as unknown as SceneObject;
    setLocation(tube, 2);
    const box = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    setLocation(box, 3);
    const scene = render();
    const [floor] = faceRefsWhere(box.getShapes()[0], m => Math.abs(m.z) < 1e-6);
    const flats = loopGroup(scene, floor, "Connected Planar Faces");
    expect(flats).toHaveLength(5);

    expect(writtenLoop(scene, floor, flats, "bucket")[0]).toBe("faces()");
    const wide = writtenLoop(scene, floor, flats, "sceneWide");
    expect(wide[0]).toBe("select(face().planar().nearest('z').withChain())");
    expectSeeded(wide);
  });

  it("a loop chain reaches synthesis through the apply request, kind and all", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    setLocation(s, 2);
    const scene = render();
    const [inner] = edgeRefsWhere(s.getShapes()[0], m => squareOf(m) === "inner");
    const loop = loopGroup(scene, inner, "Boundary Loop");

    // As a loop it is written as one; the same edges as a tangent chain (no kind) are not.
    const asLoop = synthesizeApplyFeature(scene, loop, "project", undefined, [{ seed: inner, members: loop, kind: "loop" }]);
    expect(asLoop.ok && asLoop.args).toBe("f.boundaryEdges(edge().smallest().withChain())");
    const asTangent = synthesizeApplyFeature(scene, loop, "project", undefined, [{ seed: inner, members: loop }]);
    expect(asTangent.ok && asTangent.args).toBe("f.boundaryEdges(edge().smallest())");
  });
});
