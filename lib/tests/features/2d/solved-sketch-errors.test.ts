import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import sketch from "../../../core/sketch.js";
import { line, circle, rect, hLine, tArc, point } from "../../../core/2d/index.js";
import {
  coincident, horizontal, vertical, fix, distance, parallel, angle,
} from "../../../core/constraints/index.js";
import { Scene } from "../../../rendering/scene.js";
import type { ISolvedCircle } from "../../../core/interfaces.js";

function renderedByUniqueType(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType);
}

describe("solved sketch diagnostics and mode-mixing errors", () => {
  setupOC();

  it("rejects pen/imperative commands per statement, keeping the rest alive", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      fix(a.start());
      hLine(30);
      line([60, 0]);
      rect(20, 10);
    }, true);
    const scene = render();

    const hline = renderedByUniqueType(scene, 'hline')[0];
    expect(hline.hasError).toBe(true);
    expect(hline.errorMessage).toContain('hLine');
    expect(hline.errorMessage).toContain('horizontal');

    const chained = renderedByUniqueType(scene, 'line-two-points')[0];
    expect(chained.hasError).toBe(true);
    expect(chained.errorMessage).toContain('line(start, end)');

    const rectRow = renderedByUniqueType(scene, 'rect')[0];
    expect(rectRow.hasError).toBe(true);

    // The valid solved line still renders its edge.
    const solved = renderedByUniqueType(scene, 'solved-line')[0];
    expect(solved.hasError).toBe(false);
    expect(solved.sceneShapes.length).toBeGreaterThan(0);
  });

  it("rejects .max() on a distance with no circle/arc entity target", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const b = line([0, 20], [50, 20]);
      const c = circle([100, 0], 10) as unknown as ISolvedCircle;
      fix(a.start());
      distance(a, b, 20).max();
      // The accessor form is a point reference — no tangency side either.
      distance(a, c.center(), 100).max();
    }, true);
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims).toHaveLength(2);
    for (const dim of dims) {
      expect(dim.hasError).toBe(true);
      expect(dim.errorMessage).toContain('circle or arc target');
    }
  });

  it("rejects the center-less circle form in a solved sketch", () => {
    sketch('xy', () => {
      circle(40);
    }, true);
    const scene = render();

    const legacy = renderedByUniqueType(scene, 'circle')[0];
    expect(legacy.hasError).toBe(true);
    expect(legacy.errorMessage).toContain('explicit center');
  });

  it("rejects tArc in a solved sketch with the arc+tangent hint", () => {
    sketch('xy', () => {
      line([0, 0], [40, 0]);
      tArc([60, 20]);
    }, true);
    const scene = render();

    const rows = scene.getRenderedObjects().filter(r => r.uniqueType.startsWith('tarc'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].hasError).toBe(true);
    expect(rows[0].errorMessage).toContain('tangent');
  });

  it("errors constraints used outside a solved-mode sketch", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const b = line([0, 10], [50, 10]);
      parallel(a, b);
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-parallel')[0];
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('sketch(plane, callback, true)');
  });

  it("errors point() outside a solved-mode sketch", () => {
    sketch('xy', () => {
      point([5, 5]);
      line([0, 0], [10, 0]);
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'solved-point')[0];
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('constraint-mode sketch');
  });

  it("marks contradictory dimensions conflicting while geometry still renders", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      fix(a.start());
      horizontal(a);
      distance(a.start(), a.end(), 50);
      distance(a.start(), a.end(), 80);
    }, true);
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims).toHaveLength(2);
    expect(dims.every(d => d.hasError)).toBe(true);
    expect(dims[0].errorMessage).toContain('conflicts with');

    // Least-bad geometry still renders an edge.
    const solved = renderedByUniqueType(scene, 'solved-line')[0];
    expect(solved.sceneShapes.length).toBeGreaterThan(0);
  });

  it("H + V + angle(80°) conflicts instead of collapsing the vertical leg", () => {
    // Marwan's triangle: horizontal + vertical lock the angle at 90°,
    // then angle() demands 80°. Pre-guard, the solver collapsed l3 to
    // ~1e-8 length ("solved", no diagnostics — the triangle rendered
    // as one horizontal line); the collapse guard + relative conflict
    // threshold name exactly the inconsistent cluster.
    sketch('xy', () => {
      const l2 = line([234.16, 199.21], [120.59, 160.45]);
      const l1 = line([120.59, 160.45], [234.16, 160.45]);
      const l3 = line([234.16, 160.45], [234.16, 199.21]);
      horizontal(l1);
      coincident(l2.end(), l1.start());
      coincident(l3.start(), l1.end());
      vertical(l3);
      coincident(l2.start(), l3.end());
      distance(l2.end(), l2.start(), 120);
      angle(l3, l1, 80);
    }, true);
    const scene = render();

    const angleRow = renderedByUniqueType(scene, 'constraint-angle')[0];
    for (const type of ['constraint-horizontal', 'constraint-vertical', 'constraint-angle']) {
      const row = renderedByUniqueType(scene, type)[0];
      expect(row.hasError).toBe(true);
      expect(row.errorMessage).toContain('conflicts with');
    }
    for (const type of ['constraint-coincident', 'constraint-distance']) {
      expect(renderedByUniqueType(scene, type).every(r => !r.hasError)).toBe(true);
    }

    // The vertical leg still holds its drawn size, not collapsed.
    const payload =
      scene.getRenderedObject(scene.getSceneObjectById(angleRow.parentId)!).object;
    const l3Entity = payload.solver.entities[2];
    expect(l3Entity.kind).toBe('line');
    const p = payload.solver.params;
    const o = l3Entity.paramOffset;
    expect(Math.hypot(p[o + 2] - p[o], p[o + 3] - p[o + 1])).toBeGreaterThan(1);
  });

  it("rejects negative angle values with the swapped-pair hint", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const b = line([0, 0], [40, 30]);
      angle(a, b, -60);
    }, true);
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-angle')[0];
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('no negative angles');
    expect(row.errorMessage).toContain('angle(b, a, 60)');
  });

  it("endpoint accessors orient the angle's directions — the supplementary sector solves", () => {
    sketch('xy', () => {
      const a = line([0, 0], [100, 0]);
      fix(a.start());
      fix(a.end());
      // Guessed near 236° so the solve converges on the intended branch.
      const b = line([100, 0], [55, -80]);
      coincident(a.end(), b.start());
      distance(b.start(), b.end(), 100);
      // CCW from a (+x) to b oriented toward its START = 60° — b itself
      // must point at 240°. The bare-ref form can't name this sector
      // with a positive value; the accessor form is the encoding.
      angle(a, b.start(), 60);
    }, true);
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-angle')[0];
    expect(row.hasError).toBe(false);

    const payload = scene.getRenderedObject(scene.getSceneObjectById(row.parentId)!).object;
    const record = payload.solver.constraints.find((c: any) => c.spec.kind === 'angle');
    expect(record.spec.b.point).toBe('start');
    expect(record.spec.value).toBeCloseTo(Math.PI / 3, 10);

    const bEntity = payload.solver.entities[1];
    const p = payload.solver.params;
    const o = bEntity.paramOffset;
    expect(p[o + 2] - p[o]).toBeCloseTo(100 * Math.cos((240 * Math.PI) / 180), 4);
    expect(p[o + 3] - p[o + 1]).toBeCloseTo(100 * Math.sin((240 * Math.PI) / 180), 4);
  });

  it("reports duplicated constraints as redundant, not as errors", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 1]);
      horizontal(a);
      horizontal(a);
    }, true);
    const scene = render();

    const rows = renderedByUniqueType(scene, 'constraint-horizontal');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => !r.hasError)).toBe(true);

    const payload = scene.getRenderedObject(scene.getSceneObjectById(rows[0].parentId)!).object;
    expect(payload.solver.redundant).toHaveLength(1);
  });

  it("rejects cross-sketch constraint references", () => {
    let foreign: any;
    sketch('xy', () => {
      foreign = line([0, 0], [50, 0]);
    }, true);
    sketch('xy', () => {
      const local = line([0, 10], [50, 10]);
      parallel(local, foreign);
    }, true);
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-parallel')[0];
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('another sketch');
  });

  it("keeps legacy sketches untouched: payload has no solver fields", () => {
    sketch('xy', () => {
      rect(100, 50);
    });
    const scene = render();

    const payload = scene.getRenderedObjects().find(r => r.uniqueType === 'sketch')!.object;
    expect(payload.solvedMode).toBeUndefined();
    expect(payload.solver).toBeUndefined();
    expect('currentPosition' in payload).toBe(true);
  });
});
