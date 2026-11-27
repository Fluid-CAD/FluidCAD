// The create request of a tool written from rows of curve or surface picks,
// run by createFromOperandRows for a fixture tool `join(left, right)` over a
// fake server: the rows resolved in argument order through one merger and
// one synthesis, the tool's payload after them, the same-file check, the
// statement under the transform's names, the preview or the dispatch, and
// each refusal answering the request.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Response } from 'express';
import {
  FeatureCallees,
  OperandRows,
  type ApplyFeatureEditSpec,
  type RowPicks,
} from '../src/apply-feature-edit/index.ts';
import { createFromOperandRows, type OperandRowCreation } from '../src/routes/apply-feature/operand-row-create.ts';
import type { OperandInput } from '../src/routes/apply-feature/operand-inputs.ts';
import type { ApplyFeatureRequestContext } from '../src/routes/apply-feature/context.ts';

const FILE = '/ws/model.fluid.js';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

/** A rail sketch (line 3), a loaded skin (line 4) and a body (line 5). */
const CODE = src(
  `import { sketch, extrude, load } from 'fluidcad/core'`,
  ``,
  `const rail = sketch('xy', () => {})`,
  `const skin = load('skin.step')`,
  `extrude(10)`,
);

const JOIN = new OperandRows<'left' | 'right'>({
  callee: 'join',
  tool: 'join',
  rows: {
    left: { kind: 'curve', label: 'the left side', wants: 'a curve or edges' },
    right: { kind: 'surface', label: 'the right side', wants: 'a surface or faces' },
  },
  shapeError: 'join() takes two rows',
});

const statement = (line: number, filePath = FILE): OperandInput => ({ kind: 'statement', filePath, line, column: 0 });
const face = (index: number): OperandInput => ({ kind: 'face', shapeId: 'body', index });
const edge = (index: number): OperandInput => ({ kind: 'edge', shapeId: 'body', index });

type Answer = { status: number; body: unknown };

let answers: Answer[];
let dispatched: { spec: ApplyFeatureEditSpec; body: unknown }[];
let synthesized: { picks: unknown[]; feature: string }[];
/** What the fake synthesis answers next: a spec over the body on line 5, or a refusal. */
let synthesis: 'ok' | 'refused' | 'none' | 'other-file';

function fakeResponse(): Response {
  let status = 200;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(body: unknown) {
      answers.push({ status, body });
      return res;
    },
  };
  return res as unknown as Response;
}

function context(preview: boolean): ApplyFeatureRequestContext {
  const fluidCadServer = {
    getCurrentCode: () => CODE,
    getCurrentFileName: () => FILE,
    getParamDefinitions: () => [],
    synthesizeApplyFeature: (picks: unknown[], feature: string) => {
      synthesized.push({ picks, feature });
      if (synthesis === 'none') {
        return null;
      }
      if (synthesis === 'refused') {
        return { ok: false, reason: 'no filter tells them apart', pick: picks[0] };
      }
      return {
        ok: true,
        spec: {
          filePath: synthesis === 'other-file' ? '/ws/other.fluid.js' : FILE,
          producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }],
          parts: picks.map((_, i) => ({ producer: 0, accessor: 'sideFaces', indices: [synthesized.length * 10 + i], filterArgs: null })),
          imports: ['face'],
        },
      };
    },
  };
  const dispatcher = {
    dispatch: async (_res: Response, spec: ApplyFeatureEditSpec, body: unknown) => {
      dispatched.push({ spec, body });
    },
  };
  return {
    fluidCadServer, dispatcher, preview, newVariables: undefined,
    activePartFor: () => undefined,
    currentCallees: async () => FeatureCallees.BUILT_IN,
  } as unknown as ApplyFeatureRequestContext;
}

/** The fixture tool's creation over `rows`, with a payload that takes the picks as they come. */
function creation(
  rows: { left: OperandInput[]; right: OperandInput[] },
  overrides: Partial<OperandRowCreation<'left' | 'right', RowPicks<'left' | 'right'>>> = {},
): OperandRowCreation<'left' | 'right', RowPicks<'left' | 'right'>> {
  return {
    feature: 'intersection-curve',
    kinds: JOIN.kinds,
    rows,
    differentFiles: 'the two sides come from different files',
    payload: picks => picks,
    statement: (payload, parts, varFor) => JOIN.call(JOIN.arguments(payload, parts, varFor)),
    spec: intersectionCurve => ({ intersectionCurve }),
    ...overrides,
  };
}

beforeEach(() => {
  answers = [];
  dispatched = [];
  synthesized = [];
  synthesis = 'ok';
});

describe('createFromOperandRows', () => {
  it('previews whole objects under their names, with no synthesis and nothing dispatched', async () => {
    await createFromOperandRows(context(true), fakeResponse(), creation({ left: [statement(3)], right: [statement(4)] }));

    expect(answers).toEqual([{ status: 200, body: { success: true, preview: 'join(rail, skin)' } }]);
    expect(synthesized).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('dispatches the spec with the payload under the tool\'s key and answers with the statement', async () => {
    await createFromOperandRows(context(false), fakeResponse(), creation({ left: [statement(3)], right: [statement(4)] }));

    expect(answers).toEqual([]);
    expect(dispatched).toEqual([{
      spec: {
        feature: 'intersection-curve',
        intersectionCurve: { left: [{ kind: 'producer', producer: 0 }], right: [{ kind: 'producer', producer: 1 }] },
        filePath: FILE,
        producers: [
          { line: 3, column: 0, featureType: 'wire', nameHint: 'c', bind: true },
          { line: 4, column: 0, featureType: 'surface', nameHint: 's', bind: true },
        ],
        parts: [],
        imports: [],
        newVariables: undefined,
      },
      body: { success: true, preview: 'join(rail, skin)' },
    }]);
  });

  it('synthesizes each row\'s entities together, in argument order, merging their producers and imports', async () => {
    await createFromOperandRows(context(false), fakeResponse(), creation({ right: [face(4), face(5)], left: [edge(1)] } as { left: OperandInput[]; right: OperandInput[] }));

    expect(synthesized.map(call => [call.feature, call.picks.length])).toEqual([['intersection-curve', 1], ['intersection-curve', 2]]);
    const { spec, body } = dispatched[0];
    expect(spec.intersectionCurve).toEqual({
      left: [{ kind: 'selector', part: 0 }],
      right: [{ kind: 'selector', part: 1 }, { kind: 'selector', part: 2 }],
    });
    expect(spec.producers).toEqual([{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }]);
    expect(spec.parts.map(part => [part.producer, part.indices])).toEqual([[0, [10]], [0, [20]], [0, [21]]]);
    expect(spec.imports).toEqual(['face']);
    expect(body).toMatchObject({ success: true });
  });

  it('hands the payload the rows\' picks and the same synthesis, and stops once it has refused', async () => {
    let seen: RowPicks<'left' | 'right'> | undefined;
    await createFromOperandRows(context(false), fakeResponse(), creation({ left: [statement(3)], right: [statement(4)] }, {
      payload: async (picks, rows) => {
        seen = picks;
        const parts = await rows.synthesize([{ shapeId: 'body', sub: { type: 'edge', index: 0 } }]);
        expect(parts).toEqual([0]);
        rows.refuse('the direction must be a single edge or face selection');
        return null;
      },
    }));

    expect(seen).toEqual({ left: [{ kind: 'producer', producer: 0 }], right: [{ kind: 'producer', producer: 1 }] });
    expect(answers).toEqual([{ status: 422, body: { success: false, reason: 'the direction must be a single edge or face selection' } }]);
    expect(dispatched).toEqual([]);
  });

  it('refuses picks from more than one file in the tool\'s words, the extra sites and the synthesized files counted', async () => {
    await createFromOperandRows(context(false), fakeResponse(), creation(
      { left: [statement(3)], right: [statement(4)] },
      { sites: [{ filePath: '/ws/other.fluid.js', line: 2, column: 0 }] },
    ));
    synthesis = 'other-file';
    await createFromOperandRows(context(false), fakeResponse(), creation({ left: [statement(3)], right: [face(0)] }));

    const refusal = { status: 422, body: { success: false, reason: 'the two sides come from different files' } };
    expect(answers).toEqual([refusal, refusal]);
    expect(dispatched).toEqual([]);
  });

  it('answers a missing scene with 404 and a refused synthesis with 422 and its pick', async () => {
    synthesis = 'none';
    await createFromOperandRows(context(false), fakeResponse(), creation({ left: [edge(0)], right: [statement(4)] }));
    synthesis = 'refused';
    await createFromOperandRows(context(false), fakeResponse(), creation({ left: [edge(0)], right: [statement(4)] }));

    expect(answers).toEqual([
      { status: 404, body: { success: false, reason: 'No rendered scene' } },
      { status: 422, body: { success: false, reason: 'no filter tells them apart', pick: { shapeId: 'body', sub: { type: 'edge', index: 0 } } } },
    ]);
    expect(dispatched).toEqual([]);
  });

  it('answers anything thrown with 500 and its message', async () => {
    await createFromOperandRows(context(true), fakeResponse(), creation({ left: [statement(3)], right: [statement(4)] }, {
      statement: () => {
        throw new Error('renderer broke');
      },
    }));

    expect(answers).toEqual([{ status: 500, body: { success: false, reason: 'renderer broke' } }]);
  });
});
