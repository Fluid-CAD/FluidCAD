// The offset curve — `offset(distance, edges, { on: faces })` outside a
// sketch — written, read back and edited by the server: the statement from
// its distance and its edges and `{ on }` rows of picks, its parse into the
// distance and the two pick lists, an edit of the distance or a row with
// everything else kept as written, the refusals, the two other forms that
// share the callee (the sketch tool, the face outline) left as they were in
// kind, binding and naming, and the preview request. The transform is
// exercised on code alone; the routes on a fake server, then on a scene the
// real engine built.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import { circle, offset } from '../../lib/core/2d/index.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { ShapeMeasure } from '../../lib/oc/shape-measure.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Wire } from '../../lib/common/wire.js';
import { OffsetCurve } from '../../lib/features/offset-curve.js';
import { Scene } from '../../lib/rendering/scene.js';
import {
  applyFeatureEdit,
  editableKindOf,
  FeatureCallees,
  parseFeatureStatement,
  placementOf,
  ZERO_OFFSET_DISTANCE,
  type ApplyFeatureEditSpec,
  type OperandPick,
} from '../src/apply-feature-edit/index.ts';
import { decomposeChain } from '../src/apply-feature-edit/ast/chain.ts';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { FeatureNames } from '../src/feature-names.ts';
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
/** `<producer>.<accessor>(<indices>)`. */
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices: indices.length > 0 ? indices : null, filterArgs: null });
const whole = (producer: number): OperandPick => ({ kind: 'producer', producer });
const selector = (part: number): OperandPick => ({ kind: 'selector', part });

/**
 * A cylinder (line 4), a sketch to offset (line 5), a loaded surface
 * (line 6), a parameter (line 7) and a profile sketch (line 8).
 */
const CODE = src(
  `import { sketch, circle, line, extrude, load, plane, param } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
  `const wing = load('wing.step')`,
  `const gap = param('Gap', 2)`,
  `sketch('yz', () => { circle([0, 10], 2) })`,
);

/** The import line once the offset curve is written into {@link CODE}. */
const IMPORTS = `import { offset, sketch, circle, line, extrude, load, plane, param } from 'fluidcad/core'`;

/** A create spec over {@link CODE}: the distance and the rows' picks. */
function createSpec(
  distance: ApplyFeatureEditSpec['value'],
  edges: OperandPick[],
  on: OperandPick[],
  producers: Producer[],
  parts: Part[] = [],
): ApplyFeatureEditSpec {
  return {
    feature: 'offset-curve',
    filePath: FILE,
    offsetCurve: { distance: distance!, edges, on },
    producers,
    parts,
    imports: [],
  };
}

/** An edit of the offset curve statement on `line`. */
function editSpec(
  line: number,
  offsetCurve: NonNullable<ApplyFeatureEditSpec['edit']>['offsetCurve'],
  producers: Producer[] = [],
  parts: Part[] = [],
): ApplyFeatureEditSpec {
  return {
    feature: 'offset-curve', filePath: FILE, producers, parts, imports: [],
    edit: { line, column: 0, offsetCurve },
  };
}

describe('writing an offset curve', () => {
  it('writes offset(3, e.endEdges(), { on: e.sideFaces() }) for one pick per row, named and imported', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      3, [selector(0)], [selector(1)], [solid(4, 10)], [bucket(0, 'endEdges'), bucket(0, 'sideFaces')],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      IMPORTS,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      `sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
      `const wing = load('wing.step')`,
      `const gap = param('Gap', 2)`,
      `sketch('yz', () => { circle([0, 10], 2) })`,
      `offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
    ));
  });

  it('writes several picks in a row as a list, in pick order, whole curves and surfaces by their variables', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      -1.5, [selector(0), whole(1)], [whole(2), selector(1)],
      [solid(4, 10), curve(5, 0), surface(6, 13)],
      [bucket(0, 'endEdges', 0), bucket(0, 'sideFaces')],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst sk = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })\n`);
    expect(result.newCode).toContain(`\noffset(-1.5, [e.endEdges(0), sk], { on: [wing, e.sideFaces()] }).name('Offset Curve 1')\n`);
  });

  it('writes a parameter or an expression as the distance, as written', async () => {
    for (const distance of ['gap', 'gap / 2']) {
      const result = await applyFeatureEdit(CODE, createSpec(distance, [whole(0)], [whole(1)], [curve(5, 0), surface(6, 13)]));
      expect(result.error, distance).toBeUndefined();
      expect(result.newCode).toContain(`\noffset(${distance}, sk, { on: wing }).name('Offset Curve 1')\n`);
    }
  });

  it('numbers its name past the offset curves the file already names', async () => {
    const code = CODE + `offset(1, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 4')\n`;
    const result = await applyFeatureEdit(code, createSpec(2, [whole(0)], [whole(1)], [curve(5, 0), surface(6, 13)]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\noffset(2, sk, { on: wing }).name('Offset Curve 5')\n`);
  });

  it("refuses a literal zero distance in the engine's words before anything is written", async () => {
    for (const distance of [0, '0', ' -0.0 ']) {
      const result = await applyFeatureEdit(CODE, createSpec(distance, [whole(0)], [whole(1)], [curve(5, 0), surface(6, 13)]));
      expect(result.error, JSON.stringify(distance)).toBe(ZERO_OFFSET_DISTANCE);
      expect(result.error).toBe('offset: the distance is zero.');
      expect(result.newCode).toBe(CODE);
    }
  });

  it('refuses a face among the edges, an edge in { on }, an empty row, a bad distance and a part no pick writes', async () => {
    const face = await applyFeatureEdit(CODE, createSpec(2, [selector(0)], [whole(1)], [solid(4, 10), surface(6, 13)], [bucket(0, 'sideFaces')]));
    expect(face.error).toBe('malformed offset curve edit spec: the edges row takes curves and edges, not a face');

    const edge = await applyFeatureEdit(CODE, createSpec(2, [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'endEdges')]));
    expect(edge.error).toBe('malformed offset curve edit spec: { on } takes surfaces and faces, not an edge');

    const emptyEdges = await applyFeatureEdit(CODE, createSpec(2, [], [whole(0)], [surface(6, 13)]));
    expect(emptyEdges.error).toBe('offset: the edges row is empty — pick a sketch, a curve or edges for it');
    const emptyOn = await applyFeatureEdit(CODE, createSpec(2, [whole(0)], [], [curve(5, 0)]));
    expect(emptyOn.error).toBe('offset: { on } is empty — pick the faces the curve lies on for it');

    const bad = await applyFeatureEdit(CODE, createSpec(Number.NaN, [whole(0)], [whole(1)], [curve(5, 0), surface(6, 13)]));
    expect(bad.error).toBe('malformed offset curve edit spec: distance must be a number or expression');

    const leftOver = await applyFeatureEdit(CODE, createSpec(
      2, [whole(1)], [selector(0)], [solid(4, 10), curve(5, 0)], [bucket(0, 'sideFaces'), bucket(0, 'endFaces')],
    ));
    expect(leftOver.error).toBe('malformed offset curve edit spec: every selector part belongs to exactly one pick');
  });

  it('is bound as oc when a later statement takes its edge', async () => {
    const code = CODE + `offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')\n`;
    const result = await applyFeatureEdit(code, {
      feature: 'sweep',
      filePath: FILE,
      sweep: { op: 'add', thin: null, profile: { producer: 1 }, path: { kind: 'selector' } },
      producers: [
        { line: 9, column: 0, featureType: 'offset-curve', nameHint: 'oc', bind: true },
        { line: 8, column: 0, featureType: 'sketch', nameHint: 'pr', bind: true },
      ],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst oc = offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')\n`);
    expect(result.newCode).toContain(`sweep(oc.edges(0), pr)`);
  });
});

/** {@link CODE} with the sketch bound as `rail`, a surface bound as `on`, and offset curves from line 10 on. */
const WRITTEN = src(
  `import { offset, sketch, circle, line, extrude, load, plane, param } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `const rail = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })`,
  `const wing = load('wing.step')`,
  `const gap = param('Gap', 2)`,
  `sketch('yz', () => { circle([0, 10], 2) })`,
  `const on = load('skin.step')`,
  `offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
  `const oc = offset(-1.50, [rail, e.endEdges(0)], { on: [e.sideFaces(), wing] })`,
  `offset(gap, rail, { on })`,
  `offset(2, rail, {})`,
  `offset(2, rail, { on: wing, extend: true })`,
  `offset(2, rail, { [key]: wing })`,
  `offset(2, ...rails, { on: wing })`,
  `offset(2, { on: wing })`,
  `offset(0, rail, { on: wing }).name('Offset Curve 9')`,
  `offset(2, rail, { ...options })`,
);

/** A parsed offset curve over {@link WRITTEN}, the rail on the wing filled in. */
function parsedCurve(fields: Record<string, unknown>) {
  return {
    feature: 'offset-curve',
    distance: 2,
    distanceArg: '2',
    edgesTexts: ['rail'],
    edgesRefs: [{ line: 5, column: 13 }],
    onTexts: ['wing'],
    onRefs: [{ line: 6, column: 13 }],
    edgesArg: 'rail',
    onArg: 'wing',
    ...fields,
  };
}

describe('reading an offset curve back', () => {
  it('parses a statement with { on } as an offset curve: the distance and the two pick lists, the name left out', async () => {
    expect(await parseFeatureStatement(WRITTEN, 10)).toEqual({
      ok: true,
      parsed: parsedCurve({
        distance: 3,
        distanceArg: '3',
        edgesTexts: ['e.endEdges()'],
        edgesRefs: [null],
        onTexts: ['e.sideFaces()'],
        onRefs: [null],
        edgesArg: 'e.endEdges()',
        onArg: 'e.sideFaces()',
      }),
      statement: 'offset(3, e.endEdges(), { on: e.sideFaces() })',
    });
  });

  it('reads a list element by element, with the statement each variable names, and the distance as written', async () => {
    expect(await parseFeatureStatement(WRITTEN, 11)).toEqual({
      ok: true,
      parsed: parsedCurve({
        distance: -1.5,
        distanceArg: '-1.50',
        edgesTexts: ['rail', 'e.endEdges(0)'],
        edgesRefs: [{ line: 5, column: 13 }, null],
        onTexts: ['e.sideFaces()', 'wing'],
        onRefs: [null, { line: 6, column: 13 }],
        edgesArg: '[rail, e.endEdges(0)]',
        onArg: '[e.sideFaces(), wing]',
      }),
      statement: 'offset(-1.50, [rail, e.endEdges(0)], { on: [e.sideFaces(), wing] })',
    });
  });

  it('reads a shorthand { on } as the variable it names, and a parameter as the distance', async () => {
    expect(await parseFeatureStatement(WRITTEN, 12)).toEqual({
      ok: true,
      parsed: parsedCurve({
        distance: 'gap',
        distanceArg: 'gap',
        onTexts: ['on'],
        onRefs: [{ line: 9, column: 11 }],
        onArg: 'on',
      }),
      statement: 'offset(gap, rail, { on })',
    });
  });

  it('refuses an options object with no on, another key, a computed key or a spread, for the dialog', async () => {
    for (const line of [13, 14, 15, 19]) {
      expect(await parseFeatureStatement(WRITTEN, line), `line ${line}`).toEqual({
        ok: false,
        reason: 'offset: the only option is { on: faces } — edit it in the source',
      });
    }
  });

  it('refuses a call that is not the distance, the edges and { on }: a spread, a missing argument', async () => {
    for (const line of [16, 17]) {
      expect(await parseFeatureStatement(WRITTEN, line), `line ${line}`).toEqual({
        ok: false,
        reason: 'offset() with { on } takes the distance, the edges and { on: faces } as its three arguments — edit it in the source',
      });
    }
  });
});

describe('editing an offset curve', () => {
  it('changes the distance and leaves both rows and the trailing .name(…) as written', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(10, { distance: 4 }));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(WRITTEN.replace(
      `offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
      `offset(4, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
    ));
  });

  it('writes a parameter or an expression as the new distance, keeping the binding', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(11, { distance: '-gap' }));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst oc = offset(-gap, [rail, e.endEdges(0)], { on: [e.sideFaces(), wing] })\n`);
  });

  it('re-picks the edges alone, leaving { on } and the distance as written', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(11, { edges: { kind: 'picks', picks: [whole(0)] } }, [curve(8, 0, 'pr')]));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst pr = sketch('yz', () => { circle([0, 10], 2) })\n`);
    expect(result.newCode).toContain(`\nconst oc = offset(-1.50, pr, { on: [e.sideFaces(), wing] })\n`);
  });

  it('re-picks { on } alone, leaving the edges and the distance as written, and keeps a shorthand { on } kept', async () => {
    const onRow = await applyFeatureEdit(WRITTEN, editSpec(
      10, { on: { kind: 'picks', picks: [selector(0)] } }, [solid(4, 10)], [bucket(0, 'endFaces')],
    ));
    expect(onRow.error).toBeUndefined();
    expect(onRow.newCode).toContain(`\noffset(3, e.endEdges(), { on: e.endFaces() }).name('Offset Curve 1')\n`);

    const shorthand = await applyFeatureEdit(WRITTEN, editSpec(12, { edges: { kind: 'picks', picks: [whole(0)] } }, [curve(8, 0, 'pr')]));
    expect(shorthand.error).toBeUndefined();
    expect(shorthand.newCode).toContain(`\noffset(gap, pr, { on })\n`);
  });

  it("refuses a zero distance, new or kept, in the engine's words", async () => {
    const added = await applyFeatureEdit(WRITTEN, editSpec(10, { distance: 0 }));
    expect(added.error).toBe(ZERO_OFFSET_DISTANCE);
    expect(added.newCode).toBe(WRITTEN);

    const kept = await applyFeatureEdit(WRITTEN, editSpec(18, { on: { kind: 'picks', picks: [whole(0)] } }, [surface(6, 13)]));
    expect(kept.error).toBe(ZERO_OFFSET_DISTANCE);

    const fixed = await applyFeatureEdit(WRITTEN, editSpec(18, { distance: 1 }));
    expect(fixed.error).toBeUndefined();
    expect(fixed.newCode).toContain(`\noffset(1, rail, { on: wing }).name('Offset Curve 9')\n`);
  });

  it('refuses a face among the edges, an empty row, and a statement the dialog cannot show', async () => {
    const face = await applyFeatureEdit(WRITTEN, editSpec(10, { edges: { kind: 'picks', picks: [selector(0)] } }, [solid(4, 10)], [bucket(0, 'endFaces')]));
    expect(face.error).toBe('malformed offset curve edit spec: the edges row takes curves and edges, not a face');
    expect(face.newCode).toBe(WRITTEN);

    const empty = await applyFeatureEdit(WRITTEN, editSpec(10, { on: { kind: 'picks', picks: [] } }));
    expect(empty.error).toBe('offset: { on } is empty — pick the faces the curve lies on for it');

    const extended = await applyFeatureEdit(WRITTEN, editSpec(14, { distance: 3 }));
    expect(extended.error).toBe('offset: the only option is { on: faces } — edit it in the source');
    expect(extended.newCode).toBe(WRITTEN);
  });
});

/**
 * An offset in a sketch (line 5), the face outline outside one (line 7), an
 * offset curve (line 8), the outline with no target (line 9) and an
 * extrude of the outline (line 10).
 */
const FORMS = src(
  `import { offset, sketch, rect, extrude } from 'fluidcad/core'`,
  ``,
  `const e = extrude(10)`,
  `sketch('xy', () => {`,
  `  offset(2, e.endFaces())`,
  `})`,
  `offset(2, e.endFaces())`,
  `offset(3, e.endEdges(), { on: e.sideFaces() })`,
  `offset(1)`,
  `extrude(5)`,
);

describe('the forms of offset', () => {
  /** The statement call on `line` of {@link FORMS}. */
  async function callAt(line: number): Promise<TSNode> {
    const tree = (await getJavaScriptParser()).parse(FORMS);
    return findEditableCallAt(tree, splitLines(FORMS), line)!;
  }

  it('reads offset(…) with a trailing object outside a sketch as the offset curve, and the other two forms as before', async () => {
    const kinds: (string | null)[] = [];
    const placements: (string | null)[] = [];
    for (const line of [5, 7, 8, 9]) {
      const call = await callAt(line);
      const chain = decomposeChain(call)!;
      kinds.push(editableKindOf(chain, call));
      placements.push(placementOf(chain, call));
    }
    expect(kinds).toEqual(['offset', 'offset', 'offset-curve', 'offset']);
    // The outline outside a sketch keeps no placement, binding as it did.
    expect(placements).toEqual(['sketch', null, 'part', null]);

    expect(await parseFeatureStatement(FORMS, 5)).toMatchObject({ ok: true, parsed: { feature: 'offset', value: 2, argsText: 'e.endFaces()' } });
    expect(await parseFeatureStatement(FORMS, 7)).toMatchObject({ ok: true, parsed: { feature: 'offset', value: 2, argsText: 'e.endFaces()' } });
    expect(await parseFeatureStatement(FORMS, 8)).toMatchObject({ ok: true, parsed: { feature: 'offset-curve', distance: 3 } });
  });

  it('refuses an edit of the sketch tool or the face outline as an offset curve', async () => {
    for (const line of [5, 7]) {
      const result = await applyFeatureEdit(FORMS, editSpec(line, { distance: 4 }));
      expect(result.error, `line ${line}`).toBe(`the statement at line ${line} is a offset, expected a offset-curve — is the file in sync with the last render?`);
    }
  });

  it('binds a curve producer, a repeat target, a wire or a surface only to the offset curve', async () => {
    const callees = FeatureCallees.BUILT_IN;
    const [inSketch, outline, curveCall] = [await callAt(5), await callAt(7), await callAt(8)];
    for (const featureType of ['offset-curve', 'feature', 'wire', 'surface']) {
      expect(callees.binds({ featureType, line: 5 }, inSketch), `${featureType} in a sketch`).toBe(false);
      expect(callees.binds({ featureType, line: 7 }, outline), `${featureType} on the outline`).toBe(false);
      expect(callees.binds({ featureType, line: 8 }, curveCall), `${featureType} on the curve`).toBe(true);
    }
    // The sketch tool's own producer type binds the sketch tool and the
    // outline, which builds its class, as it did — never the curve.
    expect(callees.binds({ featureType: 'offset', line: 5 }, inSketch)).toBe(true);
    expect(callees.binds({ featureType: 'offset', line: 7 }, outline)).toBe(true);
    expect(callees.binds({ featureType: 'offset', line: 8 }, curveCall)).toBe(false);
  });

  it('binds the outline as a wire or a surface where the scene says it left one, as before, and never the sketch tool', async () => {
    const [inSketch, outline] = [await callAt(5), await callAt(7)];
    const curveScene = FeatureCallees.BUILT_IN.over({ at: () => ({ curve: true, surface: false }) });
    expect(curveScene.binds({ featureType: 'wire', line: 7 }, outline)).toBe(true);
    expect(curveScene.binds({ featureType: 'surface', line: 7 }, outline)).toBe(false);
    expect(curveScene.binds({ featureType: 'wire', line: 5 }, inSketch)).toBe(false);
    const surfaceScene = FeatureCallees.BUILT_IN.over({ at: () => ({ curve: false, surface: true }) });
    expect(surfaceScene.binds({ featureType: 'surface', line: 7 }, outline)).toBe(true);
    expect(surfaceScene.binds({ featureType: 'surface', line: 5 }, inSketch)).toBe(false);
  });

  it('refuses a stale curve producer whose line holds the sketch tool or the outline, where it would bind .edges()', async () => {
    for (const [line, column] of [[5, 2], [7, 0]]) {
      const stale = await applyFeatureEdit(FORMS, {
        feature: 'fillet',
        value: 1,
        filePath: FILE,
        producers: [{ line, column, featureType: 'offset-curve', nameHint: 'oc', bind: true }],
        parts: [bucket(0, 'edges', 0)],
        imports: [],
      });
      expect(stale.error, `line ${line}`).toBe(`the call at line ${line} is offset(), expected a offset-curve()-producing call`);
      expect(stale.newCode).toBe(FORMS);
    }
  });

  it('extrudes the outline by its variable, as before', async () => {
    const result = await applyFeatureEdit(FORMS, {
      feature: 'extrude',
      filePath: FILE,
      value: 5,
      extrude: { op: 'add', distance: 5, distance2: null, symmetric: false, draft: null, endOffset: null, drill: true, thin: null, profile: 'bound' } as never,
      producers: [{ line: 7, column: 0, featureType: 'offset', nameHint: 'o', bind: true }],
      parts: [],
      imports: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst o = offset(2, e.endFaces())\n`);
  });

  it('names an offset curve Offset Curve n, and leaves the sketch tool and the face outline unnamed', async () => {
    const tree = (await getJavaScriptParser()).parse(FORMS);
    expect(FeatureNames.chainFor(tree, 'offset', undefined, 'offset-curve')).toBe(`.name('Offset Curve 1')`);
    expect(FeatureNames.chainFor(tree, 'offset', undefined, 'offset')).toBe('');
    expect(FeatureNames.chainFor(tree, 'offset')).toBe('');

    const outline = await applyFeatureEdit(FORMS, {
      feature: 'offset', value: 3, filePath: FILE,
      producers: [solid(3, 10)], parts: [bucket(0, 'startFaces')], imports: [],
    });
    expect(outline.error).toBeUndefined();
    expect(outline.newCode).toMatch(/\noffset\(3, e\.startFaces\(\)\)\n/);
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

/** A create request over {@link CODE}: the sketch on line 5 along the surface on line 6, the distance over 3. */
const request = (fields: Record<string, unknown> = {}) => ({
  feature: 'offset-curve',
  distance: 3,
  edges: [statement(5, 0)],
  on: [statement(6, 13)],
  ...fields,
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
  it('writes a whole sketch along a whole surface without synthesis, bound under their names', async () => {
    const base = await serve(fakeServer);

    const preview = await post(`${base}/apply-feature`, { ...request(), preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'offset(3, c, { on: wing })' } });
    expect(relayed).toEqual([]);

    const applied = await post(`${base}/apply-feature`, request());
    expect(applied.status).toBe(200);
    expect(relayed[0].spec).toMatchObject({
      feature: 'offset-curve',
      offsetCurve: {
        distance: 3,
        edges: [{ kind: 'producer', producer: 0 }],
        on: [{ kind: 'producer', producer: 1 }],
      },
      producers: [
        { line: 5, column: 0, featureType: 'wire', nameHint: 'c', bind: true },
        { line: 6, column: 13, featureType: 'surface', nameHint: 's', bind: true },
      ],
      parts: [],
    });
    const newCode = await written(base, CODE);
    expect(newCode).toContain(`\nconst c = sketch(plane('xz', 30), () => { line([-5, 5], [5, 15]) })\n`);
    expect(newCode).toContain(`\noffset(3, c, { on: wing }).name('Offset Curve 1')\n`);
  });

  it('writes a parameter distance, and a variable the expression field declares', async () => {
    const base = await serve(fakeServer);
    expect((await post(`${base}/apply-feature`, { ...request({ distance: '-gap' }), preview: true })).body.preview)
      .toBe('offset(-gap, c, { on: wing })');

    const applied = await post(`${base}/apply-feature`, request({ distance: 'inset', newVariables: [{ name: 'inset', initializer: '4' }] }));
    expect(applied.status).toBe(200);
    const newCode = await written(base, CODE);
    expect(newCode).toContain(`\nconst inset = 4\noffset(inset, c, { on: wing }).name('Offset Curve 1')\n`);
  });

  it("refuses a zero distance in the engine's words, and malformed rows and distances", async () => {
    const base = await serve(fakeServer);
    const refusals: [Record<string, unknown>, string | RegExp][] = [
      [request({ distance: 0 }), 'offset: the distance is zero.'],
      [request({ distance: '0' }), 'offset: the distance is zero.'],
      [request({ distance: undefined }), 'distance must be a number or expression'],
      [request({ distance: 'a, b' }), 'distance must be a number or expression'],
      [request({ edges: [{ kind: 'face', shapeId: 's1', index: 0 }] }), 'edges takes curves and edges, not a face'],
      [request({ on: [{ kind: 'edge', shapeId: 's1', index: 0 }] }), 'on takes surfaces and faces, not an edge'],
      [request({ on: [] }), /^on must be a non-empty list of picks/],
      [request({ edges: undefined }), /^edges must be a non-empty list of picks/],
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

  it('edits the distance alone without a boundary, leaving both rows and the name as written', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const body = {
      feature: 'offset-curve',
      edit: { filePath: FILE, line: 10, column: 0 },
      expectedStatement: 'offset(3, e.endEdges(), { on: e.sideFaces() })',
      distance: 5,
    };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'offset(5, e.endEdges(), { on: e.sideFaces() })' } });

    expect((await post(`${base}/apply-feature`, body)).status).toBe(200);
    expect(relayed[0].spec.edit.offsetCurve).toEqual({ distance: 5 });
    expect(await written(base, WRITTEN)).toBe(WRITTEN.replace(
      `offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
      `offset(5, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`,
    ));
  });

  it('re-picks a row by statement, keeping the other row and the distance as written', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const body = { feature: 'offset-curve', edit: { filePath: FILE, line: 11, column: 0 }, on: [statement(9, 11)] };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'offset(-1.50, [rail, e.endEdges(0)], { on })' } });

    expect((await post(`${base}/apply-feature`, body)).status).toBe(200);
    expect(relayed[0].spec.edit.offsetCurve).toEqual({ on: { kind: 'picks', picks: [{ kind: 'producer', producer: 0 }] } });
    expect(await written(base, WRITTEN)).toContain(`\nconst oc = offset(-1.50, [rail, e.endEdges(0)], { on })\n`);
  });

  it('refuses a zero distance, asks a boundary of re-picked geometry, and refuses a statement the dialog cannot show', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const edit = (line: number) => ({ filePath: FILE, line, column: 0 });

    const zero = await post(`${base}/apply-feature`, { feature: 'offset-curve', edit: edit(10), distance: 0 });
    expect(zero).toEqual({ status: 400, body: { error: 'offset: the distance is zero.' } });

    const kept = await post(`${base}/apply-feature`, { feature: 'offset-curve', edit: edit(18), on: [statement(6, 13)] });
    expect(kept).toEqual({ status: 422, body: { success: false, reason: 'offset: the distance is zero.' } });

    for (const repick of [{ edges: [{ kind: 'edge', shapeId: 's1', index: 2 }] }, { on: [{ kind: 'face', shapeId: 's1', index: 0 }] }]) {
      const unbounded = await post(`${base}/apply-feature`, { feature: 'offset-curve', edit: edit(10), ...repick });
      expect(unbounded, JSON.stringify(repick)).toEqual({ status: 400, body: { error: 'before is required when an edit re-picks geometry' } });
    }

    const empty = await post(`${base}/apply-feature`, { feature: 'offset-curve', edit: edit(13), distance: 2 });
    expect(empty).toEqual({ status: 422, body: { success: false, reason: 'offset: the only option is { on: faces } — edit it in the source' } });
    const parsed = await post(`${base}/feature/parse`, { line: 14, filePath: FILE });
    expect(parsed).toEqual({ status: 422, body: { error: 'offset: the only option is { on: faces } — edit it in the source' } });
    expect(relayed).toEqual([]);
  });

  it('hands the preview both rows in pick order and the distance, resolved, with no op', async () => {
    const base = await serve(fakeServer);
    const result = await post(`${base}/feature-ghost`, {
      feature: 'offset-curve',
      distance: '1 + 2',
      edges: [{ kind: 'edge', shapeId: 's1', index: 2 }, statement(5, 0)],
      on: [statement(6, 13)],
    });
    expect(result).toEqual({ status: 200, body: { success: true, solids: [{ kind: 'wire', meshes: [] }] } });
    expect(received).toEqual({
      feature: 'offset-curve',
      distance: 3,
      edges: [{ kind: 'edge', shapeId: 's1', index: 2 }, { kind: 'statement', filePath: FILE, line: 5 }],
      on: [{ kind: 'statement', filePath: FILE, line: 6 }],
    });

    await post(`${base}/feature-ghost`, { feature: 'offset-curve', distance: -2, edges: [statement(5, 0)], on: [statement(6, 13)] });
    expect(received).toMatchObject({ distance: -2 });
  });

  it('refuses a preview with an empty row, a pick of the wrong kind or no distance', async () => {
    const base = await serve(fakeServer);
    const ghost = (fields: Record<string, unknown>) => ({
      feature: 'offset-curve', distance: 3, edges: [statement(5, 0)], on: [statement(6, 13)], ...fields,
    });
    for (const [body, reason] of [
      [ghost({ edges: [] }), 'Invalid offset selections'],
      [ghost({ on: undefined }), 'Invalid offset selections'],
      [ghost({ edges: [{ kind: 'face', shapeId: 's1', index: 0 }] }), 'Invalid offset selections'],
      [ghost({ on: [{ kind: 'edge', shapeId: 's1', index: 0 }] }), 'Invalid offset selections'],
      [ghost({ distance: undefined }), 'Invalid offset distance'],
      [ghost({ distance: true }), 'Invalid dimension'],
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

/** The index among the body's edges of the circle all of whose points lie at height `z`. */
function rimAt(body: Shape, z: number): number {
  return Explorer.findEdgesWrapped(body).findIndex(edge => {
    const [a, b] = EdgeOps.endPoints(edge);
    return Math.abs(a.z - z) < 1e-6 && Math.abs(b.z - z) < 1e-6 && Math.abs(EdgeOps.getEdgeMidPoint(edge).z - z) < 1e-6;
  });
}

/** The index among the body's faces of its curved wall: the face neither cap is, centred halfway up. */
function wallOf(body: Shape): number {
  return Explorer.findFacesWrapped(body).findIndex(face => Math.abs(ShapeMeasure.centerOfMass(face).z - 10) < 1e-6);
}

/** The heights of an offset curve's wires, each wire level. */
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
   * A Ø20 cylinder 20 tall (line 4) — and, with `withCurve`, the offset
   * curve of its top rim 3 down its wall on line 5.
   */
  function stage(withCurve = false): { scene: Scene; code: string; body: Shape; curve: OffsetCurve | null } {
    sketch('xy', () => {
      circle([0, 0], 20);
    });
    const e = located(extrude(20), 4, 10);
    const curve = withCurve
      ? located(offset(3, (e as any).endEdges(), { on: (e as any).sideFaces() }) as unknown as OffsetCurve, 5, 0)
      : null;
    const scene = render();
    const code = src(
      `import { offset, sketch, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      ...(withCurve ? [`offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')`] : []),
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
      featureGhost: async (ghost: any) => {
        const result = getSceneManager()!.buildFeatureGhost(scene, ghost);
        return result.ok
          ? { status: 200, solids: result.solids }
          : { status: 422, reason: result.reason, surface: result.surface === true || undefined };
      },
      featureSources: (before: any) => getSceneManager()!.resolveFeatureSources(scene, before),
    };
  }

  /** The offset curve the code builds, checked to build without an error. */
  function builtCurve(code: string): OffsetCurve {
    const built = runFluid(code);
    expect(built.getAllSceneObjects().map(obj => obj.getError()).filter(Boolean)).toEqual([]);
    return built.getAllSceneObjects().find(obj => obj instanceof OffsetCurve)! as OffsetCurve;
  }

  it('writes the picked top rim on the picked wall, and the curve runs 3 below the rim', async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const req = {
      feature: 'offset-curve',
      distance: 3,
      edges: [{ kind: 'edge', shapeId: body.id, index: rimAt(body, 20) }],
      on: [{ kind: 'face', shapeId: body.id, index: wallOf(body) }],
    };

    const preview = await post(`${base}/apply-feature`, { ...req, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'offset(3, e.endEdges(), { on: e.sideFaces() })' } });

    expect((await post(`${base}/apply-feature`, req)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(`${code.replace(`import { sketch`, `import { offset, sketch`)}offset(3, e.endEdges(), { on: e.sideFaces() }).name('Offset Curve 1')\n`);

    const oc = builtCurve(newCode);
    expect(oc.getName()).toBe('Offset Curve 1');
    expect(wireHeights(oc)).toEqual([17]);
  });

  it('reads the statement back from the scene, then edits the distance and the curve moves down the wall', async () => {
    const { scene, code, body, curve } = stage(true);
    const base = await serve(engineHost(scene, code));
    const index = scene.getTimelineObjects().indexOf(curve!);
    const before = { index, type: 'offset-curve', line: 5, column: 0 };

    const parsed = await post(`${base}/feature/parse`, { line: 5, filePath: FILE });
    expect(parsed.body).toEqual({
      ok: true,
      parsed: {
        feature: 'offset-curve',
        distance: 3,
        distanceArg: '3',
        edgesTexts: ['e.endEdges()'],
        edgesRefs: [null],
        onTexts: ['e.sideFaces()'],
        onRefs: [null],
        edgesArg: 'e.endEdges()',
        onArg: 'e.sideFaces()',
      },
      statement: 'offset(3, e.endEdges(), { on: e.sideFaces() })',
    });

    const sources = await post(`${base}/feature/sources`, { before });
    expect(sources.status).toBe(200);
    expect(sources.body).toEqual({
      ok: true,
      feature: 'offset-curve',
      edges: [{ kind: 'entities', entities: [{ shapeId: body.id, sub: { type: 'edge', index: rimAt(body, 20) } }] }],
      on: [{ kind: 'entities', entities: [{ shapeId: body.id, sub: { type: 'face', index: wallOf(body) } }] }],
    });

    const edit = {
      feature: 'offset-curve',
      edit: { filePath: FILE, line: 5, column: 0 },
      expectedStatement: 'offset(3, e.endEdges(), { on: e.sideFaces() })',
      before,
      distance: 4,
      on: [{ kind: 'face', shapeId: body.id, index: wallOf(body) }],
    };
    const preview = await post(`${base}/apply-feature`, { ...edit, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'offset(4, e.endEdges(), { on: e.sideFaces() })' } });

    expect((await post(`${base}/apply-feature`, edit)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(code.replace(`offset(3, e.endEdges()`, `offset(4, e.endEdges()`));
    expect(wireHeights(builtCurve(newCode))).toEqual([16]);
  });

  it('previews the curve as a wire, and says why when the engine refuses: a zero distance, a curve that leaves the wall', async () => {
    const { scene, code, body } = stage();
    const base = await serve(engineHost(scene, code));
    const ghost = (distance: number) => ({
      feature: 'offset-curve',
      distance,
      edges: [{ kind: 'edge', shapeId: body.id, index: rimAt(body, 20) }],
      on: [{ kind: 'face', shapeId: body.id, index: wallOf(body) }],
    });

    const ok = await post(`${base}/feature-ghost`, ghost(3));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.solids.map((solid: { kind: string }) => solid.kind)).toEqual(['wire']);

    const zero = await post(`${base}/feature-ghost`, ghost(0));
    expect(zero).toEqual({ status: 422, body: { success: false, surface: true, reason: 'offset: the distance is zero.' } });

    const leaves = await post(`${base}/feature-ghost`, ghost(-3));
    expect(leaves).toEqual({ status: 422, body: { success: false, surface: true, reason: 'offset: at this distance the curve leaves the faces.' } });
  });
});
