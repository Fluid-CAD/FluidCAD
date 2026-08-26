import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, circle, arc, point } from "../../../core/2d/index.js";
import {
  coincident, horizontal, vertical, fix, distance, tangent, radius, diameter, equal, parallel,
} from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { ExtrudeBase } from "../../../features/extrude-base.js";
import { Solid } from "../../../common/solid.js";
import { Scene } from "../../../rendering/scene.js";
import { SceneObject } from "../../../common/scene-object.js";
import { getBoundingBoxOfShapes } from "../../utils.js";
import type { ISolvedLine, ISolvedArc, ISolvedCircle } from "../../../core/interfaces.js";

function renderedByUniqueType(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

function solvedLinePayloads(scene: Scene) {
  return renderedByUniqueType(scene, 'solved-line').map(r => r.object);
}

// The canonical rectangle: rough guesses, exact constraints. 16 params vs
// 8 (coincidents) + 4 (h/v) + 2 (fix) + 2 (dims) rows = fully constrained.
function declareRectangle() {
  return sketch('xy', () => {
    const b = line([1, -2], [99, 3]);
    const r = line([99, 3], [101, 52]);
    const t = line([101, 52], [-2, 48]);
    const l = line([-2, 48], [1, -2]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [0, 0]);
    distance(b.start(), b.end(), 100);
    distance(r.start(), r.end(), 50);
    return { b, r, t, l };
  }) as unknown as Sketch;
}

describe("solved sketch (constraint mode)", () => {
  setupOC();

  it("solves the dimensioned rectangle exactly and extrudes it", () => {
    declareRectangle();
    const e = extrude(10) as ExtrudeBase;
    const scene = render();

    const lines = solvedLinePayloads(scene);
    expect(lines).toHaveLength(4);

    const bottom = lines[0];
    expect(bottom.start.x).toBeCloseTo(0, 6);
    expect(bottom.start.y).toBeCloseTo(0, 6);
    expect(bottom.end.x).toBeCloseTo(100, 6);
    expect(bottom.end.y).toBeCloseTo(0, 6);

    const right = lines[1];
    expect(right.end.x).toBeCloseTo(100, 6);
    expect(right.end.y).toBeCloseTo(50, 6);

    expect(e.getShapes()).toHaveLength(1);
    const solid = e.getShapes()[0] as Solid;
    const bbox = getBoundingBoxOfShapes([solid]);
    expect(bbox.maxX - bbox.minX).toBeCloseTo(100, 4);
    expect(bbox.maxY - bbox.minY).toBeCloseTo(50, 4);
    expect(bbox.maxZ - bbox.minZ).toBeCloseTo(10, 4);
  });

  it("reports a fully-constrained rectangle at 0 DOF in the sketch payload", () => {
    const s = declareRectangle();
    const scene = render();

    const payload = scene.getRenderedObject(s as unknown as SceneObject).object;
    expect(payload.solvedMode).toBe(true);
    expect(payload.solver).toBeTruthy();
    expect(payload.solver.outcome).toBe('solved');
    expect(payload.solver.dof).toBe(0);
    expect(payload.solver.conflicting).toEqual([]);
    expect(payload.solver.redundant).toEqual([]);
    // 4 statement entities + the 3 implicit datums (origin + axes).
    expect(payload.solver.entities.filter((e: any) => e.id >= 0)).toHaveLength(4);
    expect(payload.solver.entities.filter((e: any) => e.id < 0)).toHaveLength(3);
    // 8 user constraints + no internal records for lines.
    expect(payload.solver.constraints.filter((c: any) => !c.internal)).toHaveLength(11);
  });

  it("keeps under-constrained geometry at its guesses and counts DOF", () => {
    const s = sketch('xy', () => {
      line([0, 0], [40, 5]);
    }) as unknown as Sketch;
    const scene = render();

    const payload = scene.getRenderedObject(s as unknown as SceneObject).object;
    expect(payload.solver.outcome).toBe('solved');
    expect(payload.solver.dof).toBe(4);
    const [l] = solvedLinePayloads(scene);
    expect(l.start).toEqual({ x: 0, y: 0 });
    expect(l.end).toEqual({ x: 40, y: 5 });
  });

  it("solves a line-arc junction tangency (junction form) with a radius dim", () => {
    sketch('xy', () => {
      const l = line([0, 0], [48, 2]);
      const a = (arc([48, 2], [70, 25], [50, 22]) as ISolvedArc);
      coincident(l.end(), a.start());
      tangent(l, a);
      fix(l.start());
      horizontal(l);
      radius(a, 20);
      distance(l.start(), l.end(), 50);
    });
    const scene = render();

    const arcPayload = renderedByUniqueType(scene, 'solved-arc')[0].object;
    expect(arcPayload.radius).toBeCloseTo(20, 6);
    // Junction tangency: the radius to the junction is perpendicular to the
    // (horizontal) line, so the center sits straight above/below the join.
    expect(Math.abs(arcPayload.center.x - arcPayload.start.x)).toBeLessThan(1e-6);
    expect(Math.abs(Math.abs(arcPayload.center.y - arcPayload.start.y) - 20)).toBeLessThan(1e-6);
    // The line end landed on the 50 dim.
    const linePayload = solvedLinePayloads(scene)[0];
    expect(linePayload.end.x).toBeCloseTo(50, 6);
    expect(linePayload.end.y).toBeCloseTo(0, 6);
  });

  it("dimensions a line against an arc's circumference (line–arc distance)", () => {
    sketch('xy', () => {
      const l1 = line([0, 0], [0, 100]);
      const a1 = (arc([140, 30], [140, 70], [140, 50]) as ISolvedArc);
      vertical(l1);
      fix(l1.start());
      distance(l1.start(), l1.end(), 100);
      radius(a1, 20);
      distance(l1, a1, 130);
    });
    const scene = render();

    const arcPayload = renderedByUniqueType(scene, 'solved-arc')[0].object;
    // Gap 130 to the circumference of a radius-20 arc: the center sits
    // 150 off the (vertical, x=0) line — not 130, which would be the
    // center-distance reading.
    expect(arcPayload.center.x).toBeCloseTo(150, 6);
    expect(arcPayload.radius).toBeCloseTo(20, 6);
  });

  it("distance(l, a).max() dimensions the arc's FAR side", () => {
    sketch('xy', () => {
      const l1 = line([0, 0], [0, 100]);
      const a1 = (arc([140, 30], [140, 70], [140, 50]) as ISolvedArc);
      vertical(l1);
      fix(l1.start());
      distance(l1.start(), l1.end(), 100);
      radius(a1, 20);
      distance(l1, a1, 170).max();
    });
    const scene = render();

    const arcPayload = renderedByUniqueType(scene, 'solved-arc')[0].object;
    // Far side 170 with r = 20 → the center lands 150 off the (x=0) line;
    // the near-side default would have pushed it to 190.
    expect(arcPayload.center.x).toBeCloseTo(150, 6);
    expect(arcPayload.radius).toBeCloseTo(20, 6);
  });

  it("solves circles with diameter dims and points with fix", () => {
    sketch('xy', () => {
      const p = point([3, 4]);
      fix(p, [10, 10]);
      const c = (circle([12, 9], 30) as unknown as ISolvedCircle);
      coincident(p, c.center());
      diameter(c, 44);
    });
    const scene = render();

    const circlePayload = renderedByUniqueType(scene, 'solved-circle')[0].object;
    expect(circlePayload.center.x).toBeCloseTo(10, 6);
    expect(circlePayload.center.y).toBeCloseTo(10, 6);
    expect(circlePayload.diameter).toBeCloseTo(44, 6);

    const pointPayload = renderedByUniqueType(scene, 'solved-point')[0].object;
    expect(pointPayload.x).toBeCloseTo(10, 6);
    expect(pointPayload.y).toBeCloseTo(10, 6);
  });

  it("equates three line lengths with one variadic equal()", () => {
    sketch('xy', () => {
      const a = line([0, 0], [30, 0]);
      const b = line([0, 10], [18, 10]);
      const c = line([0, 20], [44, 20]);
      horizontal(a);
      horizontal(b);
      horizontal(c);
      fix(a.start(), [0, 0]);
      fix(b.start(), [0, 10]);
      fix(c.start(), [0, 20]);
      distance(a.start(), a.end(), 30);
      equal(a, b, c);
    });
    const scene = render();

    const lines = solvedLinePayloads(scene);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)).toBeCloseTo(30, 6);
    }
  });

  it("parallels three lines with one variadic parallel()", () => {
    sketch('xy', () => {
      const a = line([0, 0], [30, 15]);
      const b = line([0, 10], [30, 18]);
      const c = line([0, 20], [30, 42]);
      fix(a.start(), [0, 0]);
      fix(a.end(), [30, 15]);
      fix(b.start(), [0, 10]);
      fix(c.start(), [0, 20]);
      parallel(a, b, c);
    });
    const scene = render();

    const lines = solvedLinePayloads(scene);
    expect(lines).toHaveLength(3);
    const [la, lb, lc] = lines.map(l => [l.end.x - l.start.x, l.end.y - l.start.y]);
    // sin of the angle to a ≈ 0 for every follower — directions match a's.
    const sinTo = (d: number[]): number =>
      (la[0] * d[1] - la[1] * d[0]) / (Math.hypot(la[0], la[1]) * Math.hypot(d[0], d[1]));
    expect(sinTo(lb)).toBeCloseTo(0, 6);
    expect(sinTo(lc)).toBeCloseTo(0, 6);
  });

  it("equates circle/arc radii with one variadic equal()", () => {
    sketch('xy', () => {
      const c1 = circle([0, 0], 20);
      const c2 = circle([50, 0], 33);
      const a = arc([100, 8], [84, -8], [92, 0]);
      diameter(c1, 20);
      equal(c1, c2, a);
    });
    const scene = render();

    for (const r of renderedByUniqueType(scene, 'solved-circle')) {
      expect(r.object.diameter).toBeCloseTo(20, 6);
    }
    const arcPayload = renderedByUniqueType(scene, 'solved-arc')[0].object;
    const arcRadius = Math.hypot(
      arcPayload.start.x - arcPayload.center.x,
      arcPayload.start.y - arcPayload.center.y,
    );
    expect(arcRadius).toBeCloseTo(10, 6);
  });

  it("lowers coincident(p, l.mid()) to the midpoint constraint", () => {
    sketch('xy', () => {
      const l = line([0, 0], [20, 0]);
      fix(l.start());
      fix(l.end());
      const p = point([3, 8]);
      coincident(p, (l as unknown as ISolvedLine).mid());
    });
    const scene = render();

    const pointPayload = renderedByUniqueType(scene, 'solved-point')[0].object;
    expect(pointPayload.x).toBeCloseTo(10, 6);
    expect(pointPayload.y).toBeCloseTo(0, 6);
  });

  it("is statement-order agnostic: interleaved constraints solve identically", () => {
    declareRectangle();
    const grouped = render();
    const groupedLines = solvedLinePayloads(grouped).map(l => [l.start, l.end]);

    getSceneManager().startScene();
    sketch('xy', () => {
      const b = line([1, -2], [99, 3]);
      horizontal(b);
      fix(b.start(), [0, 0]);
      distance(b.start(), b.end(), 100);
      const r = line([99, 3], [101, 52]);
      coincident(b.end(), r.start());
      vertical(r);
      distance(r.start(), r.end(), 50);
      const t = line([101, 52], [-2, 48]);
      coincident(r.end(), t.start());
      horizontal(t);
      const l = line([-2, 48], [1, -2]);
      coincident(t.end(), l.start());
      coincident(l.end(), b.start());
      vertical(l);
    });
    const interleaved = render();
    const interleavedLines = solvedLinePayloads(interleaved).map(l => [l.start, l.end]);

    expect(interleavedLines).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        expect(interleavedLines[i][j].x).toBeCloseTo(groupedLines[i][j].x, 9);
        expect(interleavedLines[i][j].y).toBeCloseTo(groupedLines[i][j].y, 9);
      }
    }
  });

  it("solves deterministically across two fresh scenes (bit-identical params)", () => {
    const s1 = declareRectangle();
    const scene1 = render();
    const params1 = scene1.getRenderedObject(s1 as unknown as SceneObject).object.solver.params;

    getSceneManager().startScene();
    const s2 = declareRectangle();
    const scene2 = render();
    const params2 = scene2.getRenderedObject(s2 as unknown as SceneObject).object.solver.params;

    expect(params2).toEqual(params1);
  });
});
