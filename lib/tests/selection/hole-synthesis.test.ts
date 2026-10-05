import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import hole from "../../core/hole.js";
import mirror from "../../core/mirror.js";
import repeat from "../../core/repeat.js";
import { circle } from "../../core/2d/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from "../../selection/resolve-selection.js";
import type { PickRef } from "../../selection/types.js";
import type { SolvedCircle } from "../../features/2d/solved/circle.js";
import { setLocation } from "./pick-helpers.js";

function resolveOk(scene: Scene, request: ResolveSelectionRequest): Extract<ResolveSelectionResult, { ok: true }> {
  const result = SelectionResolver.resolve(scene, request, {});
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return result as Extract<ResolveSelectionResult, { ok: true }>;
}

/** The one match of `expression` that `where` accepts, as a pick. */
function pickWhere(scene: Scene, expression: string, where: (m: ResolvedSelectionMatch) => boolean): PickRef {
  const hits = resolveOk(scene, { expression }).matches.filter(where);
  expect(hits).toHaveLength(1);
  return { shapeId: hits[0].shapeId, sub: { type: hits[0].kind, index: hits[0].index } };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/**
 * Synthesizes a selector for `pick`, then runs it — and every alternative —
 * back through the real accessors: each must resolve to exactly the pick.
 */
function roundTrip(scene: Scene, pick: PickRef) {
  const result = resolveOk(scene, { picks: [pick] });
  expect(result.synthesized).toBeDefined();
  const synthesized = result.synthesized!;
  expect(synthesized.ok, synthesized.ok === false ? synthesized.reason : '').toBe(true);
  const ok = synthesized as Extract<typeof synthesized, { ok: true }>;
  for (const expression of [ok.expression, ...ok.alternatives.map(a => a.expression)]) {
    const back = resolveOk(scene, { expression }).matches.map(m => ({ shapeId: m.shapeId, sub: { type: m.kind, index: m.index } }));
    expect(back, expression).toEqual([pick]);
  }
  return ok;
}

/**
 * A 60 × 40 × 10 plate with two countersunk M6 clearance holes at (∓20, 10):
 * per hole a cone and a bore, a rim where it enters, one where it leaves and
 * the crease between the cone and the bore.
 */
function countersunkPlate(): Scene {
  sketch("xy", () => {
    testRect(60, 40, { at: [-30, -20] });
  });
  const plate = extrude(10).new();
  setLocation(plate, 2);
  const s = sketch(plate.endFaces(), () => ({ l: circle([-20, 10], 3), r: circle([20, 10], 3) }));
  setLocation(s, 3);
  const { l, r } = s.geometries as unknown as { l: SolvedCircle; r: SolvedCircle };
  const h = hole('M6', l.center(), r.center()).clearance('normal').countersink();
  setLocation(h, 4);
  const mirrored = repeat("mirror", "xz", h);
  setLocation(mirrored, 5);
  const scene = render();
  expect(scene.getRenderedObjects().filter(o => o.hasError).map(o => o.errorMessage)).toEqual([]);
  return scene;
}

describe("selector synthesis on a hole", () => {
  setupOC();

  it("writes a wall pick through faces(), the accessor a hole has", () => {
    const scene = countersunkPlate();
    const bore = pickWhere(scene, 'face().cylinder()', m =>
      near(m.summary.center![0], 20) && near(m.summary.center![1], 10) && near(m.summary.diameter!, 6.6));

    const synthesized = roundTrip(scene, bore);
    expect(synthesized.parts[0].accessor).toBe('faces');
    expect(synthesized.source).toMatch(/^\w+\.faces\(/);
  });

  it("writes a rim pick as a filter or index its startEdges() answers", () => {
    const scene = countersunkPlate();
    const rim = pickWhere(scene, 'edge().circle()', m =>
      near(m.summary.center![0], 20) && near(m.summary.center![1], 10) && near(m.summary.center![2], 10));

    const synthesized = roundTrip(scene, rim);
    expect(synthesized.parts[0].accessor).toBe('startEdges');
  });

  it("writes the countersink's crease through internalEdges()", () => {
    const scene = countersunkPlate();
    const crease = pickWhere(scene, 'edge().circle()', m =>
      near(m.summary.center![0], 20) && near(m.summary.center![1], 10) && near(m.summary.diameter!, 6.6)
      && m.summary.center![2] > 1 && m.summary.center![2] < 9);

    const synthesized = roundTrip(scene, crease);
    expect(synthesized.parts[0].accessor).toBe('internalEdges');
  });

  it("reaches a mirrored hole's wall through its repeat instance", () => {
    const scene = countersunkPlate();
    const bore = pickWhere(scene, 'face().cylinder()', m =>
      near(m.summary.center![0], 20) && near(m.summary.center![1], -10) && near(m.summary.diameter!, 6.6));

    const synthesized = roundTrip(scene, bore);
    expect(synthesized.parts[0].accessor).toBe('instance(1).faces');
  });
});

describe("selector synthesis on a feature without bucket accessors", () => {
  setupOC();

  it("never names a removing mirror's cut buckets, which it has no accessors for", () => {
    sketch("xy", () => {
      testRect(30, 30, { at: [0, -5] });
    });
    const e = extrude(20).new();
    setLocation(e, 2);
    const m = mirror("xz").remove() as unknown as SceneObject;
    setLocation(m, 3);
    const scene = render();
    expect(scene.getRenderedObjects().filter(o => o.hasError).map(o => o.errorMessage)).toEqual([]);
    // The mirror's cut leaves the y = 5 face.
    const cutFace = pickWhere(scene, 'face().planar()', f => near(f.summary.center![1], 5));

    const synthesized = roundTrip(scene, cutFace);
    expect(synthesized.parts.every(p => p.producer !== m.id)).toBe(true);
  });
});
