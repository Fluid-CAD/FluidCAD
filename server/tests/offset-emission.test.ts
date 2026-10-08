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
import type { SketchPositionEdit } from '../src/code-editor/index.ts';
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

async function emitAndSolve(source: string, sketchLine: number, sources: { pick: SolvedPick; view: SolvedEntityView }[], chains: SketchOffsetPlanChain[], distanceExpr: string, settle?: SketchPositionEdit[]) {
  const model = { entities: new Map(sources.map(s => [s.view.entityId, s.view])), constraints: [] } as unknown as SolvedSketchModel;
  const emission = buildOffsetEmission({ sources: sources.map(s => s.pick), chains, model, distanceExpr });
  expect(emission.ok, emission.ok ? '' : emission.reason).toBe(true);
  if (!emission.ok) {
    throw new Error(emission.reason);
  }
  const spec: SolvedEmissionSpec = {
    sketchLine, geometry: emission.request.geometry, constraints: emission.request.constraints,
    ...(settle ? { settle } : {}),
  };
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

  it('settles stale source literals first so the side lock reads the solved sketch', async () => {
    // The rectangle was drawn around y = 300 and later dimensioned down to
    // the origin: its literals are stale guesses, its solved rails run
    // y = 0 and y = 50. The offset plan (built on the SOLVED sketch) puts
    // the inward offset of the bottom edge at y = 5 — ABOVE the solved
    // edge but far BELOW the stale literal, so without settling the sketch
    // first the offsetFrom side lock reads the bottom offset as outward and
    // the solve lands it at y = -5 while the other three edges go inward.
    const source = [
      `import { sketch, line } from "fluidcad/core";`,
      `import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 300], [100, 300]);`,
      `  const b = line([100, 300], [100, 350]);`,
      `  const c = line([100, 350], [0, 350]);`,
      `  const d = line([0, 350], [0, 300]);`,
      `  coincident(a.end(), b.start());`,
      `  coincident(b.end(), c.start());`,
      `  coincident(c.end(), d.start());`,
      `  coincident(d.end(), a.start());`,
      `  fix(a.start(), [0, 0]);`,
      `  horizontal(a);`,
      `  vertical(b);`,
      `  horizontal(c);`,
      `  vertical(d);`,
      `  distance(a.start(), a.end(), 100);`,
      `  distance(b.start(), b.end(), 50);`,
      `});`,
    ].join('\n');
    const sources = [
      pick(0, 5, 'line', [0, 0], [100, 0]),
      pick(1, 6, 'line', [100, 0], [100, 50]),
      pick(2, 7, 'line', [100, 50], [0, 50]),
      pick(3, 8, 'line', [0, 50], [0, 0]),
    ];
    const chains: SketchOffsetPlanChain[] = [{
      closed: true,
      edges: [
        { kind: 'line', source: 0, start: [5, 5], end: [95, 5], joinNext: 'corner' },
        { kind: 'line', source: 1, start: [95, 5], end: [95, 45], joinNext: 'corner' },
        { kind: 'line', source: 2, start: [95, 45], end: [5, 45], joinNext: 'corner' },
        { kind: 'line', source: 3, start: [5, 45], end: [5, 5], joinNext: 'corner' },
      ],
    }];
    // The settle write-back the dialog sends: every drifted literal of the
    // four source lines, on its solved position.
    const settle: SketchPositionEdit[] = [
      { sourceLine: 5, points: [
        { pointIndex: 0, position: [0, 0], expected: [0, 300] },
        { pointIndex: 1, position: [100, 0], expected: [100, 300] },
      ] },
      { sourceLine: 6, points: [
        { pointIndex: 0, position: [100, 0], expected: [100, 300] },
        { pointIndex: 1, position: [100, 50], expected: [100, 350] },
      ] },
      { sourceLine: 7, points: [
        { pointIndex: 0, position: [100, 50], expected: [100, 350] },
        { pointIndex: 1, position: [0, 50], expected: [0, 350] },
      ] },
      { sourceLine: 8, points: [
        { pointIndex: 0, position: [0, 50], expected: [0, 350] },
        { pointIndex: 1, position: [0, 0], expected: [0, 300] },
      ] },
    ];
    const solver = await emitAndSolve(source, 4, sources, chains, '5', settle);
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(0);
    expect(solver.newCode).toContain('const a = line([0, 0], [100, 0]);');
    expect(solver.newCode).toContain('const c = line([100, 50], [0, 50]);');
    expect(solver.newCode).toContain('offsetFrom([l1, l2, l3, l4], [a, b, c, d], 5);');
    // Every offset line solved on the inside of the rectangle.
    const lineAt = (id: number): number[] => {
      const entity = solver.entities.find((e: { id: number }) => e.id === id)!;
      return solver.params.slice(entity.paramOffset, entity.paramOffset + 4).map((v: number) => Math.round(v * 1000) / 1000);
    };
    expect(lineAt(4)).toEqual([5, 5, 95, 5]);
    expect(lineAt(5)).toEqual([95, 5, 95, 45]);
    expect(lineAt(6)).toEqual([95, 45, 5, 45]);
    expect(lineAt(7)).toEqual([5, 45, 5, 5]);
  });
});
