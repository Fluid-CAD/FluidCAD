// The bridge — `bridge(from, to)` — written, read back and edited by the
// server: the statement from its two ends and its options (the continuity
// per end, the two magnitudes, each left out at its default and a magnitude
// at an end met at 'g0'), its parse into the ends as written and the
// options, an edit of an end, a continuity or a magnitude with everything
// else kept as written, the refusals, and the preview request. The
// transform is exercised on code alone; the routes on a fake server, then on
// a scene the real engine built.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import plane from '../../lib/core/plane.js';
import bridge from '../../lib/core/bridge.js';
import { line, point, project } from '../../lib/core/2d/index.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Wire } from '../../lib/common/wire.js';
import { Edge } from '../../lib/common/edge.js';
import { Bridge } from '../../lib/features/bridge.js';
import { CurveEnds } from '../../lib/helpers/curve-end.js';
import { Scene } from '../../lib/rendering/scene.js';
import {
  applyFeatureEdit,
  BRIDGE_MAGNITUDE_NOT_POSITIVE,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type BridgeEdit,
  type BridgeEditOptions,
  type EndSpec,
} from '../src/apply-feature-edit/index.ts';
import { createApplyFeatureRouter } from '../src/routes/apply-feature/index.ts';
import { createFeatureGhostRouter } from '../src/routes/feature-ghost/index.ts';

const FILE = '/ws/model.fluid.js';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

type Producer = ApplyFeatureEditSpec['producers'][number];
type Part = ApplyFeatureEditSpec['parts'][number];

const solid = (line: number, column: number, nameHint = 'e'): Producer =>
  ({ line, column, featureType: 'extrude', nameHint, bind: true });
const curve = (line: number, column: number, nameHint = 'c'): Producer =>
  ({ line, column, featureType: 'wire', nameHint, bind: true });
/** `<producer>.<accessor>(<indices>)`. */
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices: indices.length > 0 ? indices : null, filterArgs: null });
const edgeEnd = (part: number, end: 'start' | 'end'): EndSpec => ({ kind: 'edge', part, end });
const curveEnd = (producer: number, end: 'start' | 'end'): EndSpec => ({ kind: 'curve', producer, end });

/**
 * Two cylinders (lines 4 and 6), a parameter (line 7) and a helix (line 8).
 */
const CODE = src(
  `import { sketch, circle, extrude, helix, param } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const a = extrude(20)`,
  `sketch('xy', () => { circle([60, 0], 10) })`,
  `const b = extrude(10)`,
  `const m = param('M', 1.5)`,
  `helix('z', { radius: 5, pitch: 2, height: 10 })`,
);

/** The import line once the bridge is written into {@link CODE}. */
const IMPORTS = `import { bridge, sketch, circle, extrude, helix, param } from 'fluidcad/core'`;

/** The two cylinders' producers and their first edges' parts. */
const SOLIDS = { producers: [solid(4, 10, 'a'), solid(6, 10, 'b')], parts: [bucket(0, 'edges', 0), bucket(1, 'edges', 0)] };

/** A create spec over {@link CODE}: the ends and the options, defaults where left out. */
function createSpec(
  bridge: Partial<BridgeEditOptions> & Pick<BridgeEditOptions, 'from' | 'to'>,
  producers: Producer[] = SOLIDS.producers,
  parts: Part[] = SOLIDS.parts,
): ApplyFeatureEditSpec {
  return {
    feature: 'bridge',
    filePath: FILE,
    bridge: { startContinuity: 'g1', endContinuity: 'g1', startMagnitude: 1, endMagnitude: 1, ...bridge },
    producers,
    parts,
    imports: [],
  };
}

/** The defaults' ends: the end of the first cylinder's first edge, the start of the second's. */
const ENDS = { from: edgeEnd(0, 'end'), to: edgeEnd(1, 'start') };

/** An edit of the bridge statement on `line`. */
function editSpec(
  code: string,
  line: number,
  bridge: BridgeEdit,
  producers: Producer[] = [],
  parts: Part[] = [],
): [string, ApplyFeatureEditSpec] {
  return [code, {
    feature: 'bridge', filePath: FILE, producers, parts, imports: [],
    edit: { line, column: 0, bridge },
  }];
}

/** The statement the create path appended to {@link CODE}, the import aside. */
function appended(newCode: string): string {
  expect(newCode.startsWith(`${IMPORTS}\n`)).toBe(true);
  const body = CODE.slice(CODE.indexOf('\n'));
  expect(newCode.slice(IMPORTS.length, IMPORTS.length + body.length)).toBe(body);
  return newCode.slice(IMPORTS.length + body.length).trimEnd();
}

describe('writing a bridge', () => {
  it('writes bridge(a.edges(0).end(), b.edges(0).start()) with every option at its default, named and imported', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(ENDS));
    expect(result.error).toBeUndefined();
    expect(appended(result.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 1')`);
  });

  it('writes .continuity(\'g2\').startMagnitude(1.5), leaving the end magnitude at its default out', async () => {
    const result = await applyFeatureEdit(CODE, createSpec({ ...ENDS, startContinuity: 'g2', endContinuity: 'g2', startMagnitude: 1.5 }));
    expect(result.error).toBeUndefined();
    expect(appended(result.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).continuity('g2').startMagnitude(1.5).name('Bridge 1')`);
  });

  it('writes the continuity per end, one value when alike and two when they differ, and the magnitudes in order', async () => {
    const cases: [Partial<BridgeEditOptions>, string][] = [
      [{ startContinuity: 'g0', endContinuity: 'g0' }, `.continuity('g0')`],
      [{ startContinuity: 'g1', endContinuity: 'g0' }, `.continuity('g1', 'g0')`],
      [{ startContinuity: 'g2', endContinuity: 'g1' }, `.continuity('g2', 'g1')`],
      [{ startMagnitude: 2, endMagnitude: 0.5 }, `.startMagnitude(2).endMagnitude(0.5)`],
      [{ endMagnitude: 3 }, `.endMagnitude(3)`],
    ];
    for (const [options, chains] of cases) {
      const result = await applyFeatureEdit(CODE, createSpec({ ...ENDS, ...options }));
      expect(result.error, JSON.stringify(options)).toBeUndefined();
      expect(appended(result.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start())${chains}.name('Bridge 1')`);
    }
  });

  it('leaves a magnitude out at an end met at g0, where it does nothing', async () => {
    const result = await applyFeatureEdit(CODE, createSpec({
      ...ENDS, startContinuity: 'g1', endContinuity: 'g0', startMagnitude: 2, endMagnitude: 4,
    }));
    expect(result.error).toBeUndefined();
    expect(appended(result.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).continuity('g1', 'g0').startMagnitude(2).name('Bridge 1')`);
  });

  it('writes a magnitude given as a variable or an expression as written, and reads it back as that expression', async () => {
    for (const magnitude of ['m', 'm * 2']) {
      const result = await applyFeatureEdit(CODE, createSpec({ ...ENDS, startMagnitude: magnitude, endMagnitude: magnitude }));
      expect(result.error).toBeUndefined();
      expect(appended(result.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).startMagnitude(${magnitude}).endMagnitude(${magnitude}).name('Bridge 1')`);
      const line = result.newCode.trimEnd().split('\n').length;
      expect(await parseFeatureStatement(result.newCode, line)).toMatchObject({
        ok: true,
        parsed: { feature: 'bridge', startMagnitude: magnitude, endMagnitude: magnitude, startMagnitudeArg: magnitude, endMagnitudeArg: magnitude },
      });
    }
  });

  it('writes a curve\'s end by its variable, binding the curve statement as c', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      { from: curveEnd(0, 'end'), to: edgeEnd(0, 'start') },
      [curve(8, 0), solid(6, 10, 'b')],
      [bucket(1, 'edges', 0)],
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const c = helix('z', { radius: 5, pitch: 2, height: 10 })`);
    expect(result.newCode).toContain(`bridge(c.end(), b.edges(0).start()).name('Bridge 1')`);
  });

  it('numbers its name past the bridges the file already names', async () => {
    const code = `${CODE}bridge(a.edges(1).end(), b.edges(1).start()).name('Bridge 4')\n`;
    const result = await applyFeatureEdit(code, createSpec(ENDS));
    expect(result.error).toBeUndefined();
    expect(result.newCode.trimEnd().endsWith(`bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 5')`)).toBe(true);
  });

  it("refuses a literal zero or negative magnitude at an end that writes one, in the engine's words, before anything is written", async () => {
    for (const options of [{ startMagnitude: 0 }, { endMagnitude: -1 }, { startMagnitude: '0' }, { endMagnitude: ' -2.5 ' }]) {
      const result = await applyFeatureEdit(CODE, createSpec({ ...ENDS, ...options }));
      expect(result.error, JSON.stringify(options)).toBe(BRIDGE_MAGNITUDE_NOT_POSITIVE);
      expect(result.newCode).toBe(CODE);
    }
    const atPosition = await applyFeatureEdit(CODE, createSpec({ ...ENDS, startContinuity: 'g0', endContinuity: 'g0', startMagnitude: 0, endMagnitude: -1 }));
    expect(atPosition.error).toBeUndefined();
    expect(appended(atPosition.newCode)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).continuity('g0').name('Bridge 1')`);
  });

  it('refuses a malformed end, a continuity outside its words, an unstaged sketch point and a part no end writes', async () => {
    const refusals: [ApplyFeatureEditSpec, string][] = [
      [createSpec({ ...ENDS, to: { kind: 'edge', part: 5, end: 'start' } }), 'malformed bridge edit spec: the to end references no selector part'],
      [createSpec({ ...ENDS, from: { kind: 'edge', part: 0, end: 'middle' } as never }), 'malformed bridge edit spec: the from end must say start or end'],
      [createSpec({ ...ENDS, from: curveEnd(0, 'end') }), 'malformed bridge edit spec: the from end references a statement that is not a curve'],
      [createSpec({ ...ENDS, startContinuity: 'g3' as never }), 'malformed bridge edit spec'],
      [createSpec({ ...ENDS, startMagnitude: Number.NaN }), 'malformed bridge edit spec: startMagnitude must be a number or expression'],
      [createSpec({ from: edgeEnd(0, 'end'), to: edgeEnd(0, 'start') }), 'malformed bridge edit spec: every selector part belongs to exactly one end'],
    ];
    for (const [spec, error] of refusals) {
      const result = await applyFeatureEdit(CODE, spec);
      expect(result.error, JSON.stringify(spec.bridge)).toBe(error);
      expect(result.newCode).toBe(CODE);
    }
  });

  it('is bound as br when a later statement takes its edge', async () => {
    const code = `${CODE}bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 1')\n`;
    const result = await applyFeatureEdit(code, {
      feature: 'sweep',
      filePath: FILE,
      sweep: { op: 'new', thin: null, profile: { producer: 1 }, path: { kind: 'selector' } },
      producers: [{ line: 9, column: 0, featureType: 'bridge', nameHint: 'br', bind: true }, { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true }],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const br = bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 1')`);
    expect(result.newCode).toContain(`br.edges(0)`);
  });
});

/**
 * {@link CODE} with the helix bound (line 8) and bridges written by hand
 * and by the dialog (lines 9 on).
 */
const WRITTEN = src(
  IMPORTS,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const a = extrude(20)`,
  `sketch('xy', () => { circle([60, 0], 10) })`,
  `const b = extrude(10)`,
  `const m = param('M', 1.5)`,
  `const c = helix('z', { radius: 5, pitch: 2, height: 10 })`,
  `bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 1')`,
  `bridge(a.edges(1).end(), c.start()).continuity('g2').startMagnitude(1.5).name('Bridge 2')`,
  `bridge(a.edges(2).end(), b.edges(2).start()).startMagnitude(m).endMagnitude(m * 2)`,
  `bridge(c.end(), b.edges(3).end()).continuity('g1', 'g0').endMagnitude(3)`,
  `const v = a.edges(4).start()`,
  `bridge(v, c.start()).endMagnitude(2).continuity('g2').startMagnitude(3)`,
  `bridge(a.edges(5).end(), b.edges(5).start()).continuity(k)`,
  `bridge(a.edges(6).end(), b.edges(6).start()).continuity('g3')`,
  `bridge(a.edges(7).end())`,
  `bridge(...ends)`,
  `bridge(a.edges(8).end(), b.edges(8).start()).continuity('g0', 'g1', 'g2')`,
  `bridge(a.edges(9).end(), b.edges(9).start()).startMagnitude(0).name('Bridge 3')`,
  `bridge(a.edges(10).end(), b.edges(10).start()).startMagnitude()`,
  `bridge(a.edges(11).end(), b.edges(11).start()).continuity('g1').startMagnitude(1)`,
);

/** A parsed bridge with every option at its default, `fields` over it. */
function parsedBridge(fields: Record<string, unknown>) {
  return {
    feature: 'bridge',
    fromRef: null,
    toRef: null,
    startContinuity: 'g1',
    endContinuity: 'g1',
    startMagnitude: 1,
    endMagnitude: 1,
    startMagnitudeArg: null,
    endMagnitudeArg: null,
    ...fields,
  };
}

/** The line of {@link WRITTEN} as an edit leaves it. */
function lineOf(code: string, line: number): string {
  return code.split('\n')[line - 1];
}

describe('reading a bridge back', () => {
  it('parses a dialog-written statement: the ends as written, every option at its default, the name left out', async () => {
    const result = await parseFeatureStatement(WRITTEN, 9);
    expect(result).toEqual({
      ok: true,
      parsed: parsedBridge({ fromText: 'a.edges(0).end()', toText: 'b.edges(0).start()' }),
      statement: 'bridge(a.edges(0).end(), b.edges(0).start())',
    });
  });

  it('reads one continuity value as both ends, two as the start\'s and the end\'s, and the magnitudes as written', async () => {
    expect(await parseFeatureStatement(WRITTEN, 10)).toMatchObject({
      ok: true,
      parsed: parsedBridge({
        fromText: 'a.edges(1).end()', toText: 'c.start()',
        startContinuity: 'g2', endContinuity: 'g2', startMagnitude: 1.5, startMagnitudeArg: '1.5',
      }),
      statement: `bridge(a.edges(1).end(), c.start()).continuity('g2').startMagnitude(1.5)`,
    });
    expect(await parseFeatureStatement(WRITTEN, 12)).toMatchObject({
      ok: true,
      parsed: parsedBridge({
        fromText: 'c.end()', toText: 'b.edges(3).end()',
        startContinuity: 'g1', endContinuity: 'g0', endMagnitude: 3, endMagnitudeArg: '3',
      }),
    });
  });

  it('reads a magnitude given as a variable or an expression back as that expression', async () => {
    const result = await parseFeatureStatement(WRITTEN, 11);
    expect(result).toEqual({
      ok: true,
      parsed: parsedBridge({
        fromText: 'a.edges(2).end()', toText: 'b.edges(2).start()',
        startMagnitude: 'm', endMagnitude: 'm * 2', startMagnitudeArg: 'm', endMagnitudeArg: 'm * 2',
      }),
      statement: 'bridge(a.edges(2).end(), b.edges(2).start()).startMagnitude(m).endMagnitude(m * 2)',
    });
  });

  it('reads the chains in any order, and a bare-variable end with the statement it names', async () => {
    const result = await parseFeatureStatement(WRITTEN, 14);
    expect(result).toMatchObject({
      ok: true,
      parsed: parsedBridge({
        fromText: 'v', toText: 'c.start()', fromRef: { line: 13, column: 10 },
        startContinuity: 'g2', endContinuity: 'g2', startMagnitude: 3, endMagnitude: 2, startMagnitudeArg: '3', endMagnitudeArg: '2',
      }),
    });
  });

  it('refuses for the dialog a continuity it cannot show, an end missing, a spread and a magnitude without its value', async () => {
    const refusals: [number, string][] = [
      [15, `the .continuity() argument is not 'g0', 'g1' or 'g2' — edit it in the source`],
      [16, `the .continuity() argument is not 'g0', 'g1' or 'g2' — edit it in the source`],
      [17, 'bridge() takes the two ends it joins as its two arguments — edit it in the source'],
      [18, 'bridge() takes the two ends it joins as its two arguments — edit it in the source'],
      [19, `the .continuity() chain takes one value for both ends, or the start's and the end's — edit it in the source`],
      [21, 'the .startMagnitude() argument is not a plain number or expression — edit it in the source'],
    ];
    for (const [line, reason] of refusals) {
      expect(await parseFeatureStatement(WRITTEN, line), String(line)).toEqual({ ok: false, reason });
    }
  });
});

describe('editing a bridge', () => {
  it('changes one magnitude and leaves the ends, the other options and the trailing .name(…) as written', async () => {
    const result = await applyFeatureEdit(...editSpec(WRITTEN, 10, { startMagnitude: 2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(WRITTEN.replace(
      `c.start()).continuity('g2').startMagnitude(1.5).name('Bridge 2')`,
      `c.start()).continuity('g2').startMagnitude(2).name('Bridge 2')`,
    ));
  });

  it('writes a new magnitude as a variable or an expression, and keeps a kept one\'s text', async () => {
    const result = await applyFeatureEdit(...editSpec(WRITTEN, 11, { endMagnitude: 'm / 2', startContinuity: 'g2', endContinuity: 'g2' }));
    expect(result.error).toBeUndefined();
    expect(lineOf(result.newCode, 11)).toBe(`bridge(a.edges(2).end(), b.edges(2).start()).continuity('g2').startMagnitude(m).endMagnitude(m / 2)`);
  });

  it('sets the continuity per end, one value when alike, none when both are g1', async () => {
    const perEnd = await applyFeatureEdit(...editSpec(WRITTEN, 9, { startContinuity: 'g1', endContinuity: 'g0' }));
    expect(perEnd.error).toBeUndefined();
    expect(lineOf(perEnd.newCode, 9)).toBe(`bridge(a.edges(0).end(), b.edges(0).start()).continuity('g1', 'g0').name('Bridge 1')`);

    const alike = await applyFeatureEdit(...editSpec(WRITTEN, 12, { startContinuity: 'g0' }));
    expect(lineOf(alike.newCode, 12)).toBe(`bridge(c.end(), b.edges(3).end()).continuity('g0')`);

    const defaults = await applyFeatureEdit(...editSpec(WRITTEN, 10, { endContinuity: 'g1', startContinuity: 'g1' }));
    expect(lineOf(defaults.newCode, 10)).toBe(`bridge(a.edges(1).end(), c.start()).startMagnitude(1.5).name('Bridge 2')`);
  });

  it('drops the magnitude of an end it sets to g0, and gives a kept one back once that end is no longer g0', async () => {
    const toPosition = await applyFeatureEdit(...editSpec(WRITTEN, 10, { startContinuity: 'g0' }));
    expect(toPosition.error).toBeUndefined();
    expect(lineOf(toPosition.newCode, 10)).toBe(`bridge(a.edges(1).end(), c.start()).continuity('g0', 'g2').name('Bridge 2')`);

    // Written by hand with a magnitude at its g0 end, which does nothing there.
    const handWritten = await applyFeatureEdit(...editSpec(WRITTEN, 12, { startMagnitude: 2 }));
    expect(lineOf(handWritten.newCode, 12)).toBe(`bridge(c.end(), b.edges(3).end()).continuity('g1', 'g0').startMagnitude(2)`);
    const restored = await applyFeatureEdit(...editSpec(WRITTEN, 12, { endContinuity: 'g2' }));
    expect(lineOf(restored.newCode, 12)).toBe(`bridge(c.end(), b.edges(3).end()).continuity('g1', 'g2').endMagnitude(3)`);
  });

  it('rewrites the chains in canonical order with the defaults left out', async () => {
    const reordered = await applyFeatureEdit(...editSpec(WRITTEN, 14, { endMagnitude: 4 }));
    expect(reordered.error).toBeUndefined();
    expect(lineOf(reordered.newCode, 14)).toBe(`bridge(v, c.start()).continuity('g2').startMagnitude(3).endMagnitude(4)`);

    const defaults = await applyFeatureEdit(...editSpec(WRITTEN, 22, { endMagnitude: 1 }));
    expect(lineOf(defaults.newCode, 22)).toBe(`bridge(a.edges(11).end(), b.edges(11).start())`);
  });

  it('re-picks one end, leaving the other and the options as written', async () => {
    const toCurve = await applyFeatureEdit(...editSpec(WRITTEN, 9, { to: curveEnd(0, 'end') }, [curve(8, 10)]));
    expect(toCurve.error).toBeUndefined();
    expect(toCurve.newCode).toBe(WRITTEN.replace(
      `bridge(a.edges(0).end(), b.edges(0).start()).name('Bridge 1')`,
      `bridge(a.edges(0).end(), c.end()).name('Bridge 1')`,
    ));

    const fromEdge = await applyFeatureEdit(...editSpec(WRITTEN, 10, { from: edgeEnd(0, 'start'), to: { kind: 'keep' } }, [solid(4, 10, 'a')], [bucket(0, 'endEdges')]));
    expect(fromEdge.error).toBeUndefined();
    expect(lineOf(fromEdge.newCode, 10)).toBe(`bridge(a.endEdges().start(), c.start()).continuity('g2').startMagnitude(1.5).name('Bridge 2')`);
  });

  it("refuses a zero or negative magnitude at an end that writes one, new or kept, in the engine's words", async () => {
    const added = await applyFeatureEdit(...editSpec(WRITTEN, 9, { endMagnitude: -3 }));
    expect(added.error).toBe(BRIDGE_MAGNITUDE_NOT_POSITIVE);
    expect(added.newCode).toBe(WRITTEN);

    const kept = await applyFeatureEdit(...editSpec(WRITTEN, 20, { endMagnitude: 2 }));
    expect(kept.error).toBe(BRIDGE_MAGNITUDE_NOT_POSITIVE);

    const fixed = await applyFeatureEdit(...editSpec(WRITTEN, 20, { startMagnitude: 0.5 }));
    expect(lineOf(fixed.newCode, 20)).toBe(`bridge(a.edges(9).end(), b.edges(9).start()).startMagnitude(0.5).name('Bridge 3')`);

    const atPosition = await applyFeatureEdit(...editSpec(WRITTEN, 20, { startContinuity: 'g0' }));
    expect(lineOf(atPosition.newCode, 20)).toBe(`bridge(a.edges(9).end(), b.edges(9).start()).continuity('g0', 'g1').name('Bridge 3')`);
  });

  it('refuses an edit of a statement the dialog cannot show, and a malformed end', async () => {
    const variable = await applyFeatureEdit(...editSpec(WRITTEN, 15, { startMagnitude: 2 }));
    expect(variable.error).toBe(`the .continuity() argument is not 'g0', 'g1' or 'g2' — edit it in the source`);
    expect(variable.newCode).toBe(WRITTEN);

    const stale = await applyFeatureEdit(...editSpec(WRITTEN, 9, { to: edgeEnd(3, 'end') }));
    expect(stale.error).toBe('malformed bridge edit spec: the to end references no selector part');
  });
});

// ---------------------------------------------------------------------------
// The routes, on a fake server.

let relayed: any[];
let received: any;
let currentCode: string;
let server: http.Server | null = null;

const fakeServer = {
  getCurrentCode: () => currentCode,
  getCurrentFileName: () => FILE,
  getParamDefinitions: () => [] as unknown[],
  getRenderedInstances: () => [] as unknown[],
  getRenderedParts: () => [] as unknown[],
  synthesizeApplyFeature: () => {
    throw new Error('no pick here synthesizes');
  },
  resolveSelection: () => {
    throw new Error('no vertex here synthesizes');
  },
  featureGhost: async (request: unknown) => {
    received = request;
    return { status: 200, solids: [{ kind: 'wire', meshes: [] }] };
  },
};

/** Mount the apply and preview routes over `host`; answers the API base. */
async function serve(host: unknown): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createApplyFeatureRouter(host as never, (msg: any) => {
    relayed.push(msg);
  }));
  app.use('/api', createFeatureGhostRouter(host as never));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}/api`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** Apply the last relayed spec to `code` through the transform endpoint; answers the new code. */
async function written(base: string, code: string): Promise<string> {
  const result = await post(`${base}/code/apply-feature`, { code, spec: relayed[relayed.length - 1].spec });
  expect(result.body.error).toBeUndefined();
  return result.body.newCode;
}

/** Where the curve statement at `line` starts or ends. */
const curveEndAt = (line: number, column: number, end: 'start' | 'end') => ({ kind: 'curve-end', filePath: FILE, line, column, end });

/** A create request over {@link CODE}: from the helix's end to its start, `fields` over it. */
const request = (fields: Record<string, unknown> = {}) => ({
  feature: 'bridge',
  from: curveEndAt(8, 0, 'end'),
  to: curveEndAt(8, 0, 'start'),
  startContinuity: 'g1',
  endContinuity: 'g1',
  startMagnitude: 1,
  endMagnitude: 1,
  ...fields,
});

/** The bridge statement at `line` of {@link WRITTEN} as an edit target. */
const target = (line: number) => ({ filePath: FILE, line, column: 0 });

beforeEach(() => {
  relayed = [];
  received = undefined;
  currentCode = CODE;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
});

describe('the routes', () => {
  it('writes two curve ends without synthesis, the curve bound under its name', async () => {
    const base = await serve(fakeServer);

    const preview = await post(`${base}/apply-feature`, { ...request(), preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'bridge(c.end(), c.start())' } });
    expect(relayed).toEqual([]);

    const applied = await post(`${base}/apply-feature`, request({ startContinuity: 'g2', endContinuity: 'g0', startMagnitude: 'm', endMagnitude: 'garbage' }));
    expect(applied.status).toBe(200);
    expect(relayed[0].spec).toMatchObject({
      feature: 'bridge',
      bridge: {
        from: { kind: 'curve', producer: 0, end: 'end' },
        to: { kind: 'curve', producer: 0, end: 'start' },
        startContinuity: 'g2',
        endContinuity: 'g0',
        startMagnitude: 'm',
      },
      producers: [{ line: 8, column: 0, featureType: 'wire', nameHint: 'c', bind: true }],
      parts: [],
    });
    expect(await written(base, CODE)).toBe(`${CODE.replace(`import { sketch`, `import { bridge, sketch`).replace(
      `helix('z'`, `const c = helix('z'`,
    )}bridge(c.end(), c.start()).continuity('g2', 'g0').startMagnitude(m).name('Bridge 1')\n`);
  });

  it("refuses malformed ends and options, the same pick twice and a zero or negative magnitude in the engine's words", async () => {
    const base = await serve(fakeServer);
    const refusals: [Record<string, unknown>, string][] = [
      [{ from: undefined }, 'from must be {kind: "edge-end"|"curve-end"|"vertex", …}'],
      [{ to: { kind: 'edge-end', shapeId: 's1', index: 0, end: 'middle' } }, 'to must be {kind: "edge-end", shapeId, index, end: "start"|"end"}'],
      [{ to: { kind: 'curve-end', filePath: FILE, end: 'start' } }, 'to must be {kind: "curve-end", filePath, line, column, end: "start"|"end"}'],
      [{ from: { kind: 'vertex', shapeId: '', index: 0 } }, 'from must be {kind: "vertex", shapeId, index}'],
      [{ to: curveEndAt(8, 0, 'end') }, 'bridge: the two ends are at the same point.'],
      [{ startContinuity: 'g3' }, 'startContinuity must be "g0", "g1" or "g2"'],
      [{ startMagnitude: 0 }, BRIDGE_MAGNITUDE_NOT_POSITIVE],
      [{ endMagnitude: '-1' }, BRIDGE_MAGNITUDE_NOT_POSITIVE],
      [{ endMagnitude: true }, 'endMagnitude must be a number or expression'],
    ];
    for (const [fields, error] of refusals) {
      expect(await post(`${base}/apply-feature`, request(fields)), JSON.stringify(fields)).toEqual({ status: 400, body: { error } });
    }
    expect(relayed).toEqual([]);

    const atPosition = await post(`${base}/apply-feature`, { ...request({ startContinuity: 'g0', startMagnitude: 0 }), preview: true });
    expect(atPosition).toEqual({ status: 200, body: { success: true, preview: `bridge(c.end(), c.start()).continuity('g0', 'g1')` } });
  });

  it('edits a magnitude or a continuity without a boundary, leaving the ends and the name as written', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);

    const magnitude = await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(10), startMagnitude: 2, preview: true });
    expect(magnitude).toEqual({ status: 200, body: { success: true, preview: `bridge(a.edges(1).end(), c.start()).continuity('g2').startMagnitude(2)` } });

    const continuity = await post(`${base}/apply-feature`, {
      feature: 'bridge', edit: target(10), expectedStatement: `bridge(a.edges(1).end(), c.start()).continuity('g2').startMagnitude(1.5)`,
      startContinuity: 'g0', endContinuity: 'g2', startMagnitude: 'hidden field text',
    });
    expect(continuity.status).toBe(200);
    expect(relayed[0].spec.edit).toMatchObject({ line: 10, bridge: { startContinuity: 'g0', endContinuity: 'g2' } });
    expect(lineOf(await written(base, WRITTEN), 10)).toBe(`bridge(a.edges(1).end(), c.start()).continuity('g0', 'g2').name('Bridge 2')`);
  });

  it('re-picks an end by its curve statement, and asks a boundary of a picked edge or vertex', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);

    const repicked = await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(9), to: curveEndAt(8, 10, 'end'), from: { kind: 'keep' } });
    expect(repicked.status).toBe(200);
    expect(lineOf(await written(base, WRITTEN), 9)).toBe(`bridge(a.edges(0).end(), c.end()).name('Bridge 1')`);

    for (const end of [{ kind: 'edge-end', shapeId: 's1', index: 0, end: 'start' }, { kind: 'vertex', shapeId: 's1', index: 0 }]) {
      expect(await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(9), from: end }))
        .toEqual({ status: 400, body: { error: 'before is required when an edit re-picks geometry' } });
    }
  });

  it("refuses a zero magnitude at an end it sets off g0 at once, and a kept continuity's in the engine's words", async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);

    expect(await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(9), startContinuity: 'g2', startMagnitude: 0 }))
      .toEqual({ status: 400, body: { error: BRIDGE_MAGNITUDE_NOT_POSITIVE } });
    expect(await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(9), startMagnitude: -2 }))
      .toEqual({ status: 422, body: { success: false, reason: BRIDGE_MAGNITUDE_NOT_POSITIVE } });
    const atPosition = await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(12), endMagnitude: 0, preview: true });
    expect(atPosition).toEqual({ status: 200, body: { success: true, preview: `bridge(c.end(), b.edges(3).end()).continuity('g1', 'g0')` } });
    expect(await post(`${base}/apply-feature`, { feature: 'bridge', edit: target(15), startMagnitude: 2 }))
      .toEqual({ status: 422, body: { success: false, reason: `the .continuity() argument is not 'g0', 'g1' or 'g2' — edit it in the source` } });
    expect(relayed).toEqual([]);
  });

  it('hands the preview both ends and the magnitudes resolved, with no op, a g0 end\'s magnitude 1 when it does not read', async () => {
    const base = await serve(fakeServer);
    const ends = { from: { kind: 'edge-end', shapeId: 's1', index: 2, end: 'end' }, to: curveEndAt(8, 0, 'start') };
    const result = await post(`${base}/feature-ghost`, {
      feature: 'bridge', ...ends, startContinuity: 'g2', endContinuity: 'g1', startMagnitude: '1 + 0.5', endMagnitude: 2,
    });
    expect(result).toEqual({ status: 200, body: { success: true, solids: [{ kind: 'wire', meshes: [] }] } });
    expect(received).toEqual({
      feature: 'bridge',
      from: { kind: 'edge-end', shapeId: 's1', index: 2, end: 'end' },
      to: { kind: 'curve-end', filePath: FILE, line: 8, end: 'start' },
      startContinuity: 'g2',
      endContinuity: 'g1',
      startMagnitude: 1.5,
      endMagnitude: 2,
    });

    for (const [magnitude, sent] of [['not a value (', 1], [-3, 1], [0, 1], [undefined, 1], [2.5, 2.5]] as const) {
      const ghost = await post(`${base}/feature-ghost`, {
        feature: 'bridge', from: { kind: 'vertex', shapeId: 's2', index: 4 }, to: ends.to, startContinuity: 'g0', startMagnitude: magnitude,
      });
      expect(ghost.status).toBe(200);
      expect(received).toEqual({
        feature: 'bridge',
        from: { kind: 'vertex', shapeId: 's2', index: 4 },
        to: { kind: 'curve-end', filePath: FILE, line: 8, end: 'start' },
        startContinuity: 'g0',
        endContinuity: 'g1',
        startMagnitude: sent,
        endMagnitude: 1,
      });
    }
  });

  it('refuses a preview with an end it cannot address, a continuity outside its words or a magnitude that is no value', async () => {
    const base = await serve(fakeServer);
    const ghost = (fields: Record<string, unknown>) => ({
      feature: 'bridge', from: curveEndAt(8, 0, 'end'), to: { kind: 'vertex', shapeId: 's1', index: 0 }, ...fields,
    });
    for (const [body, reason] of [
      [ghost({ from: undefined }), 'Invalid bridge ends'],
      [ghost({ to: { kind: 'edge-end', shapeId: 's1', index: 0 } }), 'Invalid bridge ends'],
      [ghost({ to: { kind: 'face', shapeId: 's1', index: 0 } }), 'Invalid bridge ends'],
      [ghost({ endContinuity: 'g3' }), 'Invalid bridge continuity'],
      [ghost({ startMagnitude: true }), 'Invalid dimension'],
    ] as const) {
      expect(await post(`${base}/feature-ghost`, body), JSON.stringify(body)).toEqual({ status: 400, body: { success: false, reason } });
    }
    expect(await post(`${base}/feature-ghost`, ghost({ endMagnitude: 'nowhere' })))
      .toEqual({ status: 200, body: { success: false, reason: 'That value is not a number the preview can resolve.' } });
    expect(received).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The routes over a scene the real engine built.

const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

/** Execute a .fluid.js source string against the real runtime (fresh scene). */
function runFluid(source: string): Scene {
  getSceneManager()!.startScene();
  const globals: Record<string, unknown> = { ...core, ...filters, ...math };
  const names = Object.keys(globals);
  const fn = new Function(...names, `"use strict";\n${source.replace(IMPORT_LINE_RE, '')}`);
  fn(...names.map(name => globals[name]));
  return render();
}

const located = <T>(value: T, line: number, column: number): T => {
  (value as unknown as SceneObject).setSourceLocation({ filePath: FILE, line, column });
  return value;
};

/**
 * The index among the body's edges of the one between `p` and `q`, and
 * which of its ends — in its own sense, by its curve's parameter, as the
 * end row offers them — lies at `p`.
 */
function edgeEndAt(body: Shape, p: number[], q: number[]): { index: number; end: 'start' | 'end' } {
  const near = (at: { x: number; y: number; z: number }, to: number[]) => [at.x, at.y, at.z].every((v, i) => Math.abs(v - to[i]) < 1e-6);
  const edges = Explorer.findEdgesWrapped(body);
  const index = edges.findIndex(edge => {
    const [a, b] = EdgeOps.endPoints(edge);
    return (near(a, p) && near(b, q)) || (near(a, q) && near(b, p));
  });
  return { index, end: near(CurveEnds.ofEdge(edges[index] as Edge, 'start').point, p) ? 'start' : 'end' };
}

/** The index among the body's vertices of the one at `p`. */
function vertexAt(body: Shape, p: number[]): number {
  return Explorer.findVerticesWrapped(body).findIndex(vertex => {
    const at = vertex.toPoint();
    return [at.x, at.y, at.z].every((v, i) => Math.abs(v - p[i]) < 1e-6);
  });
}

/** Where a built wire starts and ends, rounded. */
function endsOf(wire: Wire): number[][] {
  return [wire.getFirstPoint()!, wire.getLastPoint()!].map(at => [at.x, at.y, at.z].map(v => +v.toFixed(6) + 0));
}

describe('through the real engine', () => {
  setupOC();

  /**
   * The code the scene below mirrors: a 40 × 20 × 5 block (line 4), two
   * rails projected onto its top — A from (5, 5, 5) to (15, 5, 5) on line 6,
   * B from (25, 15, 5) to (35, 15, 5) on line 8 — a sketch point at
   * (30, 2, 30) (line 10) and a sketch line from (0, 30, 40) to
   * (10, 40, 40) (line 13); with `withBridge`, the bridge from A's end to
   * B's start on line 15.
   */
  const STAGED = [
    `import { sketch, extrude, plane, line, point, project } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { line([0, 0], [40, 0]); line([40, 0], [40, 20]); line([40, 20], [0, 20]); line([0, 20], [0, 0]) })`,
    `const e = extrude(5)`,
    `const sk = sketch(plane('xy', 20), () => { line([5, 5], [15, 5]) })`,
    `const a = project(sk, e.endFaces())`,
    `const sk2 = sketch(plane('xy', 20), () => { line([25, 15], [35, 15]) })`,
    `const b = project(sk2, e.endFaces())`,
    `const s = sketch(plane('xy', 30), () => {`,
    `  point([30, 2])`,
    `})`,
    `const sk3 = sketch(plane('xy', 40), () => {`,
    `  line([0, 30], [10, 40])`,
    `})`,
  ];
  const BRIDGE_LINE = `bridge(a.end(), b.start()).continuity('g2').startMagnitude(1.5).name('Bridge 1')`;

  function stage(withBridge = false) {
    located(sketch('xy', () => {
      line([0, 0], [40, 0]);
      line([40, 0], [40, 20]);
      line([40, 20], [0, 20]);
      line([0, 20], [0, 0]);
    }), 3, 0);
    const e = located(extrude(5), 4, 10);
    const sk = located(sketch(plane('xy', 20), () => {
      line([5, 5], [15, 5]);
    }), 5, 11);
    const a = located(project(sk as never, (e as any).endFaces()), 6, 10);
    const sk2 = located(sketch(plane('xy', 20), () => {
      line([25, 15], [35, 15]);
    }), 7, 12);
    const b = located(project(sk2 as never, (e as any).endFaces()), 8, 10);
    let p: unknown;
    located(sketch(plane('xy', 30), () => {
      p = located(point([30, 2]), 10, 2);
    }), 9, 10);
    let l: unknown;
    located(sketch(plane('xy', 40), () => {
      l = located(line([0, 30], [10, 40]), 13, 2);
    }), 12, 12);
    const br = withBridge
      ? located(bridge((a as any).end(), (b as any).start()).continuity('g2').startMagnitude(1.5), 15, 0)
      : null;
    const scene = render();
    expect(scene.getAllSceneObjects().map(obj => obj.getError()).filter(Boolean)).toEqual([]);
    const code = src(
      ...(withBridge ? [STAGED[0].replace('{ sketch', '{ bridge, sketch'), ...STAGED.slice(1), BRIDGE_LINE] : STAGED),
    );
    return {
      scene,
      code,
      body: (e as unknown as SceneObject).getShapes().find(shape => shape.isSolid())!,
      rail: (a as unknown as SceneObject).getShapes()[0],
      pointVertex: (p as SceneObject).getAddedShapes()[0],
      lineEdge: (l as SceneObject).getAddedShapes()[0],
      bridge: br as unknown as Bridge | null,
    };
  }

  /** The fake server's half that reads the scene: synthesis, point synthesis, preview and sources from the engine. */
  function engineHost(scene: Scene, code: string) {
    currentCode = code;
    return {
      ...fakeServer,
      synthesizeApplyFeature: (refs: any, feature: any, value: any, chains: any, options: any, before: any) =>
        getSceneManager()!.synthesizeApplyFeature(scene, refs, feature, value, chains, options, before),
      resolveSelection: (request: any, synthesis: any) => getSceneManager()!.resolveSelection!(scene, request, synthesis),
      featureGhost: async (ghost: any) => {
        const result = getSceneManager()!.buildFeatureGhost(scene, ghost);
        return result.ok
          ? { status: 200, solids: result.solids }
          : { status: 422, reason: result.reason, surface: result.surface === true || undefined };
      },
      featureSources: (before: any) => getSceneManager()!.resolveFeatureSources(scene, before),
    };
  }

  /** The bridge the code builds, checked to build without an error. */
  function builtBridge(code: string): Bridge {
    const built = runFluid(code);
    expect(built.getAllSceneObjects().map(obj => obj.getError()).filter(Boolean)).toEqual([]);
    return built.getAllSceneObjects().find(obj => obj instanceof Bridge)! as Bridge;
  }

  it('writes each kind of end — an edge end of a solid and of a curve, a curve end, a corner and a sketch point — and the code builds', async () => {
    const { scene, code, body, rail, pointVertex, lineEdge } = stage();
    const base = await serve(engineHost(scene, code));
    const railA = curveEndAt(6, 10, 'end');
    const cases: [string, Record<string, unknown>, string, number[][]][] = [
      [
        'an edge end of the solid to an edge end of a curve',
        { from: { kind: 'edge-end', shapeId: body.id, ...edgeEndAt(body, [40, 0, 5], [40, 0, 0]) }, to: { kind: 'edge-end', shapeId: rail.id, index: 0, end: 'start' } },
        `bridge(e.sideEdges(edge().onPlane('xz').farthest('x')).end(), a.edges().start())`,
        [[40, 0, 5], [5, 5, 5]],
      ],
      [
        'two curve ends by their statements',
        { from: railA, to: curveEndAt(8, 10, 'start'), startContinuity: 'g2', endContinuity: 'g2', startMagnitude: 1.5 },
        `bridge(a.end(), b.start()).continuity('g2').startMagnitude(1.5)`,
        [[15, 5, 5], [25, 15, 5]],
      ],
      [
        "a solid's corner, met at its position only",
        { from: railA, to: { kind: 'vertex', shapeId: body.id, index: vertexAt(body, [40, 20, 5]) }, endContinuity: 'g0' },
        `bridge(a.end(), e.sideEdges(edge().farthest('x').farthest('y')).end()).continuity('g1', 'g0')`,
        [[15, 5, 5], [40, 20, 5]],
      ],
      [
        'a sketch point, exported from its sketch',
        { from: railA, to: { kind: 'vertex', shapeId: pointVertex.id, index: 0 } },
        `bridge(a.end(), s.geometries.p1)`,
        [[15, 5, 5], [30, 2, 30]],
      ],
      [
        "a sketch line's end, by its vertex",
        { from: railA, to: { kind: 'vertex', shapeId: lineEdge.id, index: 1 } },
        `bridge(a.end(), sk3.geometries.l1.end())`,
        [[15, 5, 5], [10, 40, 40]],
      ],
    ];
    for (const [name, ends, statement, at] of cases) {
      relayed = [];
      const req = { feature: 'bridge', ...ends };
      const preview = await post(`${base}/apply-feature`, { ...req, preview: true });
      expect(preview, name).toEqual({ status: 200, body: { success: true, preview: statement } });

      expect((await post(`${base}/apply-feature`, req)).status, name).toBe(200);
      const newCode = await written(base, code);
      expect(newCode.trimEnd().endsWith(`${statement}.name('Bridge 1')`), `${name}:\n${newCode}`).toBe(true);
      const br = builtBridge(newCode);
      expect(br.getName(), name).toBe('Bridge 1');
      expect(endsOf(br.getShapes()[0] as Wire), name).toEqual(at);
    }
  });

  it('reads the statement back with its sources, then edits a magnitude and re-picks an end with the rest as written', async () => {
    const { scene, code, body, pointVertex, bridge: br } = stage(true);
    const base = await serve(engineHost(scene, code));
    const index = scene.getTimelineObjects().indexOf(br!);
    const before = { index, type: 'bridge', line: 15, column: 0 };
    const statement = `bridge(a.end(), b.start()).continuity('g2').startMagnitude(1.5)`;

    const parsed = await post(`${base}/feature/parse`, { line: 15, filePath: FILE });
    expect(parsed.body).toEqual({
      ok: true,
      parsed: {
        feature: 'bridge',
        fromText: 'a.end()',
        toText: 'b.start()',
        fromRef: null,
        toRef: null,
        startContinuity: 'g2',
        endContinuity: 'g2',
        startMagnitude: 1.5,
        endMagnitude: 1,
        startMagnitudeArg: '1.5',
        endMagnitudeArg: null,
      },
      statement,
    });

    const sources = await post(`${base}/feature/sources`, { before });
    expect(sources).toEqual({
      status: 200,
      body: {
        ok: true,
        feature: 'bridge',
        from: { kind: 'curve-end', filePath: FILE, line: 6, column: 10, end: 'end' },
        to: { kind: 'curve-end', filePath: FILE, line: 8, column: 10, end: 'start' },
      },
    });

    const magnitude = { feature: 'bridge', edit: target(15), expectedStatement: statement, before, startMagnitude: 0.5 };
    const preview = await post(`${base}/apply-feature`, { ...magnitude, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: `bridge(a.end(), b.start()).continuity('g2').startMagnitude(0.5)` } });
    expect((await post(`${base}/apply-feature`, magnitude)).status).toBe(200);
    const edited = await written(base, code);
    expect(edited).toBe(code.replace('.startMagnitude(1.5)', '.startMagnitude(0.5)'));
    expect(endsOf(builtBridge(edited).getShapes()[0] as Wire)).toEqual([[15, 5, 5], [25, 15, 5]]);

    relayed = [];
    const corner = {
      feature: 'bridge', edit: target(15), expectedStatement: statement, before,
      to: { kind: 'vertex', shapeId: body.id, index: vertexAt(body, [40, 20, 5]) }, endContinuity: 'g0',
    };
    const cornerPreview = await post(`${base}/apply-feature`, { ...corner, preview: true });
    expect(cornerPreview).toEqual({
      status: 200,
      body: { success: true, preview: `bridge(a.end(), e.sideEdges(edge().farthest('x').farthest('y')).end()).continuity('g2', 'g0').startMagnitude(1.5)` },
    });
    expect((await post(`${base}/apply-feature`, corner)).status).toBe(200);
    const repicked = await written(base, code);
    expect(repicked).toBe(code
      .replace(`from 'fluidcad/core'`, `from 'fluidcad/core'\nimport { edge } from 'fluidcad/filters';`)
      .replace(BRIDGE_LINE, `bridge(a.end(), e.sideEdges(edge().farthest('x').farthest('y')).end()).continuity('g2', 'g0').startMagnitude(1.5).name('Bridge 1')`));
    expect(endsOf(builtBridge(repicked).getShapes()[0] as Wire)).toEqual([[15, 5, 5], [40, 20, 5]]);

    relayed = [];
    const sketchPoint = {
      feature: 'bridge', edit: target(15), expectedStatement: statement, before,
      from: { kind: 'vertex', shapeId: pointVertex.id, index: 0 },
    };
    const pointPreview = await post(`${base}/apply-feature`, { ...sketchPoint, preview: true });
    expect(pointPreview).toEqual({ status: 200, body: { success: true, preview: `bridge(s.geometries.p1, b.start()).continuity('g2').startMagnitude(1.5)` } });
    expect((await post(`${base}/apply-feature`, sketchPoint)).status).toBe(200);
    const exported = await written(base, code);
    expect(exported).toContain(`bridge(s.geometries.p1, b.start()).continuity('g2').startMagnitude(1.5).name('Bridge 1')`);
    expect(endsOf(builtBridge(exported).getShapes()[0] as Wire)).toEqual([[30, 2, 30], [25, 15, 5]]);
  });

  it('previews the bridge as a wire, and says why when the engine refuses: two ends at one point', async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const corner = { kind: 'vertex', shapeId: body.id, index: vertexAt(body, [40, 20, 5]) };

    const ok = await post(`${base}/feature-ghost`, {
      feature: 'bridge', from: curveEndAt(6, 10, 'end'), to: corner, startContinuity: 'g2', endContinuity: 'g0', startMagnitude: 2, endMagnitude: 'hidden',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.solids.map((solid: { kind: string }) => solid.kind)).toEqual(['wire']);

    const onePoint = await post(`${base}/feature-ghost`, {
      feature: 'bridge', from: curveEndAt(6, 10, 'end'), to: { kind: 'edge-end', shapeId: (scene.getAllSceneObjects().find(obj => obj.getSourceLocation()?.line === 6)!).getShapes()[0].id, index: 0, end: 'end' },
    });
    expect(onePoint).toEqual({ status: 422, body: { success: false, surface: true, reason: 'bridge: the two ends are at the same point.' } });
  });
});
