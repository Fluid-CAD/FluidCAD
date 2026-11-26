import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { sketch, line, arc, eArc, spline, circle, ellipse, extrude, cut, select, helix, plane } from "../../core/index.js";
import { edge } from "../../filters/index.js";
import { EdgeFilterBuilder } from "../../filters/edge/edge-filter.js";
import { SelectSceneObject } from "../../features/select.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { CurveClassifier, CurveKind } from "../../oc/curve-classifier.js";
import { Matrix4 } from "../../math/matrix4.js";
import { Vector3d } from "../../math/vector3d.js";
import { Point } from "../../math/point.js";

/**
 * A 10 mm slab whose outline runs a line, an arc, a line, an elliptical arc,
 * a spline and a line, pierced by a round hole and an elliptical hole: every
 * kind of edge a solid carries — 12 lines, 2 arcs, 2 circles, 2 elliptical
 * arcs, 2 full ellipses and 2 splines (the holes' seams are no candidates).
 */
function slab(): SceneObject {
  sketch("xy", () => {
    line([0, 0], [40, 0]);
    arc([40, 0], [40, 20], [40, 10]);
    line([40, 20], [30, 20]);
    eArc([30, 20], [10, 20], [20, 20], 10, 5);
    spline([10, 20], [6, 24], [3, 16], [0, 20]);
    line([0, 20], [0, 0]);
  });
  const body = extrude(10) as unknown as SceneObject;
  sketch(plane("xy", 10), () => {
    circle([10, 8], 6);
  });
  cut();
  sketch(plane("xy", 10), () => {
    ellipse([28, 8], 5, 2.5);
  });
  cut();
  return body;
}

function kinds(sel: SelectSceneObject): CurveKind[] {
  return (sel.getShapes() as Edge[]).map(e => CurveClassifier.classify(e).kind).sort();
}

function count(sel: SelectSceneObject): number {
  return sel.getShapes().length;
}

describe("edge kind predicates", () => {
  setupOC();

  it("the slab carries every kind of edge", () => {
    slab();
    const all = select(edge()) as SelectSceneObject;
    render();
    const byKind = new Map<CurveKind, number>();
    for (const kind of kinds(all)) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    expect(Object.fromEntries(byKind)).toEqual({ line: 12, arc: 2, circle: 2, ellipse: 4, spline: 2 });
  });

  it("ellipse() keeps full ellipses and elliptical arcs, notEllipse() the rest", () => {
    slab();
    const ellipses = select(edge().ellipse()) as SelectSceneObject;
    const others = select(edge().notEllipse()) as SelectSceneObject;
    const full = select(edge().ellipse().closed()) as SelectSceneObject;
    const arcs = select(edge().ellipse().open()) as SelectSceneObject;
    render();
    expect(kinds(ellipses)).toEqual(["ellipse", "ellipse", "ellipse", "ellipse"]);
    expect(count(others)).toBe(18);
    expect(kinds(others)).not.toContain("ellipse");
    expect(count(full)).toBe(2);
    expect(count(arcs)).toBe(2);
    for (const e of full.getShapes() as Edge[]) {
      expect(CurveClassifier.classify(e).minorRadius).toBeCloseTo(2.5, 6);
    }
  });

  it("spline() keeps the free-form edges, notSpline() the rest", () => {
    slab();
    const splines = select(edge().spline()) as SelectSceneObject;
    const others = select(edge().notSpline()) as SelectSceneObject;
    render();
    expect(kinds(splines)).toEqual(["spline", "spline"]);
    expect(count(others)).toBe(20);
    expect(kinds(others)).not.toContain("spline");
  });

  it("closed() keeps the full circles and ellipses; open() and notClosed() the rest", () => {
    slab();
    const closed = select(edge().closed()) as SelectSceneObject;
    const notOpen = select(edge().notOpen()) as SelectSceneObject;
    const open = select(edge().open()) as SelectSceneObject;
    const notClosed = select(edge().notClosed()) as SelectSceneObject;
    render();
    expect(kinds(closed)).toEqual(["circle", "circle", "ellipse", "ellipse"]);
    expect(kinds(notOpen)).toEqual(kinds(closed));
    expect(count(open)).toBe(18);
    expect(kinds(open)).not.toContain("circle");
    expect(kinds(notClosed)).toEqual(kinds(open));
  });

  it("planar() keeps every edge of the slab; notPlanar() keeps a helix", () => {
    slab();
    const h = helix("z").pitch(5).turns(3) as unknown as SceneObject;
    const planar = select(edge().planar()) as SelectSceneObject;
    const notPlanar = select(edge().notPlanar()) as SelectSceneObject;
    const helixPlanar = select(edge().from(h).planar()) as SelectSceneObject;
    const helixNotPlanar = select(edge().from(h).spline().notPlanar()) as SelectSceneObject;
    render();
    expect(count(planar)).toBe(22);
    expect(count(notPlanar)).toBe(0);
    expect(count(helixPlanar)).toBe(0);
    expect(count(helixNotPlanar)).toBe(1);
  });

  it("the kind predicates are unchanged by a transform and compare by kind", () => {
    const mirror = Matrix4.mirrorPlane(new Vector3d(1, 0, 0), new Point(0, 0, 0));
    const build = (pick: (b: EdgeFilterBuilder) => EdgeFilterBuilder) => pick(edge()).getFilters()[0];
    const picks: ((b: EdgeFilterBuilder) => EdgeFilterBuilder)[] = [
      b => b.ellipse(), b => b.notEllipse(), b => b.spline(), b => b.notSpline(),
      b => b.closed(), b => b.notClosed(), b => b.open(), b => b.notOpen(),
      b => b.planar(), b => b.notPlanar(),
    ];
    for (const pick of picks) {
      const filter = build(pick);
      const moved = filter.transform(mirror);
      expect(moved.constructor).toBe(filter.constructor);
      expect(moved.compareTo(filter)).toBe(true);
    }
  });
});
