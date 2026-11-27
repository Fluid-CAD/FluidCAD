// The intersection curve — `intersect(first, second)` outside a sketch —
// written, read back and edited by the server: the statement from the two
// rows of surface picks, its parse into the two pick lists, an edit of one
// row, the refusals, the sketch tool that shares the callee, and the
// preview request. The transform is exercised on code alone; the routes on
// a fake server, then on a scene the real engine built.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { setupOC, render } from '../../lib/tests/setup.js';
import { useLoadedBodies, loadShapes } from '../../lib/tests/helpers/loaded-bodies.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import { circle, intersect } from '../../lib/core/2d/index.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { getOC } from '../../lib/oc/init.js';
import { Convert } from '../../lib/oc/convert.js';
import { SheetOps } from '../../lib/oc/sheet-ops.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { CurveClassifier } from '../../lib/oc/curve-classifier.js';
import { Plane } from '../../lib/math/plane.js';
import { Point } from '../../lib/math/point.js';
import { Edge } from '../../lib/common/edge.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { IntersectionCurve } from '../../lib/features/intersection-curve.js';
import { Scene } from '../../lib/rendering/scene.js';
import {
  applyFeatureEdit,
  FeatureCallees,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type OperandPick,
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

const solid = (line: number, column: number, nameHint = 'e'): Producer =>
  ({ line, column, featureType: 'extrude', nameHint, bind: true });
const surface = (line: number, column: number): Producer =>
  ({ line, column, featureType: 'surface', nameHint: 's', bind: true });
/** `<producer>.<accessor>(<indices>)`. */
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices: indices.length > 0 ? indices : null, filterArgs: null });
const whole = (producer: number): OperandPick => ({ kind: 'producer', producer });
const face = (part: number): OperandPick => ({ kind: 'selector', part });

/**
 * A cylinder (line 4), an unnamed loaded surface (line 5), a named one
 * (line 6) and a profile sketch (line 7).
 */
const CODE = src(
  `import { sketch, circle, extrude, load } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `load('wing.step')`,
  `const fin = load('fin.step')`,
  `sketch('xz', () => { circle([10, 10], 2) })`,
);

/** A create spec over {@link CODE} with the rows' picks. */
function createSpec(
  first: OperandPick[],
  second: OperandPick[],
  producers: Producer[],
  parts: Part[] = [],
): ApplyFeatureEditSpec {
  return { feature: 'intersection-curve', filePath: FILE, intersectionCurve: { first, second }, producers, parts, imports: [] };
}

/** An edit of the intersection curve statement on `line`. */
function editSpec(
  line: number,
  intersectionCurve: NonNullable<ApplyFeatureEditSpec['edit']>['intersectionCurve'],
  producers: Producer[] = [],
  parts: Part[] = [],
): ApplyFeatureEditSpec {
  return {
    feature: 'intersection-curve', filePath: FILE, producers, parts, imports: [],
    edit: { line, column: 0, intersectionCurve },
  };
}

describe('writing an intersection curve', () => {
  it('writes the faces of a solid and a surface as intersect(e.sideFaces(), s), named and imported', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      [face(0)], [whole(1)], [solid(4, 10), surface(5, 0)], [bucket(0, 'sideFaces')],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { intersect, sketch, circle, extrude, load } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      `const s = load('wing.step')`,
      `const fin = load('fin.step')`,
      `sketch('xz', () => { circle([10, 10], 2) })`,
      `intersect(e.sideFaces(), s).name('Intersect 1')`,
    ));
  });

  it('writes two picks on one side as a list, in pick order', async () => {
    const result = await applyFeatureEdit(CODE, createSpec(
      [face(1), face(0)], [whole(1), whole(2)],
      [solid(4, 10), surface(5, 0), surface(6, 11)],
      [bucket(0, 'sideFaces', 0), bucket(0, 'startFaces')],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nintersect([e.startFaces(), e.sideFaces(0)], [s, fin]).name('Intersect 1')\n`);
  });

  it('is bound as ic when a later statement takes its edge', async () => {
    const code = CODE.replace(`load('wing.step')`, `const s = load('wing.step')`)
      + `intersect(e.sideFaces(), s).name('Intersect 1')\n`;
    const result = await applyFeatureEdit(code, {
      feature: 'sweep',
      filePath: FILE,
      sweep: { op: 'add', thin: null, profile: { producer: 1 }, path: { kind: 'selector' } },
      producers: [
        { line: 8, column: 0, featureType: 'intersection-curve', nameHint: 'ic', bind: true },
        { line: 7, column: 0, featureType: 'sketch', nameHint: 'p', bind: true },
      ],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst ic = intersect(e.sideFaces(), s).name('Intersect 1')\n`);
    expect(result.newCode).toContain(`sweep(ic.edges(0), p)`);
  });

  it('refuses an edge selector in a slot, an empty slot and a part no pick writes', async () => {
    const edge = await applyFeatureEdit(CODE, createSpec(
      [face(0)], [whole(1)], [solid(4, 10), surface(5, 0)], [bucket(0, 'sideEdges')],
    ));
    expect(edge.error).toBe('malformed intersection curve edit spec: the first selection takes surfaces and faces, not an edge');
    expect(edge.newCode).toBe(CODE);

    const empty = await applyFeatureEdit(CODE, createSpec([face(0)], [], [solid(4, 10)], [bucket(0, 'sideFaces')]));
    expect(empty.error).toBe('intersect: the second selection is empty — pick a surface or faces for it');

    const solidWhole = await applyFeatureEdit(CODE, createSpec([face(0)], [whole(0)], [solid(4, 10)], [bucket(0, 'sideFaces')]));
    expect(solidWhole.error).toBe('malformed intersection curve edit spec: the second selection takes surfaces and faces: a pick references a statement that is neither');

    const leftOver = await applyFeatureEdit(CODE, createSpec(
      [face(0)], [whole(1)], [solid(4, 10), surface(5, 0)], [bucket(0, 'sideFaces'), bucket(0, 'endFaces')],
    ));
    expect(leftOver.error).toBe('malformed intersection curve edit spec: every selector part belongs to exactly one pick');
  });
});

/** {@link CODE} with the intersection curves on lines 8 to 10. */
const WRITTEN = src(
  `import { intersect, sketch, circle, extrude, load } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { circle([0, 0], 20) })`,
  `const e = extrude(20)`,
  `const wing = load('wing.step')`,
  `const fin = load('fin.step')`,
  `sketch('xz', () => { circle([10, 10], 2) })`,
  `intersect(e.sideFaces(), wing).name('Intersect 1')`,
  `const ic = intersect([e.sideFaces(0),  /* rim */ e.endFaces()], [wing, fin])`,
  `intersect(e)`,
);

describe('reading an intersection curve back', () => {
  it('parses to the two pick lists, with the statement each variable names', async () => {
    expect(await parseFeatureStatement(WRITTEN, 8)).toEqual({
      ok: true,
      parsed: {
        feature: 'intersection-curve',
        firstTexts: ['e.sideFaces()'],
        firstRefs: [null],
        secondTexts: ['wing'],
        secondRefs: [{ line: 5, column: 13 }],
        firstArg: 'e.sideFaces()',
        secondArg: 'wing',
      },
      statement: 'intersect(e.sideFaces(), wing)',
    });
  });

  it('reads a list element by element and keeps each argument as written', async () => {
    expect(await parseFeatureStatement(WRITTEN, 9)).toMatchObject({
      ok: true,
      parsed: {
        feature: 'intersection-curve',
        firstTexts: ['e.sideFaces(0)', 'e.endFaces()'],
        firstRefs: [null, null],
        secondTexts: ['wing', 'fin'],
        secondRefs: [{ line: 5, column: 13 }, { line: 6, column: 12 }],
        firstArg: '[e.sideFaces(0),  /* rim */ e.endFaces()]',
      },
    });
  });

  it('refuses a call outside a sketch that does not give the two sets of faces', async () => {
    expect(await parseFeatureStatement(WRITTEN, 10)).toEqual({
      ok: false,
      reason: 'intersect() outside a sketch takes the two sets of faces as its two arguments — edit it in the source',
    });
    expect(await parseFeatureStatement(WRITTEN.replace('intersect(e)', 'intersect(...pair)'), 10)).toMatchObject({ ok: false });
  });
});

describe('editing an intersection curve', () => {
  it('rewrites only the re-picked argument, and the name survives', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(8, { second: { kind: 'picks', picks: [whole(0)] } }, [surface(6, 12)]));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(WRITTEN.replace(
      `intersect(e.sideFaces(), wing).name('Intersect 1')`,
      `intersect(e.sideFaces(), fin).name('Intersect 1')`,
    ));
  });

  it('keeps the other argument exactly as written, and the binding', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(
      9, { first: { kind: 'keep' }, second: { kind: 'picks', picks: [face(0)] } }, [solid(4, 10)], [bucket(0, 'startFaces')],
    ));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nconst ic = intersect([e.sideFaces(0),  /* rim */ e.endFaces()], e.startFaces())\n`);
  });

  it('re-picks both arguments at once, a single pick bare and several as a list', async () => {
    const result = await applyFeatureEdit(WRITTEN, editSpec(8, {
      first: { kind: 'picks', picks: [whole(1), face(0)] },
      second: { kind: 'picks', picks: [face(1)] },
    }, [solid(4, 10), surface(5, 13)], [bucket(0, 'sideFaces'), bucket(0, 'endFaces')]));

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`\nintersect([wing, e.sideFaces()], e.endFaces()).name('Intersect 1')\n`);
  });

  it('refuses an edge selector in a slot and an empty slot, leaving the code alone', async () => {
    const edge = await applyFeatureEdit(WRITTEN, editSpec(8, { first: { kind: 'picks', picks: [face(0)] } }, [solid(4, 10)], [bucket(0, 'endEdges')]));
    expect(edge.error).toBe('malformed intersection curve edit spec: the first selection takes surfaces and faces, not an edge');
    expect(edge.newCode).toBe(WRITTEN);

    const empty = await applyFeatureEdit(WRITTEN, editSpec(8, { second: { kind: 'picks', picks: [] } }));
    expect(empty.error).toBe('intersect: the second selection is empty — pick a surface or faces for it');
    expect(empty.newCode).toBe(WRITTEN);
  });
});

/** An intersect() in a sketch (line 5) and one outside (line 7). */
const SKETCHED = src(
  `import { intersect, sketch, extrude, load } from 'fluidcad/core'`,
  ``,
  `const e = extrude(10)`,
  `sketch('xy', () => {`,
  `  intersect(e)`,
  `})`,
  `intersect(e.sideFaces(), load('wing.step'))`,
  `sketch('xz', () => {})`,
);

describe('in a sketch', () => {
  /** The statement call on `line` of {@link SKETCHED}. */
  async function callAt(line: number): Promise<TSNode> {
    const tree = (await getJavaScriptParser()).parse(SKETCHED);
    return findEditableCallAt(tree, splitLines(SKETCHED), line)!;
  }

  it('parses intersect(e) inside a sketch callback as the sketch tool, not this one', async () => {
    expect(await parseFeatureStatement(SKETCHED, 5)).toMatchObject({
      ok: true, parsed: { feature: 'project', op: 'intersect', argsText: 'e' },
    });
    expect(await parseFeatureStatement(SKETCHED, 7)).toMatchObject({ ok: true, parsed: { feature: 'intersection-curve' } });
  });

  it('refuses an edit of the sketch tool as an intersection curve', async () => {
    const result = await applyFeatureEdit(SKETCHED, editSpec(5, { first: { kind: 'keep' } }));
    expect(result.error).toBe('the statement at line 5 is a project, expected a intersection-curve — is the file in sync with the last render?');
  });

  it('binds a curve producer, a repeat target, a wire or a surface only to the call outside', async () => {
    const callees = FeatureCallees.BUILT_IN;
    const inside = await callAt(5);
    const outside = await callAt(7);
    for (const featureType of ['intersection-curve', 'feature', 'wire', 'surface']) {
      expect(callees.binds({ featureType, line: 5 }, inside), featureType).toBe(false);
      expect(callees.binds({ featureType, line: 7 }, outside), featureType).toBe(true);
    }
    // The sketch tool's own producer type binds the call inside only.
    expect(callees.binds({ featureType: 'intersect', line: 5 }, inside)).toBe(true);
    expect(callees.binds({ featureType: 'intersect', line: 7 }, outside)).toBe(false);
  });

  it('refuses a stale curve producer whose line now holds the sketch tool, where it would bind .edges()', async () => {
    const stale = await applyFeatureEdit(SKETCHED, {
      feature: 'fillet',
      value: 1,
      filePath: FILE,
      producers: [{ line: 5, column: 2, featureType: 'intersection-curve', nameHint: 'ic', bind: true }],
      parts: [bucket(0, 'edges', 0)],
      imports: [],
    });
    expect(stale.error).toBe('the call at line 5 is intersect(), expected a intersection-curve()-producing call');
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
  it('writes two whole surfaces without synthesis, bound under their names', async () => {
    const base = await serve(fakeServer);
    const body = { feature: 'intersection-curve', first: [statement(6, 12)], second: [statement(5, 0)] };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'intersect(fin, s)' } });
    expect(relayed).toEqual([]);

    const applied = await post(`${base}/apply-feature`, body);
    expect(applied.status).toBe(200);
    expect(relayed[0].spec).toMatchObject({
      feature: 'intersection-curve',
      intersectionCurve: { first: [{ kind: 'producer', producer: 0 }], second: [{ kind: 'producer', producer: 1 }] },
      producers: [
        { line: 6, column: 12, featureType: 'surface', nameHint: 's', bind: true },
        { line: 5, column: 0, featureType: 'surface', nameHint: 's', bind: true },
      ],
      parts: [],
    });
    expect(await written(base, CODE)).toContain(`\nconst s = load('wing.step')\n`);
    expect(await written(base, CODE)).toContain(`\nintersect(fin, s).name('Intersect 1')\n`);
  });

  it('refuses an edge in a row, an empty row and a pick of no known kind', async () => {
    const base = await serve(fakeServer);
    const edge = await post(`${base}/apply-feature`, {
      feature: 'intersection-curve', first: [{ kind: 'edge', shapeId: 's1', index: 0 }], second: [statement(5, 0)],
    });
    expect(edge).toEqual({ status: 400, body: { error: 'first takes surfaces and faces, not an edge' } });

    const empty = await post(`${base}/apply-feature`, { feature: 'intersection-curve', first: [statement(6, 12)], second: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/^second must be a non-empty list of picks/);

    const unknown = await post(`${base}/apply-feature`, {
      feature: 'intersection-curve', first: [{ kind: 'sketch', filePath: FILE, line: 3 }], second: [statement(5, 0)],
    });
    expect(unknown).toEqual({ status: 400, body: { error: 'first holds a pick of an unknown kind' } });
    expect(relayed).toEqual([]);
  });

  it('edits one row without a boundary when it re-picks a whole surface', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const body = {
      feature: 'intersection-curve',
      edit: { filePath: FILE, line: 8, column: 0 },
      expectedStatement: 'intersect(e.sideFaces(), wing)',
      second: [statement(6, 12)],
    };

    const preview = await post(`${base}/apply-feature`, { ...body, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'intersect(e.sideFaces(), fin)' } });

    expect((await post(`${base}/apply-feature`, body)).status).toBe(200);
    expect(relayed[0].spec.edit.intersectionCurve).toEqual({
      second: { kind: 'picks', picks: [{ kind: 'producer', producer: 0 }] },
    });
    expect(await written(base, WRITTEN)).toContain(`\nintersect(e.sideFaces(), fin).name('Intersect 1')\n`);
  });

  it('asks a boundary of an edit that re-picks faces, and refuses an empty row', async () => {
    currentCode = WRITTEN;
    const base = await serve(fakeServer);
    const edit = { filePath: FILE, line: 8, column: 0 };

    const unbounded = await post(`${base}/apply-feature`, {
      feature: 'intersection-curve', edit, first: [{ kind: 'face', shapeId: 's1', index: 2 }],
    });
    expect(unbounded).toEqual({ status: 400, body: { error: 'before is required when an edit re-picks geometry' } });

    const empty = await post(`${base}/apply-feature`, { feature: 'intersection-curve', edit, first: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/^first must be a non-empty list of picks/);
  });

  it('hands the preview both rows of picks, in pick order, with no op', async () => {
    const base = await serve(fakeServer);
    const first = [{ kind: 'face', shapeId: 's1', index: 2 }, statement(5, 0)];
    const second = [statement(6, 12)];

    const result = await post(`${base}/feature-ghost`, { feature: 'intersection-curve', first, second });
    expect(result).toEqual({ status: 200, body: { success: true, solids: [{ kind: 'wire', meshes: [] }] } });
    expect(received).toEqual({
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: 's1', index: 2 }, { kind: 'statement', filePath: FILE, line: 5 }],
      second: [{ kind: 'statement', filePath: FILE, line: 6 }],
    });
  });

  it('refuses a preview with an empty row or an edge in a row', async () => {
    const base = await serve(fakeServer);
    for (const body of [
      { feature: 'intersection-curve', first: [statement(5, 0)], second: [] },
      { feature: 'intersection-curve', first: [statement(5, 0)] },
      { feature: 'intersection-curve', first: [{ kind: 'edge', shapeId: 's1', index: 0 }], second: [statement(6, 12)] },
    ]) {
      expect(await post(`${base}/feature-ghost`, body), JSON.stringify(body))
        .toEqual({ status: 400, body: { success: false, reason: 'Invalid intersection selections' } });
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

/** A flat sheet at height `z` over [-20, 20]², loaded the way an imported surface is. */
function slabAt(z: number): SceneObject {
  const oc = getOC();
  const [pln, disposePln] = Convert.toGpPln(new Plane(new Point(0, 0, z), Plane.XY().xDirection, Plane.XY().normal));
  const maker = new oc.BRepBuilderAPI_MakeFace(pln, -20, 20, -20, 20);
  const raw = maker.Face();
  try {
    return loadShapes([SheetOps.fromRawFace(raw)]) as unknown as SceneObject;
  } finally {
    raw.delete();
    maker.delete();
    disposePln();
  }
}

const located = <T>(value: T, line: number, column: number): T => {
  (value as unknown as SceneObject).setSourceLocation({ filePath: FILE, line, column });
  return value;
};

/** The index of the cylinder's side face: the one face whose edges do not all lie at one height. */
function sideFaceOf(body: Shape): number {
  return Explorer.findFacesWrapped(body).findIndex(f => {
    const zs = f.getEdges().map((edge: Edge) => EdgeOps.getEdgeMidPoint(edge).z);
    return Math.max(...zs) - Math.min(...zs) > 1e-6;
  });
}

describe('through the real engine', () => {
  setupOC();
  useLoadedBodies();

  /**
   * The model in {@link CODE}'s layout, built in-process: a Ø20 cylinder 20
   * tall (line 4), flat sheets at z = 10 (line 5) and z = 5 (line 6) — and,
   * with `withCurve`, the intersection curve of its side and the first sheet
   * on line 8.
   */
  function stage(withCurve = false): { scene: Scene; code: string; body: Shape; side: number; curve: IntersectionCurve | null } {
    sketch('xy', () => {
      circle([0, 0], 20);
    });
    const e = located(extrude(20), 4, 10);
    const wing = located(slabAt(10), 5, 13);
    const fin = located(slabAt(5), 6, 12);
    sketch('xz', () => {
      circle([10, 10], 2);
    });
    const curve = withCurve
      ? located(intersect((e as any).sideFaces(), wing) as unknown as IntersectionCurve, 8, 0)
      : null;
    const scene = render();
    const code = src(
      `import { intersect, sketch, circle, extrude, load } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 20) })`,
      `const e = extrude(20)`,
      `const wing = load('${(wing as any).fileName}')`,
      `const fin = load('${(fin as any).fileName}')`,
      `sketch('xz', () => { circle([10, 10], 2) })`,
      ...(withCurve ? [`intersect(e.sideFaces(), wing).name('Intersect 1')`] : []),
    );
    const body = (e as unknown as SceneObject).getShapes().find(shape => shape.isSolid())!;
    return { scene, code, body, side: sideFaceOf(body), curve };
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

  /** The circles among an intersection curve's edges, by radius. */
  function circleRadii(obj: SceneObject): number[] {
    return (obj.getState(IntersectionCurve.EDGES_KEY) as Edge[])
      .map(edge => CurveClassifier.classify(edge))
      .map(cls => cls.kind === 'circle' ? +cls.radius!.toFixed(6) : NaN);
  }

  it('writes a picked side face and a surface, and the curve builds where they meet', async () => {
    const { scene, code, body, side } = stage();
    const base = await serve(engineHost(scene, code));
    const request = {
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: body.id, index: side }],
      second: [statement(5, 13)],
    };

    const preview = await post(`${base}/apply-feature`, { ...request, preview: true });
    expect(preview).toEqual({ status: 200, body: { success: true, preview: 'intersect(e.sideFaces(), wing)' } });

    expect((await post(`${base}/apply-feature`, request)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(`${code}intersect(e.sideFaces(), wing).name('Intersect 1')\n`);

    const built = runFluid(newCode);
    expect(built.getAllSceneObjects().map(obj => obj.getError()).filter(Boolean)).toEqual([]);
    const ic = built.getAllSceneObjects().find(obj => obj instanceof IntersectionCurve)!;
    expect(ic.getName()).toBe('Intersect 1');
    expect(circleRadii(ic)).toEqual([10]);
  });

  it('writes two surfaces on one side as a list, and the curve has a circle at each', async () => {
    const { scene, code, body, side } = stage();
    const base = await serve(engineHost(scene, code));

    expect((await post(`${base}/apply-feature`, {
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: body.id, index: side }],
      second: [statement(5, 13), statement(6, 12)],
    })).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toContain(`\nintersect(e.sideFaces(), [wing, fin]).name('Intersect 1')\n`);

    const ic = runFluid(newCode).getAllSceneObjects().find(obj => obj instanceof IntersectionCurve)!;
    expect(ic.getError()).toBeNull();
    expect(circleRadii(ic)).toEqual([10, 10]);
  });

  it('refuses a pick on an edge, in the synthesis words, before anything is written', async () => {
    const { scene, code, body } = stage();
    const host = engineHost(scene, code);
    const synthesis = host.synthesizeApplyFeature([{ shapeId: body.id, sub: { type: 'edge', index: 0 } }], 'intersection-curve', undefined, [], undefined, undefined);
    expect(synthesis).toMatchObject({ ok: false, reason: 'intersect takes faces — pick faces only' });
  });

  it('reads the edited statement\'s rows back from the scene, then re-picks one with a face', async () => {
    const { scene, code, body, side, curve } = stage(true);
    const base = await serve(engineHost(scene, code));
    const index = scene.getTimelineObjects().indexOf(curve!);
    const before = { index, type: 'intersection-curve', line: 8, column: 0 };

    const parsed = await post(`${base}/feature/parse`, { line: 8, filePath: FILE });
    expect(parsed.body).toMatchObject({
      ok: true,
      parsed: { feature: 'intersection-curve', firstTexts: ['e.sideFaces()'], secondTexts: ['wing'], secondRefs: [{ line: 5, column: 13 }] },
      statement: 'intersect(e.sideFaces(), wing)',
    });

    const sources = await post(`${base}/feature/sources`, { before });
    expect(sources.status).toBe(200);
    expect(sources.body).toEqual({
      ok: true,
      feature: 'intersection-curve',
      first: [{ kind: 'entities', entities: [{ shapeId: body.id, sub: { type: 'face', index: side } }] }],
      second: [{ kind: 'sketch', filePath: FILE, line: 5, column: 13 }],
    });

    // The bottom cap lies at z = 0: the second row becomes the cap of the
    // cylinder's own bottom, where the side meets it.
    const bottom = Explorer.findFacesWrapped(body).findIndex(f =>
      f.getEdges().every((edge: Edge) => Math.abs(EdgeOps.getEdgeMidPoint(edge).z) < 1e-6));
    const edit = {
      feature: 'intersection-curve',
      edit: { filePath: FILE, line: 8, column: 0 },
      expectedStatement: 'intersect(e.sideFaces(), wing)',
      before,
      second: [{ kind: 'face', shapeId: body.id, index: bottom }],
    };
    const preview = await post(`${base}/apply-feature`, { ...edit, preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.preview).toMatch(/^intersect\(e\.sideFaces\(\), e\.startFaces\(\)\)$/);

    expect((await post(`${base}/apply-feature`, edit)).status).toBe(200);
    const newCode = await written(base, code);
    expect(newCode).toBe(code.replace(
      `intersect(e.sideFaces(), wing).name('Intersect 1')`,
      `${preview.body.preview}.name('Intersect 1')`,
    ));
  });

  it('previews the curve as a wire, and says why when the rows do not cross', async () => {
    const { scene, code, body, side } = stage();
    const base = await serve(engineHost(scene, code));

    const crossing = await post(`${base}/feature-ghost`, {
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: body.id, index: side }],
      second: [{ kind: 'statement', filePath: FILE, line: 5 }],
    });
    expect(crossing.status).toBe(200);
    expect(crossing.body.success).toBe(true);
    expect(crossing.body.solids.map((solid: { kind: string }) => solid.kind)).toEqual(['wire']);

    const same = await post(`${base}/feature-ghost`, {
      feature: 'intersection-curve',
      first: [{ kind: 'face', shapeId: body.id, index: side }],
      second: [{ kind: 'face', shapeId: body.id, index: side }],
    });
    expect(same.status).toBe(422);
    expect(same.body).toMatchObject({ success: false, surface: true });
    expect(same.body.reason).toMatch(/is in both selections/);
  });
});
