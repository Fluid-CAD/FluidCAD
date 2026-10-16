// The spline primitive: a cubic interpolating B-spline THROUGH its points.
// Its fit points are solver anchor entities on the shared control-point
// curve rail (the bezier's) — constraints target `.point(i)`, the solve
// moves them, the kernel edge passes through the solved positions, and the
// render payload carries the same join fields the bezier's does.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import plane from "../../../core/plane.js";
import { line, spline, bezier, yAxis } from "../../../core/2d/index.js";
import { coincident, horizontal, fix, distance, symmetric } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { SplineCurve } from "../../../features/2d/spline.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Edge } from "../../../common/edge.js";
import { Scene } from "../../../rendering/scene.js";
import { EdgeQuery } from "../../../oc/edge-query.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Point } from "../../../math/point.js";

function payloadOf(scene: Scene, obj: unknown) {
  return scene.getRenderedObject(obj as SceneObject).object;
}

/** The curve's only live edge. */
function edgeOf(obj: unknown): Edge {
  const edges = (obj as SceneObject).getShapes().filter((s): s is Edge => s instanceof Edge);
  expect(edges).toHaveLength(1);
  return edges[0];
}

/** Points along the edge, `count` of them from start to end. */
function sample(edge: Edge, count: number): Point[] {
  const { first, last } = EdgeQuery.getEdgeCurveParams(edge);
  const points: Point[] = [];
  for (let i = 0; i <= count; i++) {
    points.push(EdgeQuery.sampleEdgeCurvePoint(edge, first + ((last - first) * i) / count));
  }
  return points;
}

function minDistance(points: Point[], target: Point): number {
  return Math.min(...points.map(p => p.distanceTo(target)));
}

describe("spline primitive", () => {
  setupOC();

  it("builds one smooth edge that passes through every fit point, in order", () => {
    let sp: unknown;
    sketch('xy', () => {
      sp = spline([0, 0], [20, 30], [50, 10], [80, 40], [100, 0]);
    });
    render();

    const edge = edgeOf(sp);
    expect(EdgeQuery.getEdgeCurveType(edge)).toBe('other');
    // Samples ~0.05 apart along a ~200-long curve: a fit point on the curve
    // is within half a step of one of them.
    const points = sample(edge, 4000);
    for (const [x, y] of [[0, 0], [20, 30], [50, 10], [80, 40], [100, 0]]) {
      expect(minDistance(points, new Point(x, y, 0))).toBeLessThan(0.05);
    }
    // Ordered start → end: the edge's ends are the first and last fit points.
    expect(points[0].distanceTo(new Point(0, 0, 0))).toBeLessThan(1e-6);
    expect(points[4000].distanceTo(new Point(100, 0, 0))).toBeLessThan(1e-6);
    // Through the points, not pulled by them: a bezier on the same poles
    // never reaches the middle ones.
    let bz: unknown;
    sketch('xy', () => {
      bz = bezier([0, 0], [20, 30], [50, 10], [80, 40], [100, 0]);
    });
    render();
    expect(minDistance(sample(edgeOf(bz), 4000), new Point(20, 30, 0))).toBeGreaterThan(5);
  });

  it("lands on the sketch plane when the plane is offset from the origin", () => {
    let sp: unknown;
    let marker: unknown;
    const p = plane('xz', { offset: 25 });
    sketch(p, () => {
      // A line from the middle fit point to the end: its vertices are where
      // the plane maps those sketch points, the reference for the curve.
      marker = line([10, 20], [30, 5]);
      sp = spline([0, 0], [10, 20], [30, 5]);
    });
    render();
    const [mid, end] = sample(edgeOf(marker), 1);
    const points = sample(edgeOf(sp), 2000);
    // Every sample sits on the plane (the xz plane's normal is y).
    for (const point of points) {
      expect(Math.abs(point.y - mid.y)).toBeLessThan(1e-6);
    }
    expect(Math.abs(mid.y)).toBeCloseTo(25, 6);
    expect(minDistance(points, mid)).toBeLessThan(0.05);
    expect(points[2000].distanceTo(end)).toBeLessThan(1e-6);
  });

  it("is a straight segment with two points and a quadratic-degree curve with three", () => {
    let two: unknown;
    let three: unknown;
    sketch('xy', () => {
      two = spline([0, 0], [40, 30]);
      three = spline([0, 0], [20, 20], [40, 0]);
    });
    render();
    const twoPoints = sample(edgeOf(two), 20);
    for (const point of twoPoints) {
      // On the chord: cross product with the direction vanishes.
      expect(Math.abs(point.x * 30 - point.y * 40)).toBeLessThan(1e-6);
    }
    const threePoints = sample(edgeOf(three), 200);
    expect(minDistance(threePoints, new Point(20, 20, 0))).toBeLessThan(0.05);
    expect(threePoints[100].y).toBeGreaterThan(15);
  });

  it("extrudes a closed profile with a spline side", () => {
    sketch('xy', () => {
      const base = line([0, 0], [100, 0]);
      const side = spline([100, 0], [80, 30], [100, 60]);
      const top = line([100, 60], [0, 60]);
      const back = line([0, 60], [0, 0]);
      coincident(base.end(), side.start());
      coincident(side.end(), top.start());
      coincident(top.end(), back.start());
      coincident(back.end(), base.start());
    });
    const e = extrude(10) as ExtrudeBase;
    render();
    const shapes = e.getShapes();
    expect(shapes.length).toBeGreaterThan(0);
    // The kernel's box around a B-spline-bounded solid is loose by its
    // tolerance; the whole-unit check is what the profile guarantees.
    const bbox = ShapeOps.getBoundingBox(shapes[0]);
    expect(bbox.minX).toBeCloseTo(0, 0);
    expect(bbox.maxX).toBeCloseTo(100, 0);
    expect(bbox.maxY).toBeCloseTo(60, 0);
    expect(bbox.maxZ).toBeCloseTo(10, 0);
  });

  it("serializes under its own type with the bezier-shaped payload (positions, anchors, sources)", () => {
    let sp: unknown;
    sketch('xy', () => {
      sp = spline([0, 0], [20, 30], [50, 10]);
    });
    const scene = render();
    const rendered = scene.getRenderedObject(sp as SceneObject)!;
    expect(rendered.type).toBe('spline');
    expect(rendered.uniqueType).toBe('spline-3');
    expect(() => JSON.stringify(rendered)).not.toThrow();
    const payload = rendered.object;
    expect(payload.startPoint).toEqual([0, 0]);
    expect(payload.resolvedPoints).toEqual([[20, 30], [50, 10]]);
    expect(payload.anchors).toHaveLength(3);
    expect(payload.anchors[1]).toMatchObject({ pointIndex: 1, guess: { x: 20, y: 30 } });
    expect(payload.controlSources).toEqual(payload.anchors.map((a: any) => ({ entityId: a.entityId, role: null })));
    expect(payload.sourcesSolved).toBe(true);
    expect(payload.sourceEntities).toHaveLength(3);
  });

  it("solves literal fit points against other entities and rebuilds the curve through them", () => {
    let sp: unknown;
    sketch('xy', () => {
      const l = line([1, -2], [48, 3]);
      fix(l.start(), [0, 0]);
      horizontal(l);
      distance(l.start(), l.end(), 50);
      const s = spline([47, 4], [75, 30], [103, 2]);
      sp = s;
      coincident(s.start(), l.end());
      fix(s.end(), [100, 0]);
      fix(s.point(1), [70, 40]);
    });
    const scene = render();

    const payload = payloadOf(scene, sp);
    expect(payload.startPoint[0]).toBeCloseTo(50, 6);
    expect(payload.startPoint[1]).toBeCloseTo(0, 6);
    expect(payload.resolvedPoints[0][0]).toBeCloseTo(70, 6);
    expect(payload.resolvedPoints[0][1]).toBeCloseTo(40, 6);
    expect(payload.resolvedPoints[1]).toEqual([expect.closeTo(100, 6), expect.closeTo(0, 6)]);
    // The kernel edge follows the solved points, not the guesses.
    const points = sample(edgeOf(sp), 400);
    expect(minDistance(points, new Point(50, 0, 0))).toBeLessThan(1e-6);
    expect(minDistance(points, new Point(70, 40, 0))).toBeLessThan(0.05);
    expect(minDistance(points, new Point(47, 4, 0))).toBeGreaterThan(1);
  });

  it("rides another entity's point when a fit point is an accessor", () => {
    let sp: unknown;
    let ln: unknown;
    sketch('xy', () => {
      const l = line([1, -2], [48, 3]);
      ln = l;
      fix(l.start(), [0, 0]);
      horizontal(l);
      distance(l.start(), l.end(), 50);
      sp = spline(l.end(), [75, 30], [100, 0]);
    });
    const scene = render();

    const payload = payloadOf(scene, sp);
    expect(payload.startPoint[0]).toBeCloseTo(50, 6);
    expect(payload.startPoint[1]).toBeCloseTo(0, 6);
    expect(payload.anchors.map((a: any) => a.pointIndex)).toEqual([1, 2]);
    const linePayload = payloadOf(scene, ln);
    expect(payload.controlSources).toEqual([
      { entityId: linePayload.entityId, role: 'end' },
      { entityId: payload.anchors[0].entityId, role: null },
      { entityId: payload.anchors[1].entityId, role: null },
    ]);
  });

  it("mirrors through one point-pair symmetric per fit point and fully constrains the image", () => {
    let source: unknown;
    let image: unknown;
    const s = sketch('xy', () => {
      const a = line([0, 0], [40, 0]);
      fix(a.start(), [0, 0]);
      horizontal(a);
      distance(a.start(), a.end(), 40);
      const sp1 = spline([10, 0], [25, 30], a.end());
      source = sp1;
      const sp2 = spline([-9, 1], [-24, 29], [-41, 2]);
      image = sp2;
      symmetric(sp1.point(0), sp2.point(0), yAxis());
      symmetric(sp1.point(1), sp2.point(1), yAxis());
      symmetric(a.end(), sp2.point(2), yAxis());
      coincident(sp1.point(0), a);
      distance(a.start(), sp1.point(0), 10);
      fix(sp1.point(1), [25, 30]);
    }) as unknown as Sketch;
    const scene = render();

    const src = payloadOf(scene, source);
    const img = payloadOf(scene, image);
    const srcPoints = [src.startPoint, ...src.resolvedPoints] as [number, number][];
    const imgPoints = [img.startPoint, ...img.resolvedPoints] as [number, number][];
    for (let i = 0; i < 3; i++) {
      expect(imgPoints[i][0]).toBeCloseTo(-srcPoints[i][0], 6);
      expect(imgPoints[i][1]).toBeCloseTo(srcPoints[i][1], 6);
    }
    const sketchPayload = payloadOf(scene, s);
    expect(sketchPayload.solver.outcome).toBe('solved');
    expect(sketchPayload.solver.dof).toBe(0);
  });

  it("refuses point(i) out of range and reports coincident fit points as the statement's error", () => {
    let sp: unknown;
    sketch('xy', () => {
      const s = spline([0, 0], [10, 10]);
      sp = s;
      expect(() => s.point(2)).toThrow(/point\(2\) is out of range/);
      expect(() => s.point(-1)).toThrow(/out of range/);
    });
    render();
    expect(sp).toBeInstanceOf(SplineCurve);

    let degenerate: unknown;
    sketch('xy', () => {
      degenerate = spline([5, 5], [5, 5], [5, 5]);
    });
    render();
    expect((degenerate as SceneObject).getError()).toMatch(/at least two distinct points/);
  });

  it("draws nothing with one point (the tool's first click) and compares by points and anchors", () => {
    let one: unknown;
    let a: unknown;
    let b: unknown;
    sketch('xy', () => {
      one = spline([3, 4]);
      a = spline([0, 0], [10, 5], [20, 0]);
      b = spline([0, 0], [10, 5], [20, 0]);
    });
    const scene = render();
    expect((one as SceneObject).getShapes()).toHaveLength(0);
    expect(payloadOf(scene, one).startPoint).toEqual([3, 4]);
    expect(payloadOf(scene, one).resolvedPoints).toEqual([]);
    // Same points, different anchors (separate statements): not equal.
    expect((a as SplineCurve).compareTo(b as SplineCurve)).toBe(false);
    expect((a as SplineCurve).compareTo(a as SplineCurve)).toBe(true);
  });
});
