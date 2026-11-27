// The projected curve — `project(source, target)` outside a sketch — written,
// read back and edited by the server: the statement from the source and
// target rows of picks and its chained options, its parse into the two pick
// lists and the options in any order, an edit of a row or an option with
// everything else kept as written, the refusals, the sketch tool that shares
// the callee, and the preview request. The transform is exercised on code
// alone; the routes on a fake server, then on a scene the real engine built.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import plane from '../../lib/core/plane.js';
import { circle, line, project } from '../../lib/core/2d/index.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { ShapeMeasure } from '../../lib/oc/shape-measure.js';
import { Edge } from '../../lib/common/edge.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Wire } from '../../lib/common/wire.js';
import { ProjectedCurve } from '../../lib/features/projected-curve.js';
import { Scene } from '../../lib/rendering/scene.js';
import {
  applyFeatureEdit,
  DIRECTION_WITH_NORMAL,
  FeatureCallees,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type DirectionSpec,
  type OperandPick,
  type ProjectedCurveEditOptions,
} from '../src/apply-feature-edit/index.ts';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { createApplyFeatureRouter } from '../src/routes/apply-feature/index.ts';
import { createFeatureGhostRouter } from '../src/routes/feature-ghost/index.ts';

const FILE = '/ws/model.fluid.js';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

type Producer = ApplyFeatureEditSpec['producers'][number];
type Part = ApplyFeatureEditSpec['parts'][number];

const solid = (line: number, column: number): Producer =>
  ({ line, column, featureType: 'extrude', nameHint: 'e', bind: true });
const curve = (line: number, column: number, nameHint = 'sk'): Producer =>
  ({ line, column, featureType: 'wire', nameHint, bind: true });
const surface = (line: number, column: number): Producer =>
  ({ line, column, featureType: 'surface', nameHint: 's', bind: true });
const datum = (featureType: 'axis' | 'plane' | 'connector', line: number, column: number): Producer =>
  ({ line, column, featureType, nameHint: featureType[0], bind: true });
/** `<producer>.<accessor>(<indices>)`. */
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices: indices.length > 0 ? indices : null, filterArgs: null });
const whole = (producer: number): OperandPick => ({ kind: 'producer', producer });
const selector = (part: number): OperandPick => ({ kind: 'selector', part });

/**
 * A cylinder (line 4), the sketch to project (line 5), a loaded surface
 * (line 6), an axis (line 7), a plane (line 8), a connector (line 9) and a
 * profile sketch (line 10).
 */
const CODE = src(
  `import { sketch, circle, line, extrude, load, plane, axis, connector } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
  `const wing = load('wing.step')`,
  `const a = axis('z')`,
  `const p = plane('xy', 40)`,
  `connector('bolt', e.endFaces().center())`,
  `sketch('yz', () => { circle([0, 10], 2) })`,
);

/** The import line once the projected curve is written into {@link CODE}. */
const IMPORTS = `import { project, sketch, circle, line, extrude, load, plane, axis, connector } from 'fluidcad/core'`;

/** A create spec over {@link CODE}: the rows' picks, then options over the defaults. */
function createSpec(
  source: OperandPick[],
  target: OperandPick[],
  producers: Producer[],
  parts: Part[] = [],
  options: Partial<Pick<ProjectedCurveEditOptions, 'mode' | 'direction' | 'keep'>> = {},
): ApplyFeatureEditSpec {
  return {
    feature: 'projected-curve',
    filePath: FILE,
    projectedCurve: { source, target, mode: 'direction', direction: null, keep: 'nearest', ...options },
    producers,
    parts,
    imports: [],
  };
}

/** An edit of the projected curve statement on `line`. */
function editSpec(
  line: number,
  projectedCurve: NonNullable<ApplyFeatureEditSpec['edit']>['projectedCurve'],
  producers: Producer[] = [],
  parts: Part[] = [],
): ApplyFeatureEditSpec {
  return {
    feature: 'projected-curve', filePath: FILE, producers, parts, imports: [],
    edit: { line, column: 0, projectedCurve },
  };
}

describe('writing a projected curve', () => {
  it('writes project(sk, e.sideFaces()) with no chain for the defaults, named and imported', async () => {
    const result = await applyFeatureEdit(CODE, createSpec([whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces')]));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      IMPORTS,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      `const sk = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
      `const wing = load('wing.step')`,
      `const a = axis('z')`,
      `const p = plane('xy', 40)`,
      `connector('bolt', e.endFaces().center())`,
      `sketch('yz', () => { circle([0, 10], 2) })`,
      `project(sk, e.sideFaces()).name('Projected Curve 1')`,
    ));
  });

  it("writes a direction and keep 'all' as .direction('z').keep('all')", async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces')],
      { direction: { kind: 'standard', axis: 'z' }, keep: 'all' },
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nproject(sk, e.sideFaces()).direction('z').keep('all').name('Projected Curve 1')\n`);
  });

  it("writes mode 'normal' as .mode('normal')", async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces')], { mode: 'normal' },
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nproject(sk, e.sideFaces()).mode('normal').name('Projected Curve 1')\n`);
  });

  it('writes every kind of direction in .direction(…)', async () => {
    const cases: { direction: DirectionSpec; extra?: Producer; part?: Part; text: string; bound?: string }[] = [
      { direction: { kind: 'standard', axis: 'x' }, text: `'x'` },
      { direction: { kind: 'standard-plane', plane: 'xz' }, text: `'xz'` },
      { direction: { kind: 'axis', producer: 2 }, extra: datum('axis', 7, 10), text: 'a' },
      { direction: { kind: 'plane', producer: 2 }, extra: datum('plane', 8, 10), text: 'p' },
      {
        direction: { kind: 'connector', producer: 2 }, extra: datum('connector', 9, 0), text: 'bolt',
        bound: `\nconst bolt = connector('bolt', e.endFaces().center())\n`,
      },
      { direction: { kind: 'connector', producer: 2, slot: 1 }, extra: datum('connector', 9, 0), text: 'bolt.instance(1)' },
      { direction: { kind: 'edge', part: 1 }, part: bucket(0, 'endEdges', 0), text: 'e.endEdges(0)' },
      { direction: { kind: 'face', part: 1 }, part: bucket(0, 'startFaces'), text: 'e.startFaces()' },
    ];
    for (const { direction, extra, part, text, bound } of cases) {
      const result = await applyFeatureEdit(CODE, createSpec(
        [whole(1)], [selector(0)],
        [solid(4, 10), curve(5, 0), ...(extra ? [extra] : [])],
        [bucket(0, 'sideFaces'), ...(part ? [part] : [])],
        { direction },
      ));
      expect(result.error, JSON.stringify(direction)).toBeUndefined();
      expect(result.newCode, JSON.stringify(direction))
        .toContain(`\nproject(sk, e.sideFaces()).direction(${text}).name('Projected Curve 1')\n`);
      if (bound) {
        expect(result.newCode).toContain(bound);
      }
    }
  });

  it('writes several picks in a row as a list, in pick order', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      [selector(1), whole(1)], [whole(2), selector(0)],
      [solid(4, 10), curve(5, 0), surface(6, 13)],
      [bucket(0, 'sideFaces'), bucket(0, 'endEdges', 0)],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nproject([e.endEdges(0), sk], [wing, e.sideFaces()]).name('Projected Curve 1')\n`);
  });

  it("refuses a direction with mode 'normal' in the engine's words, a face in the source, an edge in the target, an empty row and a part no pick writes", async () => {
    const normal = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces')],
      { mode: 'normal', direction: { kind: 'standard', axis: 'z' } },
    ));
    expect(normal.error).toBe(DIRECTION_WITH_NORMAL);
    expect(normal.error).toBe(`project: .direction() is for mode 'direction'.`);
    expect(normal.newCode).toBe(CODE);

    const faceSource = await applyFeatureEdit(CODE, createSpec(
      [selector(0)], [whole(1)], [solid(4, 10), surface(6, 13)], [bucket(0, 'sideFaces')],
    ));
    expect(faceSource.error).toBe('malformed projected curve edit spec: the source takes curves and edges, not a face');

    const edgeTarget = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideEdges')],
    ));
    expect(edgeTarget.error).toBe('malformed projected curve edit spec: the target takes surfaces and faces, not an edge');

    const empty = await applyFeatureEdit(CODE, createSpec([], [selector(0)], [solid(4, 10)], [bucket(0, 'sideFaces')]));
    expect(empty.error).toBe('project: the source is empty — pick a sketch, a curve or edges for it');

    const leftOver = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces'), bucket(0, 'endFaces')],
    ));
    expect(leftOver.error).toBe('malformed projected curve edit spec: every selector part belongs to exactly one pick or the direction');

    const badMode = await applyFeatureEdit(CODE, createSpec(
      [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces')], { mode: 'sideways' as never },
    ));
    expect(badMode.error).toBe('malformed projected curve edit spec');
  });

  it('is bound as pc when a later statement takes its edge', async () => {
    const code = CODE.replace(`sketch(plane('xz', 30)`, `const sk = sketch(plane('xz', 30)`)
      + `project(sk, e.sideFaces()).name('Projected Curve 1')\n`;
    const result = await applyFeatureEdit(code, {
      feature: 'sweep',
      filePath: FILE,
      sweep: { op: 'add', thin: null, profile: { producer: 1 }, path: { kind: 'selector' } },
      producers: [
        { line: 11, column: 0, featureType: 'projected-curve', nameHint: 'pc', bind: true },
        { line: 10, column: 0, featureType: 'sketch', nameHint: 'pr', bind: true },
      ],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst pc = project(sk, e.sideFaces()).name('Projected Curve 1')\n`);
    expect(result.newCode).toContain(`sweep(pc.edges(0), pr)`);
  });
});

/** {@link CODE} with the sketch bound as `sk` and projected curves on lines 11 to 18. */
const WRITTEN = src(
  `import { project, select, sketch, circle, line, extrude, load, plane, axis, connector } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `const sk = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
  `const wing = load('wing.step')`,
  `const a = axis('z')`,
  `const p = plane('xy', 40)`,
  `connector('bolt', e.endFaces().center())`,
  `sketch('yz', () => { circle([0, 10], 2) })`,
  `project(sk, e.sideFaces()).name('Projected Curve 1')`,
  `const pc = project([sk, e.endEdges(0)], [e.sideFaces(), wing]).mode('normal').keep('all')`,
  `project(sk, wing).direction(axis(e.endEdges(0))).keep('all').name('Projected Curve 3')`,
  `project(sk, wing).keep('all').direction('z').mode('direction')`,
  `project(sk, wing).mode(someMode)`,
  `project(sk, wing).keep('every')`,
  `project(sk)`,
  `project(sk, wing).name('P').mode('normal')`,
);

/** A parsed projected curve over {@link WRITTEN}, the defaults filled in. */
function parsedCurve(fields: Record<string, unknown>) {
  return {
    feature: 'projected-curve',
    sourceTexts: ['sk'],
    sourceRefs: [{ line: 5, column: 11 }],
    targetTexts: ['wing'],
    targetRefs: [{ line: 6, column: 13 }],
    sourceArg: 'sk',
    targetArg: 'wing',
    mode: 'direction',
    directionText: null,
    keep: 'nearest',
    ...fields,
  };
}

describe('reading a projected curve back', () => {
  it('parses the defaults: the two pick lists with the statement each variable names, and no chain', async () => {
    expect(await parseFeatureStatement(WRITTEN, 11)).toEqual({
      ok: true,
      parsed: parsedCurve({ targetTexts: ['e.sideFaces()'], targetRefs: [null], targetArg: 'e.sideFaces()' }),
      statement: 'project(sk, e.sideFaces())',
    });
  });

  it('reads a list element by element, and the mode and what is kept', async () => {
    expect(await parseFeatureStatement(WRITTEN, 12)).toEqual({
      ok: true,
      parsed: parsedCurve({
        sourceTexts: ['sk', 'e.endEdges(0)'],
        sourceRefs: [{ line: 5, column: 11 }, null],
        targetTexts: ['e.sideFaces()', 'wing'],
        targetRefs: [null, { line: 6, column: 13 }],
        sourceArg: '[sk, e.endEdges(0)]',
        targetArg: '[e.sideFaces(), wing]',
        mode: 'normal',
        keep: 'all',
      }),
      statement: `project([sk, e.endEdges(0)], [e.sideFaces(), wing]).mode('normal').keep('all')`,
    });
  });

  it('reads the chains in the order the editor writes them, the direction verbatim, and leaves a trailing name out', async () => {
    expect(await parseFeatureStatement(WRITTEN, 13)).toEqual({
      ok: true,
      parsed: parsedCurve({ directionText: 'axis(e.endEdges(0))', keep: 'all' }),
      statement: `project(sk, wing).direction(axis(e.endEdges(0))).keep('all')`,
    });
  });

  it('reads the chains in any other order, a default written out included', async () => {
    expect(await parseFeatureStatement(WRITTEN, 14)).toEqual({
      ok: true,
      parsed: parsedCurve({ directionText: `'z'`, keep: 'all' }),
      statement: `project(sk, wing).keep('all').direction('z').mode('direction')`,
    });
  });

  it('refuses a .mode() or .keep() that is not one of its words, a variable among them, for the dialog', async () => {
    expect(await parseFeatureStatement(WRITTEN, 15)).toEqual({
      ok: false,
      reason: `the .mode() argument is not 'direction' or 'normal' — edit it in the source`,
    });
    expect(await parseFeatureStatement(WRITTEN, 16)).toEqual({
      ok: false,
      reason: `the .keep() argument is not 'nearest' or 'all' — edit it in the source`,
    });
  });

  it('refuses a call that does not give the curves and the faces, and an option behind another call', async () => {
    expect(await parseFeatureStatement(WRITTEN, 17)).toEqual({
      ok: false,
      reason: 'project() outside a sketch takes the curves and the faces to project them onto as its two arguments — edit it in the source',
    });
    expect(await parseFeatureStatement(WRITTEN, 18)).toMatchObject({ ok: false, reason: expect.stringMatching(/^a \.mode\(\) chain follows/) });
    expect(await parseFeatureStatement(WRITTEN.replace(`project(sk, wing).keep('every')`, `project(sk, wing).direction()`), 16))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^the \.direction\(\) chain has an argument shape/) });
  });
});

describe('editing a projected curve', () => {
  it('changes what is kept and leaves .direction(…) and the trailing .name(…) as written', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(13, { keep: 'nearest' }));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(WRITTEN.replace(
      `project(sk, wing).direction(axis(e.endEdges(0))).keep('all').name('Projected Curve 3')`,
      `project(sk, wing).direction(axis(e.endEdges(0))).name('Projected Curve 3')`,
    ));
  });

  it('lifts a select() given to .direction() ahead of the statement, as every select() in a chained call is', async () => {
    const code = WRITTEN.replace(`.direction(axis(e.endEdges(0)))`, `.direction(select(edge().line()))`);
    const result = await applyFeatureEdit(code, editSpec(13, { keep: 'nearest' }));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst sel = select(edge().line())\nproject(sk, wing).direction(sel).name('Projected Curve 3')\n`);
  });

  it('re-picks the source alone, keeping the target as written, the options and the binding', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(12, { source: { kind: 'picks', picks: [whole(0)] } }, [curve(10, 0, 'pr')]));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst pr = sketch('yz', () => { circle([0, 10], 2) })\n`);
    expect(result.newCode).toContain(`\nconst pc = project(pr, [e.sideFaces(), wing]).mode('normal').keep('all')\n`);
  });

  it('re-picks the target and the mode, refusing a face in the source and an empty row', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(
      11, { target: { kind: 'picks', picks: [selector(0)] }, mode: 'normal' }, [solid(4, 10)], [bucket(0, 'endFaces')],
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nproject(sk, e.endFaces()).mode('normal').name('Projected Curve 1')\n`);

    const face = await applyFeatureEdit(WRITTEN, editSpec(11, { source: { kind: 'picks', picks: [selector(0)] } }, [solid(4, 10)], [bucket(0, 'endFaces')]));
    expect(face.error).toBe('malformed projected curve edit spec: the source takes curves and edges, not a face');
    expect(face.newCode).toBe(WRITTEN);

    const empty = await applyFeatureEdit(WRITTEN, editSpec(11, { target: { kind: 'picks', picks: [] } }));
    expect(empty.error).toBe('project: the target is empty — pick a surface or faces for it');
  });

  it('replaces the direction with each kind, or drops it', async () => {
    const standard = await applyFeatureEdit(WRITTEN, editSpec(14, { direction: { kind: 'standard', axis: 'x' } }));
    expect(standard.newCode).toContain(`\nproject(sk, wing).direction('x').keep('all')\n`);

    const face = await applyFeatureEdit(WRITTEN, editSpec(11, { direction: { kind: 'face', part: 0 } }, [solid(4, 10)], [bucket(0, 'startFaces')]));
    expect(face.error).toBeUndefined();
    expect(face.newCode).toContain(`\nproject(sk, e.sideFaces()).direction(e.startFaces()).name('Projected Curve 1')\n`);

    const bound = await applyFeatureEdit(WRITTEN, editSpec(11, { direction: { kind: 'plane', producer: 0 } }, [datum('plane', 8, 10)]));
    expect(bound.newCode).toContain(`\nproject(sk, e.sideFaces()).direction(p).name('Projected Curve 1')\n`);

    const cleared = await applyFeatureEdit(WRITTEN, editSpec(14, { direction: { kind: 'cleared' } }));
    expect(cleared.newCode).toContain(`\nproject(sk, wing).keep('all')\n`);
  });

  it('writes the chains in their own order and leaves a default out, whatever the statement had', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(14, {}));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(WRITTEN.replace(
      `project(sk, wing).keep('all').direction('z').mode('direction')`,
      `project(sk, wing).direction('z').keep('all')`,
    ));
  });

  it("refuses a direction left with mode 'normal', kept or new, in the engine's words, and writes the mode once it is cleared", async () => {
    const kept = await applyFeatureEdit(WRITTEN, editSpec(13, { mode: 'normal' }));
    expect(kept.error).toBe(DIRECTION_WITH_NORMAL);
    expect(kept.newCode).toBe(WRITTEN);

    const added = await applyFeatureEdit(WRITTEN, editSpec(11, { mode: 'normal', direction: { kind: 'standard', axis: 'z' } }));
    expect(added.error).toBe(DIRECTION_WITH_NORMAL);

    const cleared = await applyFeatureEdit(WRITTEN, editSpec(13, { mode: 'normal', direction: { kind: 'cleared' } }));
    expect(cleared.error).toBeUndefined();
    expect(cleared.newCode).toContain(`\nproject(sk, wing).mode('normal').keep('all').name('Projected Curve 3')\n`);
  });

  it('refuses to edit a statement whose .mode() is a variable', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(15, { keep: 'all' }));

    expect(result.error).toBe(`the .mode() argument is not 'direction' or 'normal' — edit it in the source`);
    expect(result.newCode).toBe(WRITTEN);
  });
});

/** A project() in a sketch (line 5) and one outside (line 7). */
const SKETCHED = src(
  `import { project, sketch, extrude, load } from 'fluidcad/core'`,
  ``,
  `const e = extrude(10)`,
  `sketch('xy', () => {`,
  `  project(e.endFaces())`,
  `})`,
  `project(e.endEdges(), load('wing.step'))`,
  `sketch('xz', () => {})`,
);

describe('in a sketch', () => {
  /** The statement call on `line` of {@link SKETCHED}. */
  async function callAt(line: number): Promise<TSNode> {
    const tree = (await getJavaScriptParser()).parse(SKETCHED);
    return findEditableCallAt(tree, splitLines(SKETCHED), line)!;
  }

  it('parses project(face) inside a sketch callback as the sketch tool, not this one', async () => {
    expect(await parseFeatureStatement(SKETCHED, 5)).toMatchObject({
      ok: true, parsed: { feature: 'project', op: 'project', argsText: 'e.endFaces()' },
    });
    expect(await parseFeatureStatement(SKETCHED, 7)).toMatchObject({ ok: true, parsed: { feature: 'projected-curve' } });
  });

  it('refuses an edit of the sketch tool as a projected curve', async () => {
    const result = await applyFeatureEdit(SKETCHED, editSpec(5, { keep: 'all' }));
    expect(result.error).toBe('the statement at line 5 is a project, expected a projected-curve — is the file in sync with the last render?');
  });

  it('binds a curve producer, a repeat target, a wire or a surface only to the call outside', async () => {
    const callees = FeatureCallees.BUILT_IN;
    const inside = await callAt(5);
    const outside = await callAt(7);
    for (const featureType of ['projected-curve', 'feature', 'wire', 'surface']) {
      expect(callees.binds({ featureType, line: 5 }, inside), featureType).toBe(false);
      expect(callees.binds({ featureType, line: 7 }, outside), featureType).toBe(true);
    }
    // The sketch tool's own producer type binds the call inside only.
    expect(callees.binds({ featureType: 'projection', line: 5 }, inside)).toBe(true);
    expect(callees.binds({ featureType: 'projection', line: 7 }, outside)).toBe(false);
  });

  it('refuses a stale curve producer whose line now holds the sketch tool, where it would bind .edges()', async () => {
    const stale = await applyFeatureEdit(SKETCHED, {
      feature: 'fillet',
      value: 1,
      filePath: FILE,
      producers: [{ line: 5, column: 2, featureType: 'projected-curve', nameHint: 'pc', bind: true }],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });
    expect(stale.error).toBe('the call at line 5 is project(), expected a projected-curve()-producing call');
    expect(stale.newCode).toBe(SKETCHED);
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

const statement = (line: number, column: number) => ({ kind: 'statement', filePath: FILE, line, column });

/** A create request over {@link CODE}: the sketch on line 5 onto the surface on line 6, options over the defaults. */
const request = (options: Record<string, unknown> = {}) => ({
  feature: 'projected-curve',
  source: [statement(5, 0)],
  target: [statement(6, 13)],
  mode: 'direction',
  direction: null,
  keep: 'nearest',
  ...options,
});

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
  it('writes a whole sketch onto a whole surface without synthesis, with its options, bound under their names', async () => {
    const base = await serve(fakeServer);
    const body = request({ direction: { kind: 'standard', axis: 'z' }, keep: 'all' });

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: `project(c, wing).direction('z').keep('all')` } });
    expect(relayed).toEqual([]);

    const applied = await post(`${base}/apply-feature`, body);
    expect(applied.status).toBe(200);
    expect(relayed[0].spec).toMatchObject({
      feature: 'projected-curve',
      projectedCurve: {
        source: [{ kind: 'producer', producer: 0 }],
        target: [{ kind: 'producer', producer: 1 }],
        mode: 'direction',
        direction: { kind: 'standard', axis: 'z' },
        keep: 'all',
      },
      producers: [
        { line: 5, column: 0, featureType: 'wire', nameHint: 'c', bind: true },
        { line: 6, column: 13, featureType: 'surface', nameHint: 's', bind: true },
      ],
      parts: [],
    });
    const newCode = await written(base, CODE);
    expect(newCode).toContain(`\nconst c = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })\n`);
    expect(newCode).toContain(`\nproject(c, wing).direction('z').keep('all').name('Projected Curve 1')\n`);
  });

  it("writes the defaults with no chain and mode 'normal' as .mode('normal')", async () => {
    const base = await serve(fakeServer);
    expect((await post(`${base}/apply-feature`, { ...request(), preview: true })).body.preview).toBe('project(c, wing)');
    expect((await post(`${base}/apply-feature`, { ...request({ mode: 'normal' }), preview: true })).body.preview)
      .toBe(`project(c, wing).mode('normal')`);
    // Left out, the options read as their defaults.
    const bare = { feature: 'projected-curve', source: [statement(5, 0)], target: [statement(6, 13)], preview: true };
    expect((await post(`${base}/apply-feature`, bare)).body.preview).toBe('project(c, wing)');
  });

  it('takes every direction the dialog sends by statement or literal, binding the statement', async () => {
    const base = await serve(fakeServer);
    const cases: [unknown, string][] = [
      [{ kind: 'standard', axis: 'y' }, `'y'`],
      [{ kind: 'standard-plane', plane: 'xy' }, `'xy'`],
      [{ kind: 'axis', filePath: FILE, line: 7, column: 10 }, 'a'],
      [{ kind: 'plane', filePath: FILE, line: 8, column: 10 }, 'p'],
      [{ kind: 'connector', filePath: FILE, line: 9, column: 0 }, 'bolt'],
      [{ kind: 'connector', filePath: FILE, line: 9, column: 0, slot: 2 }, 'bolt.instance(2)'],
    ];
    for (const [direction, text] of cases) {
      const preview = await post(`${base}/apply-feature`, { ...request({ direction }), preview: true });
      expect(preview, JSON.stringify(direction)).toEqual({ status: 200, body: { success: true, preview: `project(c, wing).direction(${text})` } });
    }

    expect((await post(`${base}/apply-feature`, request({ direction: { kind: 'plane', filePath: FILE, line: 8, column: 10 } }))).status).toBe(200);
    expect(relayed[0].spec.projectedCurve.direction).toEqual({ kind: 'plane', producer: 2 });
    expect(relayed[0].spec.producers[2]).toEqual({ line: 8, column: 10, featureType: 'plane', nameHint: 'p', bind: true });
    expect(await written(base, CODE)).toContain(`\nproject(c, wing).direction(p).name('Projected Curve 1')\n`);
  });

  it("refuses a direction with mode 'normal' in the engine's words, and malformed rows, options and directions", async () => {
    const base = await serve(fakeServer);
    const refusals: [Record<string, unknown>, string | RegExp][] = [
      [request({ mode: 'normal', direction: { kind: 'standard', axis: 'z' } }), `project: .direction() is for mode 'direction'.`],
      [request({ source: [{ kind: 'face', shapeId: 's1', index: 0 }] }), 'source takes curves and edges, not a face'],
      [request({ target: [{ kind: 'edge', shapeId: 's1', index: 0 }] }), 'target takes surfaces and faces, not an edge'],
      [request({ target: [] }), /^target must be a non-empty list of picks/],
      [request({ mode: 'sideways' }), 'mode must be "direction" or "normal"'],
      [request({ keep: 'every' }), 'keep must be "nearest" or "all"'],
      [request({ direction: { kind: 'diagonal' } }), /^direction must be \{kind:/],
      [request({ direction: { kind: 'face', entity: { shapeId: 's1', sub: { type: 'edge', index: 0 } } } }), /^the direction's face must carry/],
    ];
    for (const [body, error] of refusals) {
      const result = await post(`${base}/apply-feature`, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      if (typeof error === 'string') {
        expect(result.body).toEqual({ error });
      } else {
        expect(result.body.error).toMatch(error);
      }
    }
    expect(relayed).toEqual([]);
  });

  it('edits what is kept alone without a boundary, leaving the direction and the name as written', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const body = {
      feature: 'projected-curve',
      edit: { filePath: FILE, line: 13, column: 0 },
      expectedStatement: `project(sk, wing).direction(axis(e.endEdges(0))).keep('all')`,
      keep: 'nearest',
    };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'project(sk, wing).direction(axis(e.endEdges(0)))' } });

    expect((await post(`${base}/apply-feature`, body)).status).toBe(200);
    expect(relayed[0].spec.edit.projectedCurve).toEqual({ keep: 'nearest' });
    expect(await written(base, WRITTEN)).toBe(WRITTEN.replace(
      `.keep('all').name('Projected Curve 3')`,
      `.name('Projected Curve 3')`,
    ));
  });

  it('re-picks a row and the direction by statement, and clears a direction', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const body = {
      feature: 'projected-curve',
      edit: { filePath: FILE, line: 11, column: 0 },
      target: [statement(6, 13)],
      direction: { kind: 'axis', filePath: FILE, line: 7, column: 10 },
    };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'project(sk, wing).direction(a)' } });

    expect((await post(`${base}/apply-feature`, body)).status).toBe(200);
    expect(relayed[0].spec.edit.projectedCurve).toEqual({
      target: { kind: 'picks', picks: [{ kind: 'producer', producer: 0 }] },
      direction: { kind: 'axis', producer: 1 },
    });
    expect(await written(base, WRITTEN)).toContain(`\nproject(sk, wing).direction(a).name('Projected Curve 1')\n`);

    const cleared = await post(`${base}/apply-feature`, {
      feature: 'projected-curve', edit: { filePath: FILE, line: 14, column: 0 }, direction: { kind: 'cleared' }, preview: true,
    });
    expect(cleared).toEqual({ status: 200, body: { success: true, preview: `project(sk, wing).keep('all')` } });
  });

  it("refuses mode 'normal' with a new direction or a kept one, asks a boundary of re-picked geometry, and refuses a .mode(variable) statement", async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const edit = (line: number) => ({ filePath: FILE, line, column: 0 });

    const added = await post(`${base}/apply-feature`, {
      feature: 'projected-curve', edit: edit(11), mode: 'normal', direction: { kind: 'standard', axis: 'z' },
    });
    expect(added).toEqual({ status: 400, body: { error: `project: .direction() is for mode 'direction'.` } });

    const kept = await post(`${base}/apply-feature`, { feature: 'projected-curve', edit: edit(13), mode: 'normal' });
    expect(kept).toEqual({ status: 422, body: { success: false, reason: `project: .direction() is for mode 'direction'.` } });

    for (const repick of [
      { source: [{ kind: 'edge', shapeId: 's1', index: 2 }] },
      { direction: { kind: 'face', entity: { shapeId: 's1', sub: { type: 'face', index: 2 } } } },
      { direction: { kind: 'edge', entity: { shapeId: 's1', sub: { type: 'edge', index: 0 } } } },
    ]) {
      const unbounded = await post(`${base}/apply-feature`, { feature: 'projected-curve', edit: edit(11), ...repick });
      expect(unbounded, JSON.stringify(repick)).toEqual({ status: 400, body: { error: 'before is required when an edit re-picks geometry' } });
    }

    const variable = await post(`${base}/apply-feature`, { feature: 'projected-curve', edit: edit(15), keep: 'all' });
    expect(variable).toEqual({
      status: 422, body: { success: false, reason: `the .mode() argument is not 'direction' or 'normal' — edit it in the source` },
    });
    const parsed = await post(`${base}/feature/parse`, { line: 15, filePath: FILE });
    expect(parsed).toEqual({ status: 422, body: { error: `the .mode() argument is not 'direction' or 'normal' — edit it in the source` } });
    expect(relayed).toEqual([]);
  });

  it('hands the preview both rows in pick order, the options and the direction, with no op', async () => {
    const base = await serve(fakeServer);
    const result = await post(`${base}/feature-ghost`, {
      feature: 'projected-curve',
      source: [{ kind: 'edge', shapeId: 's1', index: 2 }, statement(5, 0)],
      target: [statement(6, 13)],
      mode: 'direction',
      direction: { kind: 'plane', filePath: FILE, line: 8 },
      keep: 'all',
    });
    expect(result).toEqual({ status: 200, body: { success: true, solids: [{ kind: 'wire', meshes: [] }] } });
    expect(received).toEqual({
      feature: 'projected-curve',
      source: [{ kind: 'edge', shapeId: 's1', index: 2 }, { kind: 'statement', filePath: FILE, line: 5 }],
      target: [{ kind: 'statement', filePath: FILE, line: 6 }],
      mode: 'direction',
      direction: { kind: 'plane', filePath: FILE, line: 8 },
      keep: 'all',
    });

    await post(`${base}/feature-ghost`, {
      feature: 'projected-curve', source: [statement(5, 0)], target: [statement(6, 13)], mode: 'normal', direction: null, keep: 'nearest',
    });
    expect(received).toMatchObject({ mode: 'normal', direction: null, keep: 'nearest' });
  });

  it('refuses a preview with an empty row, a pick of the wrong kind, a bad option or a bad direction', async () => {
    const base = await serve(fakeServer);
    const ghost = (fields: Record<string, unknown>) => ({
      feature: 'projected-curve', source: [statement(5, 0)], target: [statement(6, 13)], mode: 'direction', direction: null, keep: 'nearest', ...fields,
    });
    for (const [body, reason] of [
      [ghost({ source: [] }), 'Invalid projection selections'],
      [ghost({ target: undefined }), 'Invalid projection selections'],
      [ghost({ source: [{ kind: 'face', shapeId: 's1', index: 0 }] }), 'Invalid projection selections'],
      [ghost({ target: [{ kind: 'edge', shapeId: 's1', index: 0 }] }), 'Invalid projection selections'],
      [ghost({ mode: 'sideways' }), 'Invalid projection options'],
      [ghost({ keep: undefined }), 'Invalid projection options'],
      [ghost({ direction: { kind: 'diagonal' } }), 'Invalid direction reference'],
    ] as const) {
      expect(await post(`${base}/feature-ghost`, body), JSON.stringify(body)).toEqual({ status: 400, body: { success: false, reason } });
    }
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

/** The index among the body's faces of the cap whose edges all lie at height `z`. */
function capAt(body: Shape, z: number): number {
  return Explorer.findFacesWrapped(body).findIndex(f =>
    f.getEdges().every((edge: Edge) => Math.abs(EdgeOps.getEdgeMidPoint(edge).z - z) < 1e-6));
}

/** The index among the body's edges of the cylinder's seam: the one straight edge, upright. */
function seamOf(body: Shape): number {
  return Explorer.findEdgesWrapped(body).findIndex(edge => {
    const [a, b] = EdgeOps.endPoints(edge);
    return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) > 1e-6;
  });
}

/** The heights of a projected curve's wires, each wire's two ends at one height. */
function wireHeights(obj: SceneObject): number[] {
  return (obj.getShapes() as Wire[]).map(wire => {
    const [first, last] = [wire.getFirstPoint()!, wire.getLastPoint()!];
    expect(Math.abs(first.z - last.z)).toBeLessThan(1e-6);
    return +first.z.toFixed(6) + 0;
  }).sort((a, b) => a - b);
}

describe('through the real engine', () => {
  setupOC();

  /**
   * A Ø20 cylinder 20 tall (line 4) and a sketch over it at height 30 with
   * a diagonal line (line 5), bound as `sk` with `withCurve` — and then the
   * projected curve of the sketch onto the top cap along 'z' on line 6.
   */
  function stage(withCurve = false): { scene: Scene; code: string; body: Shape; curve: ProjectedCurve | null } {
    sketch('xy', () => {
      circle([0, 0], 20);
    });
    const e = located(extrude(20), 4, 10);
    const sk = located(sketch(plane('xy', 30), () => {
      line([-5, -5], [5, 5]);
    }), 5, withCurve ? 11 : 0);
    const curve = withCurve
      ? located((project(sk as never, (e as any).endFaces()) as unknown as ProjectedCurve).direction('z'), 6, 0)
      : null;
    const scene = render();
    const code = src(
      `import { project, sketch, circle, line, extrude, plane } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      `${withCurve ? 'const sk = ' : ''}sketch(plane('xy', 30), () => { line([-5, -5], [5, 5]) })`,
      ...(withCurve ? [`project(sk, e.endFaces()).direction('z').name('Projected Curve 1')`] : []),
    );
    const body = (e as unknown as SceneObject).getShapes().find(shape => shape.isSolid())!;
    return { scene, code, body, curve };
  }

  /** The fake server's half that reads the scene: synthesis, preview and sources from the engine. */
  function engineHost(scene: Scene, code: string) {
    currentCode = code;
    return {
      ...fakeServer,
      synthesizeApplyFeature: (refs: any, feature: any, value: any, chains: any, options: any, before: any) =>
        getSceneManager()!.synthesizeApplyFeature(scene, refs, feature, value, chains, options, before),
      featureGhost: async (request: any) => {
        const result = getSceneManager()!.buildFeatureGhost(scene, request);
        return result.ok
          ? { status: 200, solids: result.solids }
          : { status: 422, reason: result.reason, surface: result.surface === true || undefined };
      },
      featureSources: (before: any) => getSceneManager()!.resolveFeatureSources(scene, before),
    };
  }

  /** The projected curve the code builds, checked to build without an error. */
  function builtCurve(code: string): ProjectedCurve {
    const built = runFluid(code);
    expect(built.getAllSceneObjects().map(obj => obj.getError()).filter(Boolean)).toEqual([]);
    return built.getAllSceneObjects().find(obj => obj instanceof ProjectedCurve)! as ProjectedCurve;
  }

  it('writes a whole sketch onto a picked cap with the defaults, and the curve lands on the cap', async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const req = request({ target: [{ kind: 'face', shapeId: body.id, index: capAt(body, 20) }] });

    const preview = await post(`${base}/apply-feature`, { ...req, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'project(c, e.endFaces())' } });

    expect((await post(`${base}/apply-feature`, req)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(
      `${code.replace(`sketch(plane('xy', 30)`, `const c = sketch(plane('xy', 30)`)}project(c, e.endFaces()).name('Projected Curve 1')\n`,
    );

    const pc = builtCurve(newCode);
    expect(pc.getName()).toBe('Projected Curve 1');
    expect(wireHeights(pc)).toEqual([20]);
    expect(ShapeMeasure.size(pc.getShapes()[0])).toBeCloseTo(Math.hypot(10, 10), 6);
  });

  it("writes both caps with a picked face as the direction and keep 'all', and the curve lands on each", async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const [top, bottom] = [capAt(body, 20), capAt(body, 0)];
    const req = request({
      target: [{ kind: 'face', shapeId: body.id, index: top }, { kind: 'face', shapeId: body.id, index: bottom }],
      direction: { kind: 'face', entity: { shapeId: body.id, sub: { type: 'face', index: bottom } } },
      keep: 'all',
    });

    const preview = await post(`${base}/apply-feature`, { ...req, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toMatch(/^project\(c, \[e\.(end|start)Faces\(\), e\.(end|start)Faces\(\)\]\)\.direction\(e\.startFaces\(\)\)\.keep\('all'\)$/);

    expect((await post(`${base}/apply-feature`, req)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toContain(`\n${preview.body.preview}.name('Projected Curve 1')\n`);
    expect(wireHeights(builtCurve(newCode))).toEqual([0, 20]);
  });

  it('reads the statement back from the scene, then re-picks its target and its direction as faces and keeps every image', async () => {
    const { scene, code, body, curve } = stage(true);
    const base = await serve(engineHost(scene, code));
    const index = scene.getTimelineObjects().indexOf(curve!);
    const before = { index, type: 'projected-curve', line: 6, column: 0 };

    const parsed = await post(`${base}/feature/parse`, { line: 6, filePath: FILE });
    expect(parsed.body).toMatchObject({
      ok: true,
      parsed: {
        feature: 'projected-curve',
        sourceTexts: ['sk'],
        sourceRefs: [{ line: 5, column: 11 }],
        targetTexts: ['e.endFaces()'],
        mode: 'direction',
        directionText: `'z'`,
        keep: 'nearest',
      },
      statement: `project(sk, e.endFaces()).direction('z')`,
    });

    const sources = await post(`${base}/feature/sources`, { before });
    expect(sources.status).toBe(200);
    expect(sources.body).toEqual({
      ok: true,
      feature: 'projected-curve',
      source: [{ kind: 'sketch', filePath: FILE, line: 5, column: 11 }],
      target: [{ kind: 'entities', entities: [{ shapeId: body.id, sub: { type: 'face', index: capAt(body, 20) } }] }],
      direction: { kind: 'opaque' },
    });

    const [top, bottom] = [capAt(body, 20), capAt(body, 0)];
    const edit = {
      feature: 'projected-curve',
      edit: { filePath: FILE, line: 6, column: 0 },
      expectedStatement: `project(sk, e.endFaces()).direction('z')`,
      before,
      target: [{ kind: 'face', shapeId: body.id, index: top }, { kind: 'face', shapeId: body.id, index: bottom }],
      direction: { kind: 'face', entity: { shapeId: body.id, sub: { type: 'face', index: bottom } } },
      keep: 'all',
    };
    const preview = await post(`${base}/apply-feature`, { ...edit, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toMatch(/^project\(sk, \[e\.(end|start)Faces\(\), e\.(end|start)Faces\(\)\]\)\.direction\(e\.startFaces\(\)\)\.keep\('all'\)$/);

    expect((await post(`${base}/apply-feature`, edit)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(code.replace(
      `project(sk, e.endFaces()).direction('z').name('Projected Curve 1')`,
      `${preview.body.preview}.name('Projected Curve 1')`,
    ));
    expect(wireHeights(builtCurve(newCode))).toEqual([0, 20]);
  });

  it('refuses a picked edge synthesis cannot name as the direction, in the synthesis words, before anything is written', async () => {
    const { scene, code, body, curve } = stage(true);
    const base = await serve(engineHost(scene, code));
    const before = { index: scene.getTimelineObjects().indexOf(curve!), type: 'projected-curve', line: 6, column: 0 };

    const seam = await post(`${base}/apply-feature`, {
      feature: 'projected-curve',
      edit: { filePath: FILE, line: 6, column: 0 },
      before,
      direction: { kind: 'edge', entity: { shapeId: body.id, sub: { type: 'edge', index: seamOf(body) } } },
    });
    expect(seam.status).toBe(422);
    expect(seam.body).toMatchObject({ success: false, reason: expect.stringMatching(/^no geometric filter distinguishes the picked edges/) });
    expect(relayed).toEqual([]);
  });

  it("previews the curve as a wire, and says why when the engine refuses: a direction with mode 'normal', a miss", async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const ghost = (fields: Record<string, unknown>) => ({
      feature: 'projected-curve',
      source: [{ kind: 'statement', filePath: FILE, line: 5 }],
      target: [{ kind: 'face', shapeId: body.id, index: capAt(body, 20) }],
      mode: 'direction',
      direction: null,
      keep: 'nearest',
      ...fields,
    });

    const ok = await post(`${base}/feature-ghost`, ghost({}));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.solids.map((solid: { kind: string }) => solid.kind)).toEqual(['wire']);

    const normal = await post(`${base}/feature-ghost`, ghost({ mode: 'normal', direction: { kind: 'standard', axis: 'z' } }));
    expect(normal).toEqual({ status: 422, body: { success: false, surface: true, reason: `project: .direction() is for mode 'direction'.` } });

    const misses = await post(`${base}/feature-ghost`, ghost({ direction: { kind: 'standard', axis: 'x' } }));
    expect(misses.status).toBe(422);
    expect(misses.body).toMatchObject({ success: false, surface: true, reason: 'project: the projection misses the target.' });
  });
});
