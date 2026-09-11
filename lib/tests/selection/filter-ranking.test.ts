import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import shell from "../../core/shell.js";
import cut from "../../core/cut.js";
import { circle, line as sketchLine } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import { testL, testRect } from "../helpers/profiles.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { instantiateEdgeAtoms } from "../../selection/atoms.js";
import { probeEdge } from "../../selection/probe.js";
import { FaceOps } from "../../oc/face-ops.js";
import { Edge } from "../../common/edge.js";
import { Face } from "../../common/face.js";
import { SceneObject } from "../../common/scene-object.js";
import { LazySelectionSceneObject } from "../../features/lazy-scene-object.js";
import { induceConjunction } from "../../selection/induction.js";
import type { Atom } from "../../selection/atoms.js";
import type { PickRef } from "../../selection/types.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, findSolids, setLocation } from "./pick-helpers.js";

/** Solved stand-in for legacy `polygon(n, dia)` (inscribed) centered at `at`. */
function testPolygon(n: number, dia: number, at: [number, number]) {
  const r = dia / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([at[0] + r * Math.cos(a), at[1] + r * Math.sin(a)]);
  }
  const lines = pts.map((p, i) => sketchLine(p, pts[(i + 1) % n]));
  for (let i = 0; i < n; i++) {
    coincident(lines[i].end(), lines[(i + 1) % n].start());
  }
}

describe("filter ranking robustness", () => {
  setupOC();

  it("prefers the datum half-space over onPlane with a derived constant", () => {
    // Three overlapping circles: the union outline's seam lines sit at
    // y = ±20·√3 — a derived constant no parameter edit keeps stable. The
    // two seams above the xz plane must come out as the constant-free
    // half-space, not onPlane with the baked offset.
    sketch("xy", () => {
        circle([0, 0], 80);
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

  it("prefers constant-free filters, then the bucket index, over filters baking unlinked geometry constants", () => {
    // Positions, lengths, and plane offsets that no user parameter tracks —
    // the pentagon side length 107.7·sin 36° = 63.30447167189937…, the rect
    // plane at y = 25.64, the side face at x = 233.74 — silently break on
    // dimension edits, so the verified index form wins and the filter drops
    // to the alternatives dropdown. A constant linked to a user parameter
    // keeps the filter form: the emitted name follows the variable.
    sketch("xy", () => {
      circle([50, 70], 35.77);
      // Legacy pen walk: move(33.66, 7.54) from [50, 70] put the rect corner
      // at [83.66, 77.54]; the second rect started at the pen's [150, 100];
      // the pentagon's center landed at [0, 170].
      testRect(110.99, -51.9, { at: [83.66, 77.54] });
      circle([150, 100], 72.84);
      testRect(83.74, -54.35, { at: [150, 100] });
      testPolygon(5, 107.7, [0, 170]);
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

    // A rank conjunction isolates the pentagon edge without any constant, so
    // it wins; other constant-free forms and the verified index form come
    // next, and the baked-length filter trails the index.
    const polygonEdge = synthesizeApplyFeature(scene, [edgeAt(35.25, 144.39)], 'fillet', 2);
    expect(polygonEdge.ok).toBe(true);
    if (polygonEdge.ok) {
      expect(polygonEdge.preview).toBe(
        "fillet(2, e.endEdges(edge().above('yz').line().nearest('x').nearest('y')))",
      );
      expect(polygonEdge.alternatives.some(a => /^e\.endEdges\(\d+\)$/.test(a))).toBe(true);
      expect(polygonEdge.alternatives.some(a => /e\.endEdges\(edge\(\)\.line\(63\.304\d+\)/.test(a))).toBe(true);
      const indexAt = polygonEdge.alternatives.findIndex(a => /^e\.endEdges\(\d+\)$/.test(a));
      const bakedAt = polygonEdge.alternatives.findIndex(a => a.includes('line(63.304'));
      expect(indexAt).toBeLessThan(bakedAt);
    }

    // A clean 2-decimal offset is still unlinked geometry: any constant-free
    // form beats it, and the index beats it too.
    const rectEdge = synthesizeApplyFeature(scene, [edgeAt(139.15, 25.64)], 'fillet', 2);
    expect(rectEdge.ok).toBe(true);
    if (rectEdge.ok) {
      expect(rectEdge.preview).not.toContain('25.64');
      const forms = [rectEdge.args, ...rectEdge.alternatives];
      const indexAt = forms.findIndex(a => /^e\.endEdges\(\d+\)$/.test(a));
      const bakedAt = forms.findIndex(a => a === "e.endEdges(edge().onPlane('xz', -25.64))");
      expect(indexAt).toBeGreaterThanOrEqual(0);
      expect(bakedAt).toBeGreaterThan(indexAt);
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
      // The rightmost side face: a rank form, with the index ahead of the
      // baked offset among the alternatives.
      expect(sideFace.preview).toBe("fillet(2, e.sideFaces(face().farthest('x')))");
      const forms = [sideFace.args, ...sideFace.alternatives];
      const indexAt = forms.findIndex(a => /^e\.sideFaces\(\d+\)$/.test(a));
      const bakedAt = forms.findIndex(a => a === "e.sideFaces(face().onPlane('yz', 233.74))");
      expect(indexAt).toBeGreaterThanOrEqual(0);
      expect(bakedAt).toBeGreaterThan(indexAt);
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

describe("rank forms replace gap cuts", () => {
  setupOC();

  /** A plate with two bosses of different height from one call site (a loop). */
  function twoBossScene() {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const base = extrude(10);
    setLocation(base, 3);
    for (const [x, height] of [[25, 20], [75, 35]] as const) {
      sketch("xy", () => {
          circle([x, 25], 10);
        });
      const boss = extrude(height);
      setLocation(boss, 6);
    }
    return render();
  }

  it("isolates the tallest boss rim with farthest() instead of a plane offset", () => {
    const scene = twoBossScene();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 35) < 1e-6);
    expect(refs).toHaveLength(1);

    // The boss extrude is a loop call site, so no variable binds: the pick
    // routes through select(), where the topmost layer needs no constant.
    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, select(edge().farthest('z')))");
      // The global tier now offers runner-ups; the baked offset is one of them.
      expect(result.alternatives.length).toBeGreaterThan(0);
      expect(result.alternatives.some(a => a.includes("onPlane('xy', 35)"))).toBe(true);
    }
  });

  it("isolates an interior boss rim with a described family plus rank steps", () => {
    const scene = twoBossScene();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 20) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Edges wholly above the base's top face (the two rims; the seams start
      // on it), then the left boss's — no plane offset, no layer index.
      expect(result.preview).toBe("fillet(2, select(edge().above(e.endFaces()).nearest('x')))");
    }
  });

  it("isolates the larger of two holes by radius rank instead of a baked diameter", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const plate = extrude(10) as Extrude;
    setLocation(plate, 3);
    for (const [x, diameter] of [[25, 8], [75, 14]] as const) {
      sketch(plate.endFaces(), () => {
          circle([x, 25], diameter);
        });
      const hole = cut(10);
      setLocation(hole, 6);
    }
    const scene = render();
    const solid = findSolid(scene);
    // The Ø14 hole wall: every one of its edge midpoints (rims and seam) sits on the Ø14 circle.
    const refs = faceRefsWhere(solid, m => Math.abs(Math.hypot(m.x - 75, m.y - 25) - 7) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, select(face().largest('radius')))");
      expect(result.alternatives.some(a => a.includes('cylinder(14)'))).toBe(true);
    }
  });
});

describe("convexity in synthesized selectors", () => {
  setupOC();

  it("names a boss junction by its corner class, not the plane it sits on", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    // Both extrudes share one call site (a helper), so neither binds a
    // variable and the pick must be described scene-wide.
    const base = extrude(30);
    setLocation(base, 6);
    sketch("xy", () => {
        circle([50, 25], 10);
      });
    const boss = extrude(40);
    setLocation(boss, 6);
    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6 && Math.hypot(m.x - 50, m.y - 25) < 5.1);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, select(edge().concave()))");
    }
  });

  it("selects an L profile's inner corner through its bucket with concave()", () => {
    sketch("xy", () => {
        testL();
      });
    const e = extrude(30);
    setLocation(e, 3);
    const scene = render();
    const solid = findSolid(scene);
    const refs = edgeRefsWhere(solid, m => Math.abs(m.x - 20) < 1e-6 && Math.abs(m.y - 20) < 1e-6 && Math.abs(m.z - 15) < 1e-6);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, e.sideEdges(edge().concave()))");
    }
  });
});

describe("feature-group references in synthesized selectors", () => {
  setupOC();

  it("brackets a half-space with the base's face group instead of an offset", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const base = extrude(10) as Extrude;
    setLocation(base, 3);
    for (const [x, height] of [[25, 30], [75, 40]] as const) {
      sketch("xy", () => {
          circle([x, 25], 20);
        });
      const boss = extrude(height);
      setLocation(boss, 6);
    }
    const scene = render();
    const solid = findSolid(scene);
    // Both boss rims: different heights, so no single layer names them.
    const refs = edgeRefsWhere(solid, m => Math.abs(m.z - 30) < 1e-6 || Math.abs(m.z - 40) < 1e-6);
    expect(refs).toHaveLength(2);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview).toBe("fillet(2, select(edge().above(e.endFaces())))");
      expect(result.spec.producers).toHaveLength(1);
      expect(result.spec.producers[0].featureType).toBe("extrude");
      expect(result.spec.producers[0].bind).toBe(true);
    }
  });

  it("offers belongsToFace() over a bound face group as a constant-free atom", () => {
    sketch("xy", () => {
        testRect(100, 50);
      });
    const base = extrude(10) as Extrude;
    setLocation(base, 3);
    sketch("xy", () => {
        circle([50, 25], 20);
      });
    const boss = extrude(30);
    setLocation(boss, 6);
    const scene = render();
    const solid = findSolid(scene);
    // A top rect edge of the base: bounded by its as-built end face.
    const topEdge = edgeRefsWhere(solid, m => Math.abs(m.z - 10) < 1e-6 && Math.abs(m.y) < 1e-6);
    expect(topEdge).toHaveLength(1);

    const index = new SelectionIndex(scene);
    try {
      const attr = attributePick(scene, index, topEdge[0]);
      const universe = (solid.getSubShapes('edge') as Edge[]);
      const endFaces = base.endFaces() as unknown as LazySelectionSceneObject;
      endFaces.build();
      const members = endFaces.getShapes() as Face[];
      const atoms = instantiateEdgeAtoms(
        [probeEdge(attr.picked as Edge, attr.solidShape)], universe, true, [],
        [{
          feature: base as unknown as SceneObject,
          accessor: 'endFaces',
          members,
          plane: FaceOps.tryGetPlane(members[0]),
          resolve: () => base.endFaces() as unknown as SceneObject,
        }],
      );
      const codes = atoms.map(a => a.code);
      expect(codes).toContain('.belongsToFace({{ref}}.endFaces())');
      expect(codes).toContain('.onPlane({{ref}}.endFaces())');
      expect(codes).toContain('.convex()');
      expect(codes).not.toContain('.above({{ref}}.endFaces())');
    } finally {
      index.dispose();
    }
  });
});

describe("constant-free induction pass", () => {
  const atom = (code: string, weight: number, constants: number): Atom<object> => ({
    code, addTo: () => {}, weight, constants, bakedConstants: constants, needsScope: false,
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
