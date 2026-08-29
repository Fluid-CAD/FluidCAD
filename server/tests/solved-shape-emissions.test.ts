// End-to-end shape-gesture emissions (sketch-rewrite P5): build each shape
// tool's emission with the UI's shared builders, insert it through the
// solved-emission transform, then EXECUTE the edited code against the real
// runtime — the solve must succeed with zero conflicts/redundancy and the
// shape's own free DOF. This is what proves the constraint recipes are
// neither under- nor over-specified.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import * as core from '../../lib/core/index.js';
import * as constraints from '../../lib/core/constraints/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { applySolvedEmission, type SolvedEmissionSpec } from '../src/sketch-solved-edit.ts';
import {
  rectEmission,
  roundedRectEmission,
  slotEmission,
  polygonEmission,
  type SolvedEmissionRequest,
} from '../../ui/src/interactive/tools/solved-emission.ts';

const BASE = [
  `import { sketch } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `});`,
].join('\n');

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

async function emitAndSolve(request: SolvedEmissionRequest) {
  const spec: SolvedEmissionSpec = {
    sketchLine: 3,
    geometry: request.geometry,
    constraints: request.constraints,
  };
  const edited = await applySolvedEmission(BASE, spec);
  expect(edited.error).toBeUndefined();
  const scene = runFluid(edited.newCode);
  const errors = scene.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
  expect(errors).toEqual([]);
  const payload = scene.getRenderedObjects().find(r => r.type === 'sketch')!.object;
  expect(payload.solvedMode).toBe(true);
  return payload.solver;
}

describe('shape-gesture emissions solve clean', () => {
  setupOC();

  it('rect: solved, no diagnostics, DOF 4 (position + w + h)', async () => {
    const solver = await emitAndSolve(rectEmission({ corner: [0, 0], w: 40, h: 30 }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(4);
  });

  it('rect with typed dims: DOF 2 (position only)', async () => {
    const solver = await emitAndSolve(rectEmission({
      corner: [0, 0], w: 40, h: 30, widthDim: '40', heightDim: '30',
    }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(2);
  });

  it('rounded rect: solved, no diagnostics, DOF 5 (position + w + h + r)', async () => {
    const solver = await emitAndSolve(roundedRectEmission({
      corner: [0, 0], w: 40, h: 30, radius: 5,
    }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(5);
  });

  it('rounded rect with typed dims: DOF 2', async () => {
    const solver = await emitAndSolve(roundedRectEmission({
      corner: [0, 0], w: 40, h: 30, radius: 5,
      widthDim: '40', heightDim: '30', radiusDim: '5',
    }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(2);
  });

  it('slot: solved, no diagnostics, DOF 5 (position + angle + length + r)', async () => {
    const solver = await emitAndSolve(slotEmission({ p0: [0, 0], p1: [50, 0], radius: 10 }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(5);
  });

  it('slot with typed dims: DOF 3', async () => {
    const solver = await emitAndSolve(slotEmission({
      p0: [0, 0], p1: [50, 0], radius: 10, lengthDim: '50', radiusDim: '10',
    }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(3);
  });

  // The guide-circle polygon's even-n case is the Pitot trap: all-tangent +
  // full-equal would solve at DOF 5 with a redundant tangent row, so the
  // recipe swaps one equality for one corner angle — both parities must land
  // on the same clean DOF 4 (position + rotation + size).
  it('hexagon (circumscribed, even n): solved, no diagnostics, DOF 4', async () => {
    const solver = await emitAndSolve(polygonEmission({ center: [0, 0], diameter: 20, sides: 6, mode: 'circumscribed' }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(4);
  });

  it('pentagon (circumscribed, odd n): solved, no diagnostics, DOF 4', async () => {
    const solver = await emitAndSolve(polygonEmission({ center: [0, 0], diameter: 20, sides: 5, mode: 'circumscribed' }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(4);
  });

  it('hexagon (inscribed): solved, no diagnostics, DOF 4', async () => {
    const solver = await emitAndSolve(polygonEmission({ center: [0, 0], diameter: 20, sides: 6, mode: 'inscribed' }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(4);
  });

  it('polyline chain: successive emissions reference the previous segment by line', async () => {
    // Segment 1: a horizontal bottom edge (the polyline line mode's shape).
    const first = await applySolvedEmission(BASE, {
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([0, 0], [60, 0])' }],
      constraints: [{ kind: 'horizontal', targets: [{ newIndex: 0 }] }],
    });
    expect(first.error).toBeUndefined();
    expect(first.geometryLines).toHaveLength(1);
    // The horizontal() needed a new fluidcad/constraints import ABOVE the
    // sketch — the result reports where the sketch statement moved to, and
    // the chained follow-up MUST use it (the P5 stale-sketchLine trap).
    expect(first.sketchLine).toBe(4);

    // Segment 2: chained by junction coincident onto segment 1 (by LINE, the
    // route's geometryLines — the previous statement is unbound, so this
    // hoists it), plus its own vertical.
    const second = await applySolvedEmission(first.newCode, {
      sketchLine: first.sketchLine!,
      geometry: [{ kind: 'line', text: 'line([60, 0], [60, 40])' }],
      constraints: [
        {
          kind: 'coincident',
          targets: [
            { newIndex: 0, role: 'start' },
            { line: first.geometryLines![0], role: 'end', featureType: 'line' },
          ],
        },
        { kind: 'vertical', targets: [{ newIndex: 0 }] },
      ],
    });
    expect(second.error).toBeUndefined();
    // Layout convention: the new geometry sits ABOVE the first segment's
    // horizontal() even though it was emitted later.
    const lines = second.newCode.split('\n');
    const geomIdx = lines.findIndex(l => l.includes('line([60, 0], [60, 40])'));
    const horizIdx = lines.findIndex(l => l.includes('horizontal('));
    expect(geomIdx).toBeGreaterThan(0);
    expect(geomIdx).toBeLessThan(horizIdx);

    const scene = runFluid(second.newCode);
    const errors = scene.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
    expect(errors).toEqual([]);
    const solver = scene.getRenderedObjects().find(r => r.type === 'sketch')!.object.solver;
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    // 2 lines (8 params) − horizontal − vertical − coincident(2) = 4 DOF.
    expect(solver.dof).toBe(4);
  });

  it('hexagon with a typed ⌀: DOF 3', async () => {
    const solver = await emitAndSolve(polygonEmission({
      center: [0, 0], diameter: 20, sides: 6, mode: 'circumscribed', diameterDim: '20',
    }));
    expect(solver.outcome).toBe('solved');
    expect(solver.conflicting).toEqual([]);
    expect(solver.redundant).toEqual([]);
    expect(solver.dof).toBe(3);
  });
});
