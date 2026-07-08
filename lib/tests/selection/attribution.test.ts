import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
import part from "../../core/part.js";
import select from "../../core/select.js";
import repeat from "../../core/repeat.js";
import { circle, move, rect } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Edge } from "../../common/edge.js";
import { Extrude } from "../../features/extrude.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { explainSelection, synthesizeApplyFeature } from "../../selection/explain.js";
import { expandBucket, expandTangentChain } from "../../selection/expand.js";
import type { PickRef } from "../../selection/types.js";

function findSolids(scene: Scene): Shape[] {
  const solids: Shape[] = [];
  const seen = new Set<string>();
  for (const obj of scene.getAllSceneObjects()) {
    if (obj.isContainer()) {
      continue; // containers re-expose their children's shapes
    }
    for (const shape of obj.getShapes()) {
      if (shape.getType() === "solid" && !seen.has(shape.id)) {
        seen.add(shape.id);
        solids.push(shape);
      }
    }
  }
  return solids;
}

function findSolid(scene: Scene): Shape {
  const solids = findSolids(scene);
  expect(solids.length).toBeGreaterThan(0);
  return solids[0];
}

function allEdgeRefs(solid: Shape): PickRef[] {
  return Explorer.findEdgesWrapped(solid).map((_, index) => ({
    shapeId: solid.id,
    sub: { type: 'edge' as const, index },
  }));
}

/** Refs of the solid's edges whose midpoint satisfies `where`. */
function edgeRefsWhere(solid: Shape, where: (mid: { x: number; y: number; z: number }) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findEdgesWrapped(solid).forEach((e: Edge, index: number) => {
    const mid = EdgeOps.getEdgeMidPoint(e);
    if (where(mid)) {
      refs.push({ shapeId: solid.id, sub: { type: 'edge', index } });
    }
  });
  return refs;
}

function setLocation(obj: unknown, line: number) {
  (obj as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line, column: 0 });
}

/** Refs of the solid's faces where every edge midpoint satisfies `where`. */
function faceRefsWhere(solid: Shape, where: (mid: { x: number; y: number; z: number }) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findFacesWrapped(solid).forEach((f, index) => {
    const mids = f.getEdges().map(e => EdgeOps.getEdgeMidPoint(e));
    if (mids.length > 0 && mids.every(where)) {
      refs.push({ shapeId: solid.id, sub: { type: 'face', index } });
    }
  });
  return refs;
}

describe("selection attribution", () => {
  setupOC();

  it("attributes every edge of a plain extruded box to the right bucket", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    const scene = render();
    const solid = findSolid(scene);
    const refs = allEdgeRefs(solid);
    expect(refs).toHaveLength(12);

    const result = explainSelection(scene, refs);
    const byAccessor = new Map<string, number>();
    for (const pick of result.picks) {
      expect(pick.attributed).toBe(true);
      expect(pick.producer!.featureType).toBe("extrude");
      byAccessor.set(pick.producer!.accessor, (byAccessor.get(pick.producer!.accessor) ?? 0) + 1);
    }
    expect(byAccessor.get("endEdges")).toBe(4);
    expect(byAccessor.get("startEdges")).toBe(4);
    expect(byAccessor.get("sideEdges")).toBe(4);
  });

  it("reports bucket indices that resolve back to the picked edge", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30) as Extrude;

    const scene = render();
    const solid = findSolid(scene);
    const topRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(topRefs).toHaveLength(4);

    const result = explainSelection(scene, topRefs);
    for (let i = 0; i < topRefs.length; i++) {
      const pick = result.picks[i];
      expect(pick.producer!.accessor).toBe("endEdges");
      // Resolve the reported index through the real accessor and check it
      // lands on the same edge (IsSame via geometric identity of midpoints).
      const bucket = (e as unknown as SceneObject).getState('end-edges') as Edge[];
      const resolved = bucket[pick.producer!.index];
      const picked = Explorer.findEdgesWrapped(solid)[topRefs[i].sub.index];
      expect(resolved.getShape().IsSame(picked.getShape())).toBe(true);
    }
  });

  it("attributes pocket edges to the cut and box edges to the extrude", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const e = extrude(50) as Extrude;
    sketch(e.endFaces(), () => {
      move([50, 50]);
      circle(40);
    });
    cut(30);

    const scene = render();
    const solid = findSolid(scene);

    // Pocket floor rim (z = 20) → cut end-edges; pocket opening rim (z = 50)
    // is shared with the box top face — both classify, preference decides.
    const floorRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 20) < 1e-6);
    expect(floorRefs.length).toBeGreaterThan(0);
    const floor = explainSelection(scene, floorRefs);
    for (const pick of floor.picks) {
      expect(pick.attributed).toBe(true);
      expect(pick.producer!.featureType).toBe("cut");
      expect(pick.producer!.accessor).toBe("endEdges");
    }

    // Box bottom edges still attribute to the original extrude.
    const bottomRefs = edgeRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(bottomRefs).toHaveLength(4);
    const bottom = explainSelection(scene, bottomRefs);
    for (const pick of bottom.picks) {
      expect(pick.attributed).toBe(true);
      expect(pick.producer!.featureType).toBe("extrude");
      expect(pick.producer!.accessor).toBe("startEdges");
    }
  });

  it("attributes a fused boss's end edges to the boss extrude", () => {
    sketch("xy", () => {
      rect(100, 100);
    });
    const base = extrude(20) as Extrude;
    sketch(base.endFaces(), () => {
      move([50, 50]);
      rect(30, 30);
    });
    extrude(15);

    const scene = render();
    const solid = findSolid(scene);
    const bossTopRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 35) < 1e-6);
    expect(bossTopRefs).toHaveLength(4);

    const result = explainSelection(scene, bossTopRefs);
    for (const pick of result.picks) {
      expect(pick.attributed).toBe(true);
      expect(pick.producer!.featureType).toBe("extrude");
      expect(pick.producer!.accessor).toBe("endEdges");
      expect(pick.producer!.bucketSize).toBe(4);
    }
  });

  it("leaves fillet-born arc edges unattributed with a lineage-aware explanation", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);
    select(edge().verticalTo("xy"));
    fillet(5);

    const scene = render();
    const solid = findSolid(scene);

    // Arc edges created by the fillet exist on the final solid but belong to
    // no classified bucket.
    const result = explainSelection(scene, allEdgeRefs(solid));
    const unattributed = result.picks.filter(p => !p.attributed && !p.error);
    expect(unattributed.length).toBeGreaterThan(0);
  });
});

describe("apply-feature synthesis", () => {
  setupOC();

  it("emits a whole-bucket selector when the picks cover the bucket exactly", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    const topRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);

    const result = synthesizeApplyFeature(scene, topRefs, 'fillet', 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("endEdges");
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].line).toBe(4);
      expect(result.preview).toBe("fillet(3, e.endEdges())");
    }
  });

  it("emits bucket indices when the picks are a strict subset", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    const topRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6).slice(0, 2);

    const result = synthesizeApplyFeature(scene, topRefs, 'chamfer', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("endEdges");
      expect(result.spec.parts[0].indices).toHaveLength(2);
      expect(result.preview).toMatch(/^chamfer\(2, e\.endEdges\(\d+, \d+\)\)$/);
    }
  });

  it("splits picks across buckets into multiple selector args", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    const refs = [
      ...edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6).slice(0, 1),
      ...edgeRefsWhere(solid, m => m.z > 1e-6 && m.z < 30 - 1e-6).slice(0, 1),
    ];
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(2);
      const accessors = result.spec.parts.map(p => p.accessor).sort();
      expect(accessors).toEqual(["endEdges", "sideEdges"]);
      expect(result.spec.producers).toHaveLength(1);
    }
  });

  it("emits a whole-bucket face selector for a picked end face", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    // The top face is the only face whose edges all sit at z = 30.
    const topFaceRefs = faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(topFaceRefs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, topFaceRefs, 'fillet', 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("endFaces");
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.preview).toBe("fillet(3, e.endFaces())");
    }
  });

  it("emits an induced face filter for a picked side face", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    // A side face spans both z = 0 and z = 30 edges; pick one of the four.
    const sideFaceRefs = faceRefsWhere(solid, m => m.z > -1e-6 && m.z < 30 + 1e-6)
      .filter(ref => {
        const face = Explorer.findFacesWrapped(solid)[ref.sub.index];
        const zs = face.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg).z);
        return Math.min(...zs) < 1e-6 && Math.max(...zs) > 30 - 1e-6;
      })
      .slice(0, 1);
    expect(sideFaceRefs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, sideFaceRefs, 'chamfer', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("sideFaces");
      // The four side faces are separable by plane predicates, so the filter
      // form wins over a bucket index.
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.spec.parts[0].filterArgs).toMatch(/^face\(\)\./);
      expect(result.preview).toMatch(/^chamfer\(2, e\.sideFaces\(face\(\)\./);
      expect(result.spec.imports).toContain("face");
    }
  });

  it("emits a qualitative edge filter when it separates the pick (tier 1)", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    // The vertical corner edge at the origin: only its two containing
    // principal planes tell it apart from the other three side edges.
    const cornerRefs = edgeRefsWhere(solid, m =>
      Math.abs(m.x) < 1e-6 && Math.abs(m.y) < 1e-6 && Math.abs(m.z - 15) < 1e-6);
    expect(cornerRefs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, cornerRefs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("sideEdges");
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.spec.parts[0].filterArgs).toBe("edge().onPlane('xz').onPlane('yz')");
      expect(result.preview).toBe("fillet(2, e.sideEdges(edge().onPlane('xz').onPlane('yz')))");
      expect(result.spec.imports).toContain("edge");
    }
  });

  it("prefers a qualitative direction filter for a symmetric pair (tier 1)", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    // The two short top edges: the y-direction predicate separates them from
    // the long pair without any numeric constant.
    const shortRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6)
      .filter(ref => {
        const mid = EdgeOps.getEdgeMidPoint(Explorer.findEdgesWrapped(solid)[ref.sub.index]);
        return Math.abs(mid.y - 25) < 1e-6;
      });
    expect(shortRefs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, shortRefs, 'fillet', 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.spec.parts[0].filterArgs).toBe("edge().verticalTo('xz')");
      expect(result.preview).toBe("fillet(3, e.endEdges(edge().verticalTo('xz')))");
    }
  });

  it("mixes face and edge picks into separate selector args", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    const refs = [
      ...faceRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6),
      ...edgeRefsWhere(solid, m => Math.abs(m.z) < 1e-6).slice(0, 1),
    ];
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(2);
      const accessors = result.spec.parts.map(p => p.accessor).sort();
      expect(accessors).toEqual(["endFaces", "startEdges"]);
      expect(result.spec.producers).toHaveLength(1);
    }
  });

  it("synthesizes a scene-wide select() for a repeat-instance pick (tier 3)", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new();
    setLocation(e, 4);
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    setLocation(r, 6);

    const scene = render();
    const solids = findSolids(scene);
    expect(solids.length).toBe(3);

    // The middle instance's whole top rim: no variable can be bound to a
    // clone, so the synthesizer brackets the instance with plane predicates.
    const cloneSolid = solids[1];
    const refs = edgeRefsWhere(cloneSolid, m => Math.abs(m.z - 10) < 1e-6);
    expect(refs).toHaveLength(4);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].producer).toBeNull();
      expect(result.spec.parts[0].accessor).toBe("select");
      expect(result.spec.parts[0].filterArgs).toMatch(/^edge\(\)\./);
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].bind).toBe(false);
      expect(result.spec.imports).toEqual(expect.arrayContaining(["select", "edge"]));
      expect(result.preview).toMatch(/^fillet\(2, select\(edge\(\)\./);
    }
  });

  it("splits a select() across args when one conjunction can't cover the picks", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new();
    setLocation(e, 4);
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    setLocation(r, 6);

    const scene = render();
    const solids = findSolids(scene);

    // One edge on each clone instance, on opposite sides (y = 0 vs y = 20):
    // no single conjunction covers both without also matching their twins, so
    // the synthesizer must fall back to one arg per pick. (The original
    // instance is bindable, so both picks must land on clones.)
    const refs = [
      ...edgeRefsWhere(solids[1], m => Math.abs(m.y) < 1e-6 && Math.abs(m.z - 10) < 1e-6),
      ...edgeRefsWhere(solids[2], m => Math.abs(m.y - 20) < 1e-6 && Math.abs(m.z - 10) < 1e-6),
    ];
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("select");
      expect(result.spec.parts[0].filterArgs).toMatch(/^edge\(\)\..*, edge\(\)\./);
    }
  });

  it("refuses when even a scene-wide filter cannot isolate the picks", () => {
    // A 3×3 grid built from one call site: every box is a shared-call-site
    // twin, and the centre one cannot be bracketed within the conjunction
    // budget. The refusal must say so instead of writing fragile code.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        sketch("xy", () => {
          move([i * 40, j * 40]);
          rect(20, 20);
        });
        const e = extrude(10).new();
        setLocation(e, 4);
      }
    }

    const scene = render();
    const solids = findSolids(scene);
    expect(solids.length).toBe(9);

    const centre = solids.find(s => {
      const mids = Explorer.findEdgesWrapped(s).map(eg => EdgeOps.getEdgeMidPoint(eg));
      return mids.every(m => m.x > 39 && m.x < 61 && m.y > 39 && m.y < 61);
    });
    expect(centre).toBeDefined();

    const refs = edgeRefsWhere(centre!, m => Math.abs(m.z - 10) < 1e-6);
    expect(refs).toHaveLength(4);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toMatch(/loop or helper|geometric filter/);
    }
  });

  it("returns verified alternative renderings alongside the winner", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);

    const scene = render();
    const solid = findSolid(scene);
    const cornerRefs = edgeRefsWhere(solid, m =>
      Math.abs(m.x) < 1e-6 && Math.abs(m.y) < 1e-6 && Math.abs(m.z - 15) < 1e-6);

    const result = synthesizeApplyFeature(scene, cornerRefs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Winner is the filter form; the index form survives as an alternative.
      expect(result.args).toBe("e.sideEdges(edge().onPlane('xz').onPlane('yz'))");
      expect(result.alternatives.length).toBeGreaterThanOrEqual(1);
      expect(result.alternatives.some(a => /^e\.sideEdges\(\d\)$/.test(a))).toBe(true);
    }
  });

  it("expands a tangent chain across a rounded rim", () => {
    sketch("xy", () => {
      rect(100, 50);
      fillet(5);
    });
    const e = extrude(20);
    setLocation(e, 5);

    const scene = render();
    const solid = findSolid(scene);
    // Any top-rim edge expands to the full rounded rim: 4 lines + 4 arcs.
    const seedRefs = edgeRefsWhere(solid, m =>
      Math.abs(m.y) < 1e-6 && Math.abs(m.z - 20) < 1e-6);
    expect(seedRefs).toHaveLength(1);

    const expansion = expandTangentChain(scene, seedRefs[0]);
    expect(expansion.ok).toBe(true);
    if (expansion.ok) {
      expect(expansion.members).toHaveLength(8);
      const zs = expansion.members.map(m =>
        EdgeOps.getEdgeMidPoint(Explorer.findEdgesWrapped(solid)[m.sub.index]).z);
      expect(zs.every(z => Math.abs(z - 20) < 1e-6)).toBe(true);
    }
  });

  it("synthesizes a whole-bucket selector for a chain covering the bucket, with a withTangents alternative", () => {
    sketch("xy", () => {
      rect(100, 50);
      fillet(5);
    });
    const e = extrude(20);
    setLocation(e, 5);

    const scene = render();
    const solid = findSolid(scene);
    const seedRefs = edgeRefsWhere(solid, m =>
      Math.abs(m.y) < 1e-6 && Math.abs(m.z - 20) < 1e-6);
    const expansion = expandTangentChain(scene, seedRefs[0]);
    expect(expansion.ok).toBe(true);
    if (expansion.ok === false) {
      return;
    }

    const result = synthesizeApplyFeature(scene, expansion.members, 'fillet', 2, [
      { seed: seedRefs[0], members: expansion.members },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The chain covers the end-edges bucket exactly — the whole-bucket form
      // wins, and the tangent-chain form survives as an alternative.
      expect(result.args).toBe("e.endEdges()");
      expect(result.alternatives.some(a => a.includes(".withTangents()"))).toBe(true);
    }
  });

  it("synthesizes a select() withTangents chain on a repeat instance", () => {
    sketch("xy", () => {
      rect(20, 20);
      fillet(5);
    });
    const e = extrude(10).new();
    setLocation(e, 5);
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    setLocation(r, 7);

    const scene = render();
    const solids = findSolids(scene);
    expect(solids).toHaveLength(3);
    const middle = solids.find(s => {
      const xs = Explorer.findEdgesWrapped(s).map(eg => EdgeOps.getEdgeMidPoint(eg).x);
      return Math.min(...xs) > 30 && Math.max(...xs) < 70;
    })!;
    expect(middle).toBeDefined();

    const seedRefs = edgeRefsWhere(middle, m =>
      Math.abs(m.y) < 1e-6 && Math.abs(m.z - 10) < 1e-6);
    expect(seedRefs).toHaveLength(1);
    const expansion = expandTangentChain(scene, seedRefs[0]);
    expect(expansion.ok).toBe(true);
    if (expansion.ok === false) {
      return;
    }
    expect(expansion.members).toHaveLength(8);

    const result = synthesizeApplyFeature(scene, expansion.members, 'fillet', 1, [
      { seed: seedRefs[0], members: expansion.members },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("select");
      expect(result.args).toMatch(/^select\(edge\(\)\./);
      expect(result.args).toContain(".withTangents()");
    }
  });

  it("refuses when the producer has no source location", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6).slice(0, 1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain("source location");
    }
  });

  it("still synthesizes selectors for buckets untouched by a prior fillet", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);
    // Fillet only the top rim: the bottom face is not adjacent to any
    // filleted edge, so its edges keep their identity on the final solid.
    select(edge().onPlane("xy", 30));
    fillet(5);

    const scene = render();
    const solid = findSolid(scene);
    const bottomRefs = edgeRefsWhere(solid, m => Math.abs(m.z) < 1e-6);
    expect(bottomRefs).toHaveLength(4);

    const result = synthesizeApplyFeature(scene, bottomRefs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].accessor).toBe("startEdges");
      expect(result.spec.parts[0].indices).toBeNull();
      expect(result.preview).toBe("fillet(2, e.startEdges())");
    }
  });

  it("synthesizes a select() for fillet-born edges (tier 3)", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);
    select(edge().verticalTo("xy"));
    const f = fillet(5);
    setLocation(f, 6);

    const scene = render();
    const solid = findSolid(scene);
    // Pick one of the arc edges the fillet created — classified by no bucket,
    // but isolable by curve class plus position.
    const arcRefs: PickRef[] = [];
    Explorer.findEdgesWrapped(solid).forEach((eg: Edge, index: number) => {
      if (arcRefs.length === 0 && eg.getType() === "edge") {
        const mid = EdgeOps.getEdgeMidPoint(eg);
        const nearCorner = Math.abs(mid.z - 30) < 1e-6
          && (Math.abs(mid.x) < 6 || Math.abs(mid.x - 100) < 6)
          && (Math.abs(mid.y) < 6 || Math.abs(mid.y - 50) < 6);
        if (nearCorner) {
          arcRefs.push({ shapeId: solid.id, sub: { type: 'edge', index } });
        }
      }
    });
    expect(arcRefs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, arcRefs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.parts).toHaveLength(1);
      expect(result.spec.parts[0].producer).toBeNull();
      expect(result.spec.parts[0].accessor).toBe("select");
      expect(result.spec.producers[0].bind).toBe(false);
      expect(result.preview).toMatch(/^fillet\(2, select\(edge\(\)\./);
    }
  });
});

describe("producer naming", () => {
  setupOC();

  function makeBoxScene(): { scene: Scene; refs: PickRef[] } {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);
    const scene = render();
    const solid = findSolid(scene);
    return { scene, refs: edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6) };
  }

  it("prefers namer-provided names in the preview and spec rendering", () => {
    const { scene, refs } = makeBoxScene();

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 3, [], { namer: () => ['base'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe('fillet(3, base.endEdges())');
      expect(result.args).toBe('base.endEdges()');
    }
  });

  it("labels clone picks honestly in the teach-mode expression", () => {
    sketch("xy", () => {
      rect(20, 20);
    });
    const e = extrude(10).new();
    setLocation(e, 4);
    const r = repeat("linear", "x", { count: 3, offset: 40 }, e);
    setLocation(r, 6);

    const scene = render();
    const solids = findSolids(scene);
    expect(solids).toHaveLength(3);
    const clone = solids.find(s => {
      const xs = Explorer.findEdgesWrapped(s).map(eg => EdgeOps.getEdgeMidPoint(eg).x);
      return Math.min(...xs) > 30;
    })!;

    const pick = explainSelection(scene, [allEdgeRefs(clone)[0]]).picks[0];
    expect(pick.attributed).toBe(true);
    expect(pick.producer!.isClone).toBe(true);
    // No variable can be bound to a clone — the accessor form (`e.endEdges(0)`)
    // would be a lie, so the tooltip says what will really be synthesized.
    expect(pick.expression).toContain('(repeat instance)');
    expect(pick.expression).toContain('select()');
    expect(pick.expression).not.toMatch(/^e\./);
  });

  it("falls back to hint names when the namer throws or returns null", () => {
    const { scene, refs } = makeBoxScene();

    const throwing = synthesizeApplyFeature(scene, refs, 'fillet', 3, [], {
      namer: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.ok).toBe(true);
    if (throwing.ok) {
      expect(throwing.preview).toBe('fillet(3, e.endEdges())');
    }

    const nulling = synthesizeApplyFeature(scene, refs, 'fillet', 3, [], { namer: () => [null] });
    expect(nulling.ok).toBe(true);
    if (nulling.ok) {
      expect(nulling.preview).toBe('fillet(3, e.endEdges())');
    }
  });
});

describe("part()-scoped select() synthesis", () => {
  setupOC();

  /**
   * Two identical parts, both filleted: every fillet-born arc in part "a"
   * has a geometrically identical twin in part "b". Only a universe scoped
   * to the picked part can isolate one — an unscoped select() would match
   * both twins and fail verification.
   */
  function makeTwinPartScene(): { scene: Scene; solids: Shape[] } {
    part("a", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 4);
      select(edge().verticalTo("xy"));
      const f = fillet(5);
      setLocation(f, 6);
    });
    part("b", () => {
      sketch("xy", () => {
        rect(100, 50);
      });
      const e = extrude(30);
      setLocation(e, 10);
      select(edge().verticalTo("xy"));
      const f = fillet(5);
      setLocation(f, 12);
    });
    const scene = render();
    const solids = findSolids(scene);
    expect(solids).toHaveLength(2);
    return { scene, solids };
  }

  function arcPickOf(scene: Scene, solid: Shape): PickRef {
    const explained = explainSelection(scene, allEdgeRefs(solid));
    const unattributed = explained.picks.find(p => !p.attributed && !p.error && !p.lineage);
    expect(unattributed).toBeDefined();
    return unattributed!.ref;
  }

  it("synthesizes a select() scoped to the picked solid's part", () => {
    const { scene, solids } = makeTwinPartScene();
    const pick = arcPickOf(scene, solids[0]);

    const result = synthesizeApplyFeature(scene, [pick], 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toMatch(/^select\(edge\(\)\./);
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].bind).toBe(false);
    }
  });

  it("refuses picks spanning two part() scopes", () => {
    const { scene, solids } = makeTwinPartScene();
    const pickA = arcPickOf(scene, solids[0]);
    const pickB = arcPickOf(scene, solids[1]);

    const result = synthesizeApplyFeature(scene, [pickA, pickB], 'fillet', 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain('part() scopes');
    }
  });
});

describe("parameter linking", () => {
  setupOC();

  /**
   * The single top edge at y = 50 of a 100×50×30 box: among the four end
   * edges only `onPlane('xz', -50)` isolates it (the xz normal is −y, so the
   * offset is signed). That gives a deterministic, linkable dimension
   * constant to exercise.
   */
  function makeOffsetEdgeScene(): { scene: Scene; refs: PickRef[] } {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);
    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m =>
      Math.abs(m.y - 50) < 1e-6 && Math.abs(m.z - 30) < 1e-6);
    expect(refs).toHaveLength(1);
    return { scene, refs };
  }

  it("renders a dimension constant as the user's variable when values match exactly", () => {
    const { scene, refs } = makeOffsetEdgeScene();

    const plain = synthesizeApplyFeature(scene, refs, 'fillet', 3);
    expect(plain.ok).toBe(true);
    if (plain.ok !== true) {
      return;
    }
    expect(plain.args).toContain("onPlane('xz', -50)");

    const linked = synthesizeApplyFeature(scene, refs, 'fillet', 3, [], {
      params: [{ name: 'backOffset', value: -50 }],
    });
    expect(linked.ok).toBe(true);
    if (linked.ok) {
      expect(linked.args).toContain("onPlane('xz', backOffset)");
    }
  });

  it("does not link when values differ", () => {
    const { scene, refs } = makeOffsetEdgeScene();

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 3, [], {
      params: [{ name: 'backOffset', value: 50 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).toContain("onPlane('xz', -50)");
      expect(result.args).not.toContain('backOffset');
    }
  });
});

describe("bucket expansion (double-click gesture)", () => {
  setupOC();

  it("expands an end edge to the whole end bucket", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    const scene = render();
    const solid = findSolid(scene);
    const seedRefs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(seedRefs).toHaveLength(4);

    const expansion = expandBucket(scene, seedRefs[0]);
    expect(expansion.ok).toBe(true);
    if (expansion.ok) {
      expect(expansion.members).toHaveLength(4);
      const zs = expansion.members.map(m =>
        EdgeOps.getEdgeMidPoint(Explorer.findEdgesWrapped(solid)[m.sub.index] as Edge).z);
      expect(zs.every(z => Math.abs(z - 30) < 1e-6)).toBe(true);
    }
  });

  it("expands to the same bucket the seed attributes to, even after a cut", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);

    // Notch the top: the cut splits two top-rim edges and consumes material,
    // so as-built buckets and the final solid disagree about some members.
    sketch("xz", () => {
      move([0, 25]);
      rect(20, 10);
    });
    cut(100);

    const scene = render();
    const solid = findSolid(scene);
    const survivors = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6);
    expect(survivors.length).toBeGreaterThan(0);
    const seed = survivors[0];

    const seedPick = explainSelection(scene, [seed]).picks[0];
    expect(seedPick.attributed).toBe(true);

    const expansion = expandBucket(scene, seed);
    expect(expansion.ok).toBe(true);
    if (expansion.ok) {
      // The gesture's contract: every member attributes to the same bucket
      // the seed (and the teach-mode tooltip) reports, the seed is included,
      // and vanished as-built members are skipped rather than invented.
      expect(expansion.members.length).toBeGreaterThan(0);
      expect(expansion.members.length).toBeLessThanOrEqual(seedPick.producer!.bucketSize);
      expect(expansion.members.some(m => m.sub.index === seed.sub.index)).toBe(true);
      const memberPicks = explainSelection(scene, expansion.members).picks;
      for (const pick of memberPicks) {
        expect(pick.attributed).toBe(true);
        expect(pick.producer!.featureType).toBe(seedPick.producer!.featureType);
        expect(pick.producer!.bucketKey).toBe(seedPick.producer!.bucketKey);
      }
    }
  });

  it("refuses a pick with no classified bucket", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    extrude(30);
    select(edge().verticalTo("xy"));
    fillet(5);

    const scene = render();
    const solid = findSolid(scene);
    // A fillet-born arc edge attributes to no bucket.
    const explained = explainSelection(scene, allEdgeRefs(solid));
    const unattributed = explained.picks.find(p => !p.attributed && !p.lineage);
    expect(unattributed).toBeDefined();

    const expansion = expandBucket(scene, unattributed!.ref);
    expect(expansion.ok).toBe(false);
    if (expansion.ok === false) {
      expect(expansion.reason).toContain("bucket");
    }
  });
});
