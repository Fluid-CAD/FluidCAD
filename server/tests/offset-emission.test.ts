// End-to-end constrained offset (the Offset tool's emission): a plan as the
// kernel's OCCT pass describes it → the UI builder's primitives + offsetFrom +
// corner coincidents → the solved-emission transform → EXECUTED against the
// real runtime. The solve must land with zero DOF and no redundancy for the
// three junction cases the plan distinguishes: sharp corners, tangent
// junctions and open ends with caps.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import * as core from '../../lib/core/index.js';
import * as constraints from '../../lib/core/constraints/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { applySolvedEmission, type SolvedEmissionSpec } from '../src/sketch-solved-edit/index.ts';
import { buildOffsetEmission } from '../../ui/src/interactive/tools/offset-emission.ts';
import type { SketchOffsetPlanChain } from '../../ui/src/api.ts';
import type { SolvedPick } from '../../ui/src/interactive/sketch-hover-select-handler.ts';
import type { SolvedEntityView, SolvedSketchModel } from '../../ui/src/sketch-solver-client/model.ts';

const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

function runFluid(source: string): Scene {
  getSceneManager()!.startScene();
  const globals: Record<string, unknown> = { ...core, ...constraints, ...filters, ...math };
  const names = Object.keys(globals);
  const values = names.map(n => globals[n]);
  const fn = new Function(...names, `"use strict";\n${source.replace(IMPORT_LINE_RE, '')}`);
  fn(...values);
  return render();
}

type V2 = [number, number];

function pick(entityId: number, line: number, kind: 'line' | 'arc', start: V2, end: V2): { pick: SolvedPick; view: SolvedEntityView } {
  const sourceLocation = { filePath: '/w/p.fluid.js', line, column: 3 };
  return {
    pick: { entityId, kind, shapeId: `s${entityId}`, sourceLocation },
    view: { entityId, kind, start, end, obj: { sourceLocation } } as unknown as SolvedEntityView,
  };
}

async function emitAndSolve(source: string, sketchLine: number, sources: { pick: SolvedPick; view: SolvedEntityView }[], chains: SketchOffsetPlanChain[], distanceExpr: string) {
  const model = { entities: new Map(sources.map(s => [s.view.entityId, s.view])), constraints: [] } as unknown as SolvedSketchModel;
  const emission = buildOffsetEmission({ sources: sources.map(s => s.pick), chains, model, distanceExpr });
  expect(emission.ok, emission.ok ? '' : emission.reason).toBe(true);
  if (!emission.ok) {
    throw new Error(emission.reason);
  }
  const spec: SolvedEmissionSpec = { sketchLine, geometry: emission.request.geometry, constraints: emission.request.constraints };
  const edited = await applySolvedEmission(source, spec);
  expect(edited.error).toBeUndefined();
  const scene = runFluid(edited.newCode);
  const errors = scene.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
  expect(errors).toEqual([]);
  const payload = scene.getRenderedObjects().find(r => r.type === 'sketch')!.object;
  expect(payload.solvedMode).toBe(true);
  return Object.assign(payload.solver, { newCode: edited.newCode as string });
}

describe('constrained offset emissions solve clean', () => {
  setupOC();

  it('closed square with sharp corners: DOF 0, no diagnostics', async () => {
    const source = [
      `import { sketch, line } from "fluidcad/core";`,
      `import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [40, 0]);`,
      `  const b = line([40, 0], [40, 30]);`,
      `  const c = line([40, 30], [0, 30]);`,
      `  const d = line([0, 30], [0, 0]);`,
      `  coincident(a.end(), b.start());`,
      `  coincident(b.end(), c.start());`,
      `  coincident(c.end(), d.start());`,
      `  coincident(d.end(), a.start());`,
      `  fix(a.start(), [0, 0]);`,
      `  horizontal(a);`,
      `  vertical(b);`,
      `  horizontal(c);`,
      `  vertical(d);`,
      `  distance(a.start(), a.end(), 40);`,
      `  distance(b.start(), b.end(), 30);`,
      `});`,
    ].join('\n');
    const sources = [
      pick(0, 5, 'line', [0, 0], [40, 0]),
      pick(1, 6, 'line', [40, 0], [40, 30]),
      pick(2, 7, 'line', [40, 30], [0, 30]),
      pick(3, 8, 'line', [0, 30], [0, 0]),
    ];
    // Guesses a little off the true rails on purpose.
    const chains: SketchOffsetPlanChain[] = [{
      closed: true,
      edges: [
        { kind: 'line', source: 0, start: [-2.7, -3.2], end: [43.3, -2.8], joinNext: 'corner' },
        { kind: 'line', source: 1, start: [43.3, -2.8], end: [42.8, 33.2], joinNext: 'corner' },
        { kind: 'line', source: 2, start: [42.8, 33.2], end: [-3.2, 32.7], joinNext: 'corner' },
        { kind: 'line', source: 3, start: [-3.2, 32.7], end: [-2.7, -3.2], joinNext: 'corner' },
      ],
    }];
    const solver = await emitAndSolve(source, 4, sources, chains, '3');
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    expect(solver.newCode).toContain('offsetFrom([l1, l2, l3, l4], [a, b, c, d], 3);');
  });

  it('open chain with caps and a tangent junction: DOF 0, no diagnostics', async () => {
    const source = [
      `import { sketch, line, arc } from "fluidcad/core";`,
      `import { coincident, horizontal, fix, distance, tangent } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [30, 0]);`,
      `  const b = arc([30, 0], [40, 10], [30, 10]);`,
      `  coincident(a.end(), b.start());`,
      `  tangent(a, b);`,
      `  fix(a.start(), [0, 0]);`,
      `  horizontal(a);`,
      `  distance(a.start(), a.end(), 30);`,
      `  fix(b.end(), [40, 10]);`,
      `});`,
    ].join('\n');
    const sources = [
      pick(0, 5, 'line', [0, 0], [30, 0]),
      pick(1, 6, 'arc', [30, 0], [40, 10]),
    ];
    // Outward (below the line, outside the arc) by 3, guesses nudged.
    const chains: SketchOffsetPlanChain[] = [{
      closed: false,
      edges: [
        { kind: 'line', source: 0, start: [0.2, -3.1], end: [29.8, -2.9], joinNext: 'tangent' },
        { kind: 'arc', source: 1, start: [30.1, -3.2], end: [43.2, 9.8], center: [29.9, 10.1], radius: 13, cw: false, joinNext: null },
      ],
      caps: [
        { start: [40, 10], end: [43, 10] },
        { start: [0, -3], end: [0, 0] },
      ],
    }];
    const solver = await emitAndSolve(source, 4, sources, chains, '3');
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    expect(solver.newCode).toContain('offsetFrom([l1, a1], [a, b], 3);');
    expect(solver.newCode).toContain('coincident(l2.start(), b.end());');
    expect(solver.newCode).toContain('coincident(l3.end(), a.start());');
  });
});
