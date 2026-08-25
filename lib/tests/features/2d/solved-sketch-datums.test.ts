import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, circle, point, origin, xAxis, yAxis } from "../../../core/2d/index.js";
import {
  coincident, horizontal, distance, symmetric, collinear, equal, midpoint, fix, angle,
} from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Scene } from "../../../rendering/scene.js";
import { SceneObject } from "../../../common/scene-object.js";
import type { ISolvedLine, ISolvedCircle } from "../../../core/interfaces.js";

function renderedByUniqueType(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

function sketchPayload(scene: Scene, s: Sketch) {
  return scene.getRenderedObject(s as unknown as SceneObject).object;
}

describe("sketch datums (origin + axes) through statements", () => {
  setupOC();

  it("every solved sketch carries the three fixed datum entities in its payload", () => {
    const s = sketch('xy', () => {
      line([3, 4], [40, 9]);
    }, true) as unknown as Sketch;
    const scene = render();

    const payload = sketchPayload(scene, s);
    const datums = payload.solver.entities.filter((e: any) => e.id < 0);
    expect(datums.map((e: any) => e.id)).toEqual([-1, -2, -3]);
    expect(datums.every((e: any) => e.fixed)).toBe(true);
    // Statement entities keep the ≥ 0 range untouched.
    const statements = payload.solver.entities.filter((e: any) => e.id >= 0);
    expect(statements).toHaveLength(1);
    expect(statements[0].id).toBe(0);
  });

  it("an empty solved sketch still stores the datum snapshot, with no DOF verdict", () => {
    const s = sketch('xy', () => {}, true) as unknown as Sketch;
    const scene = render();

    const payload = sketchPayload(scene, s);
    expect(payload.solvedMode).toBe(true);
    expect(payload.solver).toBeTruthy();
    expect(payload.solver.entities).toHaveLength(3);
    expect(payload.solver.dof).toBeNull();
    expect(payload.solver.outcome).toBeNull();
  });

  it("coincident(l.start(), origin()) + horizontal + dim fully places a line", () => {
    sketch('xy', () => {
      const l = line([2, 3], [50, 6]) as unknown as ISolvedLine;
      coincident(l.start(), origin());
      horizontal(l);
      distance(l.start(), l.end(), 60);
    }, true);
    const scene = render();

    const [l] = renderedByUniqueType(scene, 'solved-line');
    expect(l.hasError).toBe(false);
    expect(l.object.start.x).toBeCloseTo(0, 6);
    expect(l.object.start.y).toBeCloseTo(0, 6);
    expect(l.object.end.x).toBeCloseTo(60, 6);
    expect(l.object.end.y).toBeCloseTo(0, 6);
  });

});

describe("sketch datum golden solves", () => {
  setupOC();

  it("symmetric about yAxis() mirrors two circle centers", () => {
    sketch('xy', () => {
      const a = circle([-25, 14], 16) as unknown as ISolvedCircle;
      const b = circle([31, 12], 16) as unknown as ISolvedCircle;
      fix(a.center());
      equal(a, b);
      symmetric(a.center(), b.center(), yAxis());
    }, true);
    const scene = render();

    const circles = renderedByUniqueType(scene, 'solved-circle');
    expect(circles).toHaveLength(2);
    expect(circles.every(c => !c.hasError)).toBe(true);
    expect(circles[1].object.center.x).toBeCloseTo(25, 6);
    expect(circles[1].object.center.y).toBeCloseTo(14, 6);
  });

  it("collinear(xAxis(), l) + distance(yAxis(), p, ...) reference the axes", () => {
    sketch('xy', () => {
      const l = line([5, 2], [60, -1]) as unknown as ISolvedLine;
      const p = point([12, 30]);
      collinear(xAxis(), l);
      coincident(p, xAxis());
      distance(yAxis(), p, 45);
    }, true);
    const scene = render();

    const [l] = renderedByUniqueType(scene, 'solved-line');
    expect(l.hasError).toBe(false);
    expect(l.object.start.y).toBeCloseTo(0, 6);
    expect(l.object.end.y).toBeCloseTo(0, 6);

    const [p] = renderedByUniqueType(scene, 'solved-point');
    expect(p.hasError).toBe(false);
    expect(p.object.y).toBeCloseTo(0, 6);
    expect(Math.abs(p.object.x)).toBeCloseTo(45, 6);
  });

  it("distance(l, xAxis(), d) normalizes the axis into the line-carrier slot", () => {
    sketch('xy', () => {
      const l = line([0, 18], [50, 22]) as unknown as ISolvedLine;
      horizontal(l);
      coincident(l.start(), yAxis());
      distance(l.start(), l.end(), 50);
      // Axis passed second: the line–line form measures b's midpoint to a's
      // infinite line, so the statement layer must put the axis at a.
      distance(l, xAxis(), 20);
    }, true);
    const scene = render();

    const [l] = renderedByUniqueType(scene, 'solved-line');
    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims.every(d => !d.hasError)).toBe(true);
    expect(l.object.start.y).toBeCloseTo(20, 6);
    expect(l.object.end.y).toBeCloseTo(20, 6);
    expect(l.object.start.x).toBeCloseTo(0, 6);
  });

  it("angle(xAxis(), l, deg) orients a line from the axis", () => {
    sketch('xy', () => {
      const l = line([0, 0], [40, 8]) as unknown as ISolvedLine;
      coincident(l.start(), origin());
      distance(l.start(), l.end(), 40);
      angle(xAxis(), l, 30);
    }, true);
    const scene = render();

    const [l] = renderedByUniqueType(scene, 'solved-line');
    expect(l.hasError).toBe(false);
    expect(l.object.end.x).toBeCloseTo(40 * Math.cos(Math.PI / 6), 5);
    expect(l.object.end.y).toBeCloseTo(40 * Math.sin(Math.PI / 6), 5);
  });
});

describe("sketch datum misuse diagnostics", () => {
  setupOC();

  it("a constraint referencing only datums errors on that statement", () => {
    sketch('xy', () => {
      const l = line([0, 0], [30, 0]);
      fix(l.start());
      fix(origin());
    }, true);
    const scene = render();

    const fixes = renderedByUniqueType(scene, 'constraint-fix');
    expect(fixes).toHaveLength(2);
    const bad = fixes[1];
    expect(bad.hasError).toBe(true);
    expect(bad.errorMessage).toContain('references only fixed geometry');
    // The valid statements are untouched.
    expect(fixes[0].hasError).toBe(false);
    expect(renderedByUniqueType(scene, 'solved-line')[0].hasError).toBe(false);
  });

  it("equal against an axis and midpoint on an axis are refused with pointed messages", () => {
    sketch('xy', () => {
      const l = line([0, 0], [30, 0]);
      const p = point([5, 5]);
      fix(l.start());
      equal(l, xAxis());
      midpoint(p, yAxis());
    }, true);
    const scene = render();

    const eq = renderedByUniqueType(scene, 'constraint-equal')[0];
    expect(eq.hasError).toBe(true);
    expect(eq.errorMessage).toContain('no length to equate');

    const mid = renderedByUniqueType(scene, 'constraint-midpoint')[0];
    expect(mid.hasError).toBe(true);
    expect(mid.errorMessage).toContain('midpoint is undefined');
  });

  it("datum accessors in a legacy sketch fail on the constraint, not the sketch", () => {
    sketch('xy', () => {
      line([0, 0], [30, 0]);
      coincident(origin(), origin());
    });
    const scene = render();

    const c = renderedByUniqueType(scene, 'constraint-coincident')[0];
    expect(c.hasError).toBe(true);
    expect(c.errorMessage).toContain('constraint-mode sketch');
  });

  it("another sketch's datum is refused as cross-sketch", () => {
    let stolen: ReturnType<typeof origin> | null = null;
    sketch('xy', () => {
      line([0, 0], [10, 0]);
      stolen = origin();
    }, true);
    sketch('xz', () => {
      const l = line([0, 0], [30, 0]);
      coincident(l.start(), stolen!);
    }, true);
    const scene = render();

    const constraints = renderedByUniqueType(scene, 'constraint-coincident');
    expect(constraints).toHaveLength(1);
    expect(constraints[0].hasError).toBe(true);
    expect(constraints[0].errorMessage).toContain('another sketch');
  });

  it("line–circle distance to an axis and origin-on-circumference both solve", () => {
    sketch('xy', () => {
      const c = circle([10, 10], 16) as unknown as ISolvedCircle;
      fix(c.center());
      distance(c, xAxis(), 2); // line–circle form with the axis passed second
    }, true);
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims[0].hasError).toBe(false);
    const [c] = renderedByUniqueType(scene, 'solved-circle');
    expect(c.hasError).toBe(false);
    expect(c.object.diameter).toBeCloseTo(16, 6);
  });

  it("coincident(c, origin()) puts the origin on the circumference", () => {
    sketch('xy', () => {
      const c = circle([3, 4], 8) as unknown as ISolvedCircle;
      fix(c.center());
      coincident(c, origin());
    }, true);
    const scene = render();

    const co = renderedByUniqueType(scene, 'constraint-coincident');
    expect(co[0].hasError).toBe(false);
    const [c] = renderedByUniqueType(scene, 'solved-circle');
    expect(c.object.diameter).toBeCloseTo(10, 6);
  });
});
