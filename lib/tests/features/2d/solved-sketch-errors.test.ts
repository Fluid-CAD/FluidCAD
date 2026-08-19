import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import sketch from "../../../core/sketch.js";
import { line, circle, rect, hLine, tArc, point } from "../../../core/2d/index.js";
import {
  coincident, horizontal, fix, distance, parallel,
} from "../../../core/constraints/index.js";
import { Scene } from "../../../rendering/scene.js";

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
