import { describe, it, expect, vi } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, arc, spline, circle, ellipse, extrude, revolve, loft, plane, helix } from "../../core/index.js";
import { registerBuilder, SceneParserContext } from "../../index.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { CurveObject } from "../../features/curve-object.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { FaceProps } from "../../oc/face-props.js";
import { FaceQuery } from "../../oc/face-query.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { synthesizeSelectors, SelectorPart } from "../../selection/synthesis.js";
import { globalContext, induceFilterCandidates, InductionContext } from "../../selection/filter-search.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import type { PickRef } from "../../selection/types.js";
import type { Scene } from "../../rendering/scene.js";
import { TestCurves } from "../helpers/curves.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { findSolid, findSolids, setLocation } from "./pick-helpers.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { ShapeOps } from "../../oc/shape-ops.js";

/** A curve tool that leaves the three-edge wire of {@link TestCurves.threeEdges}: a line, a half circle, a line. */
class TestPath extends CurveObject {
  protected buildCurves(_context: BuildSceneObjectContext): Shape[] {
    return [TestCurves.threeEdges()];
  }

  override getType(): string {
    return "test-path";
  }

  override createCopy(): SceneObject {
    return new TestPath();
  }

  serialize() {
    return {};
  }
}

const path = registerBuilder((context: SceneParserContext) => {
  return function path(): TestPath {
    const result = new TestPath();
    context.addSceneObject(result);
    return result;
  };
});

/** Refs of the shape's edges whose properties pass `where`. */
function edgesWhere(shape: Shape, where: (curveType: string, index: number) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findEdgesWrapped(shape).forEach((e, index) => {
    if (where(EdgeProps.getProperties(e.getShape()).curveType, index)) {
      refs.push({ shapeId: shape.id, sub: { type: "edge", index } });
    }
  });
  return refs;
}

/** Refs of the shape's faces whose properties pass `where`. */
function facesWhere(shape: Shape, where: (surfaceType: string) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findFacesWrapped(shape).forEach((f, index) => {
    if (where(FaceProps.getProperties(f.getShape()).surfaceType)) {
      refs.push({ shapeId: shape.id, sub: { type: "face", index } });
    }
  });
  return refs;
}

/**
 * Every scene-wide filter candidate for the picks, each re-run through the
 * oracle — the builders evaluated exactly as the emitted `select()` would —
 * and required to resolve to exactly the picks.
 */
function verifiedGlobalCandidates(scene: Scene, refs: PickRef[], kind: "edge" | "face"): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    const ctx: InductionContext = globalContext(scene, index, kind);
    const pickKeys = new Set(attrs.map(a => a.pickedKey!));
    const candidates = induceFilterCandidates(index, ctx, attrs, pickKeys);
    for (const candidate of candidates) {
      const resolved = new Set(ctx.evaluate(candidate.builders).map(s => index.keyOf(s)));
      expect(resolved, candidate.filterArgs).toEqual(pickKeys);
    }
    return candidates.map(c => c.filterArgs);
  } finally {
    index.dispose();
  }
}

/** The code of every atom the scene-wide search is offered for the picks. */
function offeredAtoms(scene: Scene, refs: PickRef[], kind: "edge" | "face"): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    return globalContext(scene, index, kind).instantiate(attrs).map(atom => atom.code);
  } finally {
    index.dispose();
  }
}

/** The text of a selector part, as the synthesizer ranks it. */
function partText(part: SelectorPart): string {
  if (part.accessor === "select") {
    return `select(${part.filterArgs})`;
  }
  return `${part.accessor}(${part.indices ? part.indices.join(", ") : part.filterArgs ?? ""})`;
}

/** The ranked selector texts for the picks, winner first. */
function synthesized(scene: Scene, refs: PickRef[], bindable?: (feature: SceneObject, whole?: boolean) => boolean): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    const result = synthesizeSelectors(scene, index, attrs, [], [], false, bindable);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok === false) {
      return [];
    }
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    return [group.winner, ...group.alternatives].map(partText);
  } finally {
    index.dispose();
  }
}

/** A 40 × 20 × 10 slab whose far side is a spline: one spline edge on top, one at the bottom. */
function splineSlab() {
  sketch("xy", () => {
    line([0, 0], [40, 0]);
    line([40, 0], [40, 20]);
    spline([40, 20], [26, 26], [14, 16], [0, 20]);
    line([0, 20], [0, 0]);
  });
  const e = extrude(10);
  setLocation(e, 2);
  return e;
}

describe("synthesis over the kind predicates", () => {
  setupOC();
  useLoadedBodies();

  it("names the spline edge on top of a slab with spline()", () => {
    splineSlab();
    const scene = render();
    const solid = findSolid(scene);
    const splines = edgesWhere(solid, type => type === "spline");
    expect(splines).toHaveLength(2);

    const candidates = verifiedGlobalCandidates(scene, [splines[0]], "edge");
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toContain(".spline()");
  });

  it("names both spline edges with spline() alone", () => {
    splineSlab();
    const scene = render();
    const splines = edgesWhere(findSolid(scene), type => type === "spline");

    expect(verifiedGlobalCandidates(scene, splines, "edge")[0]).toBe("edge().spline()");
  });

  it("a fillet on a spline edge writes spline() and no magic number", () => {
    splineSlab();
    const scene = render();
    const splines = edgesWhere(findSolid(scene), type => type === "spline");

    const result = synthesizeApplyFeature(scene, [splines[0]], "fillet", 1);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok) {
      expect(result.preview).toContain("spline()");
      expect(result.preview).not.toMatch(/\d\.\d/);
    }
  });

  it("measures only the picked body's fillets when another body's lie clear of the pick", () => {
    FreeformBodies.filletedSlab();
    FreeformBodies.filletedSlab([100, 100]);
    const scene = render();
    const [picked, other] = findSolids(scene);
    const onBSpline = (solid: Shape) => new Set(solid.getSubShapes("face").filter(f => ShapeOps.controlHullRaw(f.getShape()) !== null));
    expect([onBSpline(picked).size, onBSpline(other).size]).toEqual([6, 6]);
    // A fillet along a spline on top of the first slab.
    const topFillet = Explorer.findFacesWrapped(picked)
      .findIndex(f => ShapeOps.controlHullRaw(f.getShape()) !== null && f.center().z > 5);
    const refs: PickRef[] = [{ shapeId: picked.id, sub: { type: "face", index: topFillet } }];

    const measured = vi.spyOn(ShapeOps, "extentAlong");
    try {
      const candidates = verifiedGlobalCandidates(scene, refs, "face");
      expect(candidates.length).toBeGreaterThan(0);
      const faces = new Set(measured.mock.calls.map(([shape]) => shape));
      expect([...onBSpline(picked)].some(f => faces.has(f))).toBe(true);
      expect([...onBSpline(other)].filter(f => faces.has(f))).toEqual([]);
    } finally {
      measured.mockRestore();
    }
  });

  it("offers facing() for an extruded wall, and names the one facing +y among three with it", () => {
    FreeformBodies.splineSlab();
    const scene = render();
    const solid = findSolid(scene);
    const walls = facesWhere(solid, type => type === "extruded");
    expect(walls).toHaveLength(3);
    const faces = Explorer.findFacesWrapped(solid);
    const far = walls.filter(ref => faces[ref.sub.index].center().y > 15);
    expect(far).toHaveLength(1);

    expect(offeredAtoms(scene, far, "face")).toContain(".facing('y')");
    expect(verifiedGlobalCandidates(scene, far, "face")[0]).toBe("face().facing('y')");
  });

  it("offers no facing() for picks on planes, cylinders, cones, spheres and tori", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [40, 0] });
    });
    extrude(10);
    sketch("xz", () => {
      line([0, 0], [8, 0]);
      arc([8, 0], [0, 8], [0, 0]);
      line([0, 8], [0, 0]);
    });
    revolve("z", 360);
    const scene = render();
    const [box, dome] = findSolids(scene);
    // The box's top faces +z and so does the dome, half a sphere whose mean normal is its pole.
    const top = facesWhere(box, () => true).filter(ref => Explorer.findFacesWrapped(box)[ref.sub.index].center().z > 9);
    const cap = facesWhere(dome, type => type === "sphere");
    expect([top.length, cap.length]).toEqual([1, 1]);
    expect(FaceQuery.meanNormal(Explorer.findFacesWrapped(dome)[cap[0].sub.index])?.z).toBeCloseTo(1, 6);

    for (const picks of [top, cap, [...top, ...cap]]) {
      expect(offeredAtoms(scene, picks, "face").filter(code => code.startsWith(".facing("))).toEqual([]);
    }
  });

  it("offers closed() for a full ellipse among open edges, and none for a circle, which circle() already says", () => {
    sketch("xy", () => {
      ellipse([0, 0], 12, 6);
      circle([40, 0], 10);
      testRect(10, 10, { at: [60, 0] });
    });
    extrude(5);
    const scene = render();
    const solids = findSolids(scene);
    const rimOf = (type: string) => solids.flatMap(solid => edgesWhere(solid, t => t === type)).slice(0, 1);
    const [ellipseRim, circleRim] = [rimOf("ellipse"), rimOf("circle")];
    expect([ellipseRim.length, circleRim.length]).toEqual([1, 1]);

    expect(offeredAtoms(scene, ellipseRim, "edge")).toContain(".closed()");
    expect(offeredAtoms(scene, circleRim, "edge").filter(code => code === ".closed()" || code === ".open()")).toEqual([]);
    expect(offeredAtoms(scene, [...ellipseRim, ...circleRim], "edge")).toContain(".closed()");
  });

  it("names the free-form wall of a loft with freeform()", () => {
    const base = sketch(plane("xy", 0), () => {
      circle([0, 0], 40);
    });
    const top = sketch(plane("xy", 30), () => {
      ellipse([0, 0], 5, 9);
    });
    loft(base, top);
    const scene = render();
    const walls = facesWhere(findSolid(scene), type => type === "freeform");
    expect(walls).toHaveLength(1);

    expect(verifiedGlobalCandidates(scene, walls, "face")[0]).toBe("face().freeform()");
  });

  it("names a surface's faces beside a solid with ofSurface()", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
    });
    extrude(10);
    const l = loadShapes([TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    const scene = render();
    const sheet = l.getShapes()[0];
    const faces = facesWhere(sheet, () => true);
    expect(faces).toHaveLength(5);

    expect(verifiedGlobalCandidates(scene, faces, "face")[0]).toBe("face().ofSurface()");
  });

  it("names a surface's edges beside a solid's with ofSurface()", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
    });
    extrude(10);
    const l = loadShapes([TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    const scene = render();
    const edges = edgesWhere(l.getShapes()[0], () => true);
    expect(edges).toHaveLength(12);

    expect(verifiedGlobalCandidates(scene, edges, "edge")[0]).toBe("edge().ofSurface()");
  });

  it("names an edge of a curve object through its edges() bucket, then select(edge().from(c))", () => {
    sketch("xy", () => {
      testRect(20, 10, { at: [100, 0] });
    });
    extrude(5);
    const c = path() as unknown as SceneObject;
    setLocation(c, 4);
    const scene = render();
    const arc = edgesWhere(c.getShapes()[0], type => type === "arc");
    expect(arc).toHaveLength(1);

    // The bucket route leads, its constant-free filter ahead of the index
    // as on any feature's bucket; the from() route follows.
    const texts = synthesized(scene, arc);
    expect(texts[0]).toBe("edges(edge().arc())");
    const index = texts.indexOf(`edges(${arc[0].sub.index})`);
    const from = texts.indexOf("select(edge().from({{r0}}).arc())");
    expect(index).toBeGreaterThan(0);
    expect(from).toBeGreaterThan(index);
    expect(texts.slice(from).every(text => text.startsWith("select(edge().from({{r0}})"))).toBe(true);
  });

  it("names an edge of a curve object by select(edge().from(c)) when its statement cannot bind an accessor", () => {
    const c = path() as unknown as SceneObject;
    setLocation(c, 2);
    const scene = render();
    const lines = edgesWhere(c.getShapes()[0], type => type === "line");
    expect(lines).toHaveLength(2);

    const texts = synthesized(scene, lines, (_feature, whole) => whole === true);
    expect(texts[0]).toBe("select(edge().from({{r0}}).line())");
    expect(texts.every(text => text.startsWith("select(edge().from({{r0}})"))).toBe(true);
  });

  it("never names a curve's edge by a bare scene-wide select()", () => {
    const c = path() as unknown as SceneObject;
    setLocation(c, 2);
    const scene = render();
    const arc = edgesWhere(c.getShapes()[0], type => type === "arc");

    const index = new SelectionIndex(scene);
    try {
      const attrs = arc.map(ref => attributePick(scene, index, ref));
      const refused = synthesizeSelectors(scene, index, attrs, [], [], false, () => false);
      expect(refused.ok).toBe(false);
      if (refused.ok === false) {
        expect(refused.reason).toContain("test-path() curve");
      }
    } finally {
      index.dispose();
    }
  });

  it("names a helix's edge as h.edges(), and a fillet refuses it", () => {
    sketch("xy", () => {
      testRect(20, 10);
    });
    extrude(5);
    const h = helix("z").radius(30).pitch(5).turns(2) as unknown as SceneObject;
    setLocation(h, 4);
    const scene = render();
    const pick: PickRef = { shapeId: h.getShapes()[0].id, sub: { type: "edge", index: 0 } };

    const texts = synthesized(scene, [pick]);
    expect(texts[0]).toBe("edges()");
    expect(texts).toContain("select(edge().from({{r0}}))");

    const fillet = synthesizeApplyFeature(scene, [pick], "fillet", 1);
    expect(fillet).toMatchObject({ ok: false, reason: "fillet: edge selection 1 holds a curve edge; fillet works on solids." });
  });
});
