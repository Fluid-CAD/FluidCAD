import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import fillet from "../../core/fillet.js";
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

  it("refuses edges on repeated instances with a geometric-filter hint", () => {
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

    // A clone instance solid: attribution lands on the clone, which cannot be
    // variable-bound.
    const cloneSolid = solids[1];
    const refs = edgeRefsWhere(cloneSolid, m => Math.abs(m.z - 10) < 1e-6).slice(0, 1);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toMatch(/repeat|geometric filter|loop or helper/);
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

  it("refuses fillet-born edges with an unclassified explanation", () => {
    sketch("xy", () => {
      rect(100, 50);
    });
    const e = extrude(30);
    setLocation(e, 4);
    select(edge().verticalTo("xy"));
    fillet(5);

    const scene = render();
    const solid = findSolid(scene);
    // Pick one of the arc edges the fillet created.
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
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toMatch(/not classified|reshaped/);
    }
  });
});
