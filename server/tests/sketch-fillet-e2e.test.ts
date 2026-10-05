// End-to-end: the Fillet tool on rectangles held in place three ways — a
// corner on the y axis, a centre on the origin, a corner on the origin with
// typed width and height (drawn at the wrong size, so every literal is a
// stale guess). The whole client pipeline runs on the real render — the
// solved model, the fillet plan, the settle write-back — then the statement
// transform, then a re-render of what it wrote: every straight edge must
// stay on the line it sat on, so the rectangle keeps its size and place.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import * as core from '../../lib/core/index.js';
import * as constraints from '../../lib/core/constraints/index.js';
import type { Scene } from '../../lib/rendering/scene.js';
import { SketchFillet } from '../src/sketch-fillet.ts';
import { buildSolvedSketchModel, type SolvedEntityView, type SolvedSketchModel } from '../../ui/src/sketch-solver-client/model';
import { buildSettleWriteBack } from '../../ui/src/sketch-solver-client/write-back';
import { buildFilletPlan } from '../../ui/src/interactive/tools/fillet-plan';
import type { SolvedPick } from '../../ui/src/interactive/sketch-hover-select-handler';
import type { SceneObjectRender } from '../../ui/src/types';

const FILE = '/w/plate.fluid.js';
const SKETCH_LINE = 4;

const sketchSource = (...body: string[]): string => [
  `import { sketch, line, arc, point, origin, yAxis } from "fluidcad/core";`,
  `import { coincident, horizontal, vertical, midpoint, distance, tangent, radius, equal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  ...body.map(l => `  ${l}`),
  `});`,
].join('\n');

/** The rectangle recipe the Rectangle tool emits for lines `names` (bottom, right, top, left). */
const rectRecipe = (names: string[]): string[] => [
  `coincident(${names[0]}.end(), ${names[1]}.start());`,
  `coincident(${names[1]}.end(), ${names[2]}.start());`,
  `coincident(${names[2]}.end(), ${names[3]}.start());`,
  `coincident(${names[3]}.end(), ${names[0]}.start());`,
  `horizontal(${names[0]});`,
  `horizontal(${names[2]});`,
  `vertical(${names[1]});`,
  `vertical(${names[3]});`,
];

// The user's sketch: a centered rectangle on the origin and a corner
// rectangle whose bottom-left corner sits on the y axis. Neither has a size
// dimension — the guesses alone keep them where they were drawn.
const USER_SOURCE = sketchSource(
  `const l1 = line([-73.83, -36.99], [73.83, -36.99]);`,
  `const l2 = line([73.83, -36.99], [73.83, 36.99]);`,
  `const l3 = line([73.83, 36.99], [-73.83, 36.99]);`,
  `const l4 = line([-73.83, 36.99], [-73.83, -36.99]);`,
  `const l5 = line([0, 99.82], [200, 99.82]);`,
  `const l6 = line([200, 99.82], [200, 200]);`,
  `const l7 = line([200, 200], [0, 200]);`,
  `const l8 = line([0, 200], [0, 99.82]);`,
  ...rectRecipe(['l1', 'l2', 'l3', 'l4']),
  `midpoint(origin(), l1.start(), l3.start());`,
  ...rectRecipe(['l5', 'l6', 'l7', 'l8']),
  `coincident(l5.start(), yAxis());`,
);

// Drawn 80 × 40 at (3, 4); the constraints say 100 × 50 from the origin.
const DIMENSIONED_SOURCE = sketchSource(
  `const l1 = line([3, 4], [83, 4]);`,
  `const l2 = line([83, 4], [83, 44]);`,
  `const l3 = line([83, 44], [3, 44]);`,
  `const l4 = line([3, 44], [3, 4]);`,
  ...rectRecipe(['l1', 'l2', 'l3', 'l4']),
  `coincident(l1.start(), origin());`,
  `distance(l1.start(), l1.end(), 100);`,
  `distance(l2.start(), l2.end(), 50);`,
);

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
  getSceneManager()!.startScene();
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
    .map((text, i) => ({ line: i + 1, name: /^\s*const (\w+) = (line|arc|point)\(/.exec(text)?.[1] }))
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

function byName(model: SolvedSketchModel, name: string): SolvedEntityView {
  const view = [...model.entities.values()].find(v => v.obj?.name === name);
  if (!view) {
    throw new Error(`no entity bound as ${name}`);
  }
  return view;
}

function edgePick(view: SolvedEntityView): SolvedPick {
  return { entityId: view.entityId, kind: view.kind as 'line', sourceLocation: view.obj!.sourceLocation };
}

/** Where a rectangle's sides run: the bottom/top y and the right/left x. */
function sides(model: SolvedSketchModel, names: string[]): number[] {
  const [b, r, t, l] = names.map(n => byName(model, n));
  return [b.start![1], r.start![0], t.start![1], l.start![0]];
}

/** Fillet every corner of the rectangle `names` the way the UI does, and re-render. */
async function filletRectangle(source: string, names: string[], r: number): Promise<{ code: string; after: SolvedSketchModel }> {
  const model = solvedModel(source);
  const plan = buildFilletPlan({
    picks: names.map(n => edgePick(byName(model, n))),
    model,
    radius: r,
    radiusExpr: String(r),
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(plan.reason);
  }
  expect(plan.corners).toBe(4);
  const result = await SketchFillet.apply(source, {
    sketchLine: SKETCH_LINE,
    ...plan.request,
    settle: buildSettleWriteBack(model).edits,
  });
  expect(result.error).toBeUndefined();
  return { code: result.newCode, after: solvedModel(result.newCode) };
}

/** Positions written at 2dp put the re-solve within half a step of the old solution. */
const REST_TOL = 0.02;

describe('filleting a rectangle keeps its size and place', () => {
  setupOC();

  it('a corner rectangle on the y axis keeps its corner on the axis and its sides where they were', async () => {
    const before = solvedModel(USER_SOURCE);
    const { code, after } = await filletRectangle(USER_SOURCE, ['l5', 'l6', 'l7', 'l8'], 10);
    // The axis pin follows the corner, not the bottom edge's tangent point.
    expect(code).toContain(`coincident(p1, yAxis());`);
    expect(code).not.toContain(`coincident(l5.start(), yAxis());`);
    sides(after, ['l5', 'l6', 'l7', 'l8']).forEach((v, i) => {
      expect(Math.abs(v - sides(before, ['l5', 'l6', 'l7', 'l8'])[i])).toBeLessThan(REST_TOL);
    });
    expect(sides(after, ['l5', 'l6', 'l7', 'l8'])).toEqual([
      expect.closeTo(99.82, 2), expect.closeTo(200, 2), expect.closeTo(200, 2), expect.closeTo(0, 2),
    ]);
    // The other rectangle never moved either.
    sides(after, ['l1', 'l2', 'l3', 'l4']).forEach((v, i) => {
      expect(Math.abs(v - sides(before, ['l1', 'l2', 'l3', 'l4'])[i])).toBeLessThan(REST_TOL);
    });
    // The bottom edge is trimmed by the radius at both ends.
    const bottom = byName(after, 'l5');
    expect(bottom.start![0]).toBeCloseTo(10, 2);
    expect(bottom.end![0]).toBeCloseTo(190, 2);
    for (const name of ['a1', 'a2', 'a3', 'a4']) {
      expect(byName(after, name).radius!).toBeCloseTo(10, 6);
    }
  });

  it('a centered rectangle keeps its size, its centre on the origin through two sharps', async () => {
    const before = solvedModel(USER_SOURCE);
    const { code, after } = await filletRectangle(USER_SOURCE, ['l1', 'l2', 'l3', 'l4'], 10);
    expect(code).toMatch(/midpoint\(origin\(\), p\d, p\d\);/);
    sides(after, ['l1', 'l2', 'l3', 'l4']).forEach((v, i) => {
      expect(Math.abs(v - sides(before, ['l1', 'l2', 'l3', 'l4'])[i])).toBeLessThan(REST_TOL);
    });
    expect(sides(after, ['l1', 'l2', 'l3', 'l4'])).toEqual([
      expect.closeTo(-36.99, 2), expect.closeTo(73.83, 2), expect.closeTo(36.99, 2), expect.closeTo(-73.83, 2),
    ]);
  });

  it('a dimensioned rectangle keeps measuring corner to corner, from stale literals', async () => {
    const before = solvedModel(DIMENSIONED_SOURCE);
    expect(sides(before, ['l1', 'l2', 'l3', 'l4'])).toEqual([
      expect.closeTo(0, 6), expect.closeTo(100, 6), expect.closeTo(50, 6), expect.closeTo(0, 6),
    ]);
    const { code, after } = await filletRectangle(DIMENSIONED_SOURCE, ['l1', 'l2', 'l3', 'l4'], 5);
    expect(code).toMatch(/distance\(p\d, p\d, 100\);/);
    expect(code).toMatch(/distance\(p\d, p\d, 50\);/);
    expect(sides(after, ['l1', 'l2', 'l3', 'l4'])).toEqual([
      expect.closeTo(0, 2), expect.closeTo(100, 2), expect.closeTo(50, 2), expect.closeTo(0, 2),
    ]);
    const bottom = byName(after, 'l1');
    expect(bottom.start![0]).toBeCloseTo(5, 2);
    expect(bottom.end![0]).toBeCloseTo(95, 2);
  });
});
