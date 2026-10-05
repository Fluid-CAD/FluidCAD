// End-to-end: the cut tools on a sketch whose literals are far from where
// the constraints put the geometry. The whole client pipeline runs on the
// real render — the solved model, the trim/split plan, the settle write-back
// — then the statement transform, then a re-render of what it wrote: every
// entity the cut did not touch must sit exactly where it sat before, and the
// pieces where the cut left them. Without the settle the re-solve starts
// from stale guesses mixed with solved cut points and the geometry jumps.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import * as core from '../../lib/core/index.js';
import * as constraints from '../../lib/core/constraints/index.js';
import type { Scene } from '../../lib/rendering/scene.js';
import { SketchEntitySplit } from '../../lib/features/2d/split.js';
import { SketchTrim } from '../src/sketch-trim.ts';
import { SketchSplit } from '../src/sketch-split.ts';
import { SketchEntityDelete } from '../src/sketch-entity-delete.ts';
import { buildSolvedSketchModel, type SolvedEntityView, type SolvedSketchModel } from '../../ui/src/sketch-solver-client/model';
import { buildSettleWriteBack } from '../../ui/src/sketch-solver-client/write-back';
import { buildTrimPlan } from '../../ui/src/interactive/tools/trim-plan';
import { buildSplitPlan } from '../../ui/src/interactive/tools/split-plan';
import type { SceneObjectRender } from '../../ui/src/types';

const FILE = '/w/plate.fluid.js';

// A rectangle drawn around (-16, 57) and a circle drawn there too, both
// constrained onto the origin: every literal is ~60 away from the solved
// position. Width, height and diameter stay free (DOF 3).
const SOURCE = [
  `import { sketch, circle, line, origin } from "fluidcad/core";`,
  `import { coincident, horizontal, vertical, midpoint } from "fluidcad/constraints";`,
  ``,
  `sketch('yz', () => {`,
  `  const c2 = circle([-16.27, 57.03], 61.24);`,
  `  const l5 = line([-62.54, 40], [30, 40]);`,
  `  const l6 = line([30, 40], [30, 74.06]);`,
  `  const l7 = line([30, 74.06], [-62.54, 74.06]);`,
  `  const l8 = line([-62.54, 74.06], [-62.54, 40]);`,
  `  coincident(l5.end(), l6.start());`,
  `  coincident(l6.end(), l7.start());`,
  `  coincident(l7.end(), l8.start());`,
  `  coincident(l8.end(), l5.start());`,
  `  horizontal(l5);`,
  `  horizontal(l7);`,
  `  vertical(l6);`,
  `  vertical(l8);`,
  `  midpoint(c2.center(), l5.start(), l7.start());`,
  `  coincident(c2.center(), origin());`,
  `});`,
].join('\n');
const SKETCH_LINE = 4;

/** Run a `.fluid.js` source against the lib API and render it. */
function evaluate(source: string): Scene {
  const body = source.split('\n').filter(l => !l.trimStart().startsWith('import ')).join('\n');
  const api: Record<string, unknown> = { ...core, ...constraints };
  const names = Object.keys(api);
  new Function(...names, body)(...names.map(n => api[n]));
  return render();
}

/** The UI's read model of the rendered sketch, its entities addressed by the source lines that bound them. */
function solvedModel(source: string): SolvedSketchModel {
  const scene = evaluate(source);
  const objects = scene.getRenderedObjects() as unknown as SceneObjectRender[];
  const sketchObj = objects.find(o => o.type === 'sketch');
  const model = sketchObj ? buildSolvedSketchModel(sketchObj, objects) : null;
  if (!model) {
    throw new Error('no solved sketch rendered');
  }
  // Statements ran from a Function body, so the payload's source locations
  // are not the file's: address each entity by the line binding its name,
  // in statement order.
  const lines = source.split('\n');
  const bindings = lines
    .map((text, i) => ({ line: i + 1, name: /^\s*const (\w+) = (line|arc|circle)\(/.exec(text)?.[1] }))
    .filter((b): b is { line: number; name: string } => b.name !== undefined);
  let i = 0;
  for (const view of model.entities.values()) {
    if (view.obj) {
      view.obj.sourceLocation = { filePath: FILE, line: bindings[i].line, column: 3 };
      view.obj.name = bindings[i].name;
      i += 1;
    }
  }
  expect(i).toBe(bindings.length);
  expect(model.outcome).toBe('solved');
  return model;
}

/** The entity the statement binding `name` draws. */
function byName(model: SolvedSketchModel, name: string): SolvedEntityView {
  const view = [...model.entities.values()].find(v => v.obj?.name === name);
  if (!view) {
    throw new Error(`no entity bound as ${name}`);
  }
  return view;
}

function geometry(view: SolvedEntityView): number[] {
  return [...(view.start ?? []), ...(view.end ?? []), ...(view.center ?? []), ...(view.radius !== undefined ? [view.radius] : [])];
}

/** Every entity of `before` (by binding name) but the cut one, compared coordinate by coordinate with `after`. */
function maxDrift(before: SolvedSketchModel, after: SolvedSketchModel, cut: string): number {
  let worst = 0;
  for (const view of before.entities.values()) {
    const name = view.obj!.name!;
    if (name === cut) {
      continue;
    }
    const a = geometry(view);
    const b = geometry(byName(after, name));
    expect(b).toHaveLength(a.length);
    a.forEach((v, i) => {
      worst = Math.max(worst, Math.abs(v - b[i]));
    });
  }
  return worst;
}

/** Positions written at 2dp put the re-solve within half a step of the old solution. */
const REST_TOL = 0.02;

describe('cutting a constrained sketch keeps its geometry at rest', () => {
  setupOC();

  it('solves the example onto the origin, far from its literals', () => {
    const model = solvedModel(SOURCE);
    const circle = byName(model, 'c2');
    expect(circle.center![0]).toBeCloseTo(0, 6);
    expect(circle.center![1]).toBeCloseTo(0, 6);
    const top = byName(model, 'l7');
    expect(top.start![1]).toBeCloseTo(17.03, 6);
    expect(Math.abs(top.start![0])).toBeCloseTo(46.27, 6);
  });

  it('trims the top edge between the circle crossings without moving anything else', async () => {
    const model = solvedModel(SOURCE);
    const top = byName(model, 'l7');
    const at: [number, number] = [0, top.start![1]];
    const plan = buildTrimPlan({ entityId: top.entityId, kind: 'line', sourceLocation: top.obj!.sourceLocation, at, shapeId: 's' }, model);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.request.cuts).toHaveLength(2);
    expect(plan.request.removed).toBe(1);
    const pieces = SketchEntitySplit.cut(plan.request.entity, plan.request.cuts);
    const settle = buildSettleWriteBack(model).edits;
    expect(settle.length).toBe(5);

    const result = await SketchTrim.apply(SOURCE, {
      sketchLine: SKETCH_LINE,
      line: plan.request.line,
      pieces,
      removed: plan.request.removed,
      cutters: plan.request.cutters,
      assignments: plan.request.hints.map(h => ({ line: h.line, piece: SketchEntitySplit.nearestPiece(pieces, h.locus) })),
      settle,
    });
    expect(result.error).toBeUndefined();
    // The second piece is named past the sketch's highest line (l8) — a
    // lower number nothing uses any more is never handed out again.
    expect(result.names).toEqual(['l7', 'l9']);
    // Each new end is pinned to the circle that cut it.
    expect(plan.request.cutters).toEqual([{ line: 5, featureType: 'circle' }, { line: 5, featureType: 'circle' }]);
    expect(result.newCode).toContain(`coincident(l7.end(), c2);`);
    expect(result.newCode).toContain(`coincident(l9.start(), c2);`);
    // The rewritten statements carry solved coordinates on both sides of the cut.
    expect(result.newCode).toContain(`const l7 = line([46.27, 17.03], [25.45, 17.03]);`);
    expect(result.newCode).toContain(`const l9 = line([-25.45, 17.03], [-46.27, 17.03]);`);
    expect(result.newCode).toContain(`const c2 = circle([0, 0], 61.24);`);

    getSceneManager()!.startScene();
    const after = solvedModel(result.newCode);
    expect(maxDrift(model, after, 'l7')).toBeLessThan(REST_TOL);
    const first = byName(after, 'l7');
    const second = byName(after, 'l9');
    expect(first.end![0]).toBeCloseTo(25.45, 2);
    expect(second.start![0]).toBeCloseTo(-25.45, 2);
    expect(second.end![0]).toBeCloseTo(-46.27, 2);

    // Trimming the circle next finds the pieces' pinned ends as crossings
    // (T-junctions, so the ends themselves are named), on both sides.
    const circle = byName(after, 'c2');
    const again = buildTrimPlan(
      { entityId: circle.entityId, kind: 'circle', sourceLocation: circle.obj!.sourceLocation, at: [0, circle.radius!], shapeId: 's' },
      after,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) {
      return;
    }
    expect(again.request.cuts).toHaveLength(2);
    expect(again.request.cuts[0][0]).toBeCloseTo(25.45, 2);
    expect(again.request.cuts[1][0]).toBeCloseTo(-25.45, 2);
    expect(again.request.cutters.map(c => c?.role)).toEqual(['end', 'start']);
    const arcResult = await SketchTrim.apply(result.newCode, {
      sketchLine: SKETCH_LINE,
      line: again.request.line,
      pieces: SketchEntitySplit.cut(again.request.entity, again.request.cuts),
      removed: again.request.removed,
      cutters: again.request.cutters,
      settle: buildSettleWriteBack(after).edits,
    });
    expect(arcResult.error).toBeUndefined();
    expect(arcResult.newCode).toMatch(/const c2 = arc\(\[-25\.45, 17\.03\], \[25\.45, 17\.03\], \[0, 0\]\);/);
    expect(arcResult.newCode).toContain(`coincident(c2.start(), l9.start());`);
    expect(arcResult.newCode).toContain(`coincident(c2.end(), l7.end());`);
    // The first trim's point-on-circle pins are superseded, not reported.
    expect(arcResult.newCode).not.toContain(`coincident(l7.end(), c2);`);
    expect(arcResult.newCode).not.toContain(`coincident(l9.start(), c2);`);
    expect(arcResult.removed).toBeUndefined();
  });

  it('trims the circle above the top edge into an arc without moving the rectangle', async () => {
    const model = solvedModel(SOURCE);
    const circle = byName(model, 'c2');
    const at: [number, number] = [0, circle.radius!];
    const plan = buildTrimPlan({ entityId: circle.entityId, kind: 'circle', sourceLocation: circle.obj!.sourceLocation, at, shapeId: 's' }, model);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const pieces = SketchEntitySplit.cut(plan.request.entity, plan.request.cuts);
    const result = await SketchTrim.apply(SOURCE, {
      sketchLine: SKETCH_LINE,
      line: plan.request.line,
      pieces,
      removed: plan.request.removed,
      settle: buildSettleWriteBack(model).edits,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toMatch(/const c2 = arc\(\[-25\.45, 17\.03\], \[25\.45, 17\.03\], \[0, 0\]\);/);

    getSceneManager()!.startScene();
    const after = solvedModel(result.newCode);
    expect(maxDrift(model, after, 'c2')).toBeLessThan(REST_TOL);
    const arc = byName(after, 'c2');
    expect(arc.center![0]).toBeCloseTo(0, 2);
    expect(arc.center![1]).toBeCloseTo(0, 2);
    expect(arc.radius!).toBeCloseTo(30.62, 2);
  });

  it('splits the top edge at its midpoint without moving anything else', async () => {
    const model = solvedModel(SOURCE);
    const top = byName(model, 'l7');
    const plan = buildSplitPlan({ entityId: top.entityId, kind: 'line', sourceLocation: top.obj!.sourceLocation, at: [0.3, 18], shapeId: 's' }, model, 1);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    const { pieces } = SketchEntitySplit.split(plan.request.entity, plan.request.at);
    const result = await SketchSplit.apply(SOURCE, {
      sketchLine: SKETCH_LINE,
      line: plan.request.line,
      pieces,
      settle: buildSettleWriteBack(model).edits,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l7 = line([46.27, 17.03], [0, 17.03]);`);

    getSceneManager()!.startScene();
    const after = solvedModel(result.newCode);
    expect(maxDrift(model, after, 'l7')).toBeLessThan(REST_TOL);
    expect(byName(after, 'l9').end![0]).toBeCloseTo(-46.27, 2);
  });

  it('would let the geometry jump without the settle', async () => {
    const model = solvedModel(SOURCE);
    const top = byName(model, 'l7');
    const plan = buildTrimPlan({ entityId: top.entityId, kind: 'line', sourceLocation: top.obj!.sourceLocation, at: [0, top.start![1]], shapeId: 's' }, model);
    if (!plan.ok) {
      throw new Error(plan.reason);
    }
    const pieces = SketchEntitySplit.cut(plan.request.entity, plan.request.cuts);
    const result = await SketchTrim.apply(SOURCE, {
      sketchLine: SKETCH_LINE, line: plan.request.line, pieces, removed: plan.request.removed,
    });
    expect(result.error).toBeUndefined();
    getSceneManager()!.startScene();
    const after = solvedModel(result.newCode);
    expect(maxDrift(model, after, 'l7')).toBeGreaterThan(1);
  });

  it('deletes the top edge with its constraints without moving anything else — and would not without the settle', async () => {
    const model = solvedModel(SOURCE);
    const top = byName(model, 'l7');
    const settled = await SketchEntityDelete.apply(SOURCE, {
      sketchLine: SKETCH_LINE,
      lines: [top.obj!.sourceLocation!.line],
      settle: buildSettleWriteBack(model).edits,
    });
    expect(settled.error).toBeUndefined();
    expect(settled.dependents).toBeUndefined();
    expect(settled.removed).toEqual([
      { line: 11, kind: 'coincident' },
      { line: 12, kind: 'coincident' },
      { line: 15, kind: 'horizontal' },
      { line: 18, kind: 'midpoint' },
    ]);
    expect(settled.newCode).not.toContain('l7');
    // The survivors carry their solved coordinates: the midpoint constraint
    // that placed the rectangle went with the edge, and the literals now
    // hold it there on their own.
    expect(settled.newCode).toContain(`const l5 = line([-46.27, -17.03], [46.27, -17.03]);`);
    expect(settled.newCode).toContain(`const c2 = circle([0, 0], 61.24);`);

    getSceneManager()!.startScene();
    const after = solvedModel(settled.newCode);
    expect(maxDrift(model, after, 'l7')).toBeLessThan(REST_TOL);
    expect(after.entities.size).toBe(model.entities.size - 1);

    const unsettled = await SketchEntityDelete.apply(SOURCE, { sketchLine: SKETCH_LINE, lines: [top.obj!.sourceLocation!.line] });
    expect(unsettled.error).toBeUndefined();
    getSceneManager()!.startScene();
    const jumped = solvedModel(unsettled.newCode);
    expect(maxDrift(model, jumped, 'l7')).toBeGreaterThan(1);
  });
});
