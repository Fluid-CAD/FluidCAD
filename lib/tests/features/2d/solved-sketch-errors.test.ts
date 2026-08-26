import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import sketch from "../../../core/sketch.js";
import { line, circle, arc, ellipse, point } from "../../../core/2d/index.js";
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

  it("throws on removed legacy arities with migration hints", () => {
    // The pen-form factories are gone entirely (P7); the surviving factories
    // refuse legacy arities at statement time with the old rejection hints.
    expect(() => sketch('xy', () => { (line as any)([60, 0]); }))
      .toThrow(/line\(start, end\)/);
    expect(() => sketch('xy', () => { (arc as any)([60, 20]); }))
      .toThrow(/arc\(start, end, center\)/);
    expect(() => sketch('xy', () => { (ellipse as any)(20, 10); }))
      .toThrow(/explicit center/);
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
    });
    const scene = render();

    const dims = renderedByUniqueType(scene, 'constraint-distance');
    expect(dims).toHaveLength(2);
    for (const dim of dims) {
      expect(dim.hasError).toBe(true);
      expect(dim.errorMessage).toContain('circle or arc target');
    }
  });

  it("throws on the center-less circle form", () => {
    expect(() => sketch('xy', () => { (circle as any)(40); }))
      .toThrow(/explicit center/);
  });

  it("solves constraints in a sketch without the mode flag — every sketch is solved", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      const b = line([0, 10], [50, 10]);
      parallel(a, b);
      point([5, 5]);
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-parallel')[0];
    expect(row.hasError).toBe(false);
    const pt = renderedByUniqueType(scene, 'solved-point')[0];
    expect(pt.hasError).toBe(false);
  });

  it("marks contradictory dimensions conflicting while geometry still renders", () => {
    sketch('xy', () => {
      const a = line([0, 0], [50, 0]);
      fix(a.start());
      horizontal(a);
      distance(a.start(), a.end(), 50);
      distance(a.start(), a.end(), 80);
    });
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
    });
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
    // Datums (negative ids) lead the entity list; statements follow.
    const l3Entity = payload.solver.entities.filter((e: any) => e.id >= 0)[2];
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
    });
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
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-angle')[0];
    expect(row.hasError).toBe(false);

    const payload = scene.getRenderedObject(scene.getSceneObjectById(row.parentId)!).object;
    const record = payload.solver.constraints.find((c: any) => c.spec.kind === 'angle');
    expect(record.spec.b.point).toBe('start');
    expect(record.spec.value).toBeCloseTo(Math.PI / 3, 10);

    const bEntity = payload.solver.entities.filter((e: any) => e.id >= 0)[1];
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
    });
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
    });
    sketch('xy', () => {
      const local = line([0, 10], [50, 10]);
      parallel(local, foreign);
    });
    const scene = render();

    const row = renderedByUniqueType(scene, 'constraint-parallel')[0];
    expect(row.hasError).toBe(true);
    expect(row.errorMessage).toContain('another sketch');
  });

  it("every sketch payload carries solver fields and no pen fields", () => {
    sketch('xy', () => {
      line([0, 0], [100, 0]);
    });
    const scene = render();

    const payload = scene.getRenderedObjects().find(r => r.uniqueType === 'sketch')!.object;
    expect(payload.solvedMode).toBe(true);
    expect(payload.solver).toBeTruthy();
    expect('currentPosition' in payload).toBe(false);
    expect('currentTangent' in payload).toBe(false);
  });
});
