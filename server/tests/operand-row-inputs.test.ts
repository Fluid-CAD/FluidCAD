// An operand-row tool's request, a row at a time: the rows read off a create
// or an edit body by their kinds (OperandInputs.validateRows /
// validateRowEdits), what they need (rowsPickGeometry, rowStatements), their
// resolution through one merger and one synthesis (resolveRows /
// resolveRowEdits), and an edit's direction (DirectionInputs.validateEdit).

import { describe, it, expect } from 'vitest';
import { OperandInputs, type OperandInput, type RowKinds } from '../src/routes/apply-feature/operand-inputs.ts';
import { DirectionInputs } from '../src/routes/apply-feature/direction-inputs.ts';
import { makeProducerMerger } from '../src/routes/apply-feature/synthesis.ts';
import type { Pick } from '../src/routes/apply-feature/picks.ts';

const KINDS: RowKinds<'left' | 'right'> = { left: 'curve', right: 'surface' };

const statement = (line: number): OperandInput => ({ kind: 'statement', filePath: '/ws/a.fluid.js', line, column: 0 });
const edge = (index: number): OperandInput => ({ kind: 'edge', shapeId: 's1', index });
const face = (index: number): OperandInput => ({ kind: 'face', shapeId: 's1', index });

describe('OperandInputs.validateRows', () => {
  it('reads each row by its name as picks of its kind', () => {
    expect(OperandInputs.validateRows({ left: [statement(3), edge(0)], right: [face(1)] }, KINDS)).toEqual({
      left: [statement(3), edge(0)], right: [face(1)],
    });
  });

  it('answers the first refusal in row order, naming the row', () => {
    expect(OperandInputs.validateRows({ left: [face(0)], right: [] }, KINDS)).toEqual({
      error: 'left takes curves and edges, not a face',
    });
    expect(OperandInputs.validateRows({ left: [edge(0)], right: [edge(1)] }, KINDS)).toEqual({
      error: 'right takes surfaces and faces, not an edge',
    });
    const missing = OperandInputs.validateRows(null, KINDS);
    expect('error' in missing && missing.error).toMatch(/^left must be a non-empty list of picks/);
  });
});

describe('OperandInputs.validateRowEdits', () => {
  it('leaves out a row absent or kept, and reads a re-picked row', () => {
    expect(OperandInputs.validateRowEdits({ right: [face(2)] }, KINDS)).toEqual({ right: [face(2)] });
    expect(OperandInputs.validateRowEdits({ left: { kind: 'keep' }, right: null }, KINDS)).toEqual({});
  });

  it('refuses a re-picked row as a create refuses it', () => {
    expect(OperandInputs.validateRowEdits({ left: [] }, KINDS)).toMatchObject({ error: expect.stringMatching(/^left must be/) });
  });
});

describe('what the rows need', () => {
  it('says whether any row picks an edge or a face', () => {
    expect(OperandInputs.rowsPickGeometry({ left: [statement(3)], right: [statement(4)] })).toBe(false);
    expect(OperandInputs.rowsPickGeometry({ right: [statement(4), face(0)] })).toBe(true);
    expect(OperandInputs.rowsPickGeometry({})).toBe(false);
  });

  it('lists the call sites of the whole objects, row by row in pick order', () => {
    expect(OperandInputs.rowStatements({ left: [edge(0), statement(5)], right: [statement(3)] }).map(loc => loc.line)).toEqual([5, 3]);
    expect(OperandInputs.rowStatements(undefined)).toEqual([]);
  });
});

describe('OperandInputs.resolveRows and resolveRowEdits', () => {
  /** A synthesis that adds one part per pick to a growing list, recording each call's picks. */
  function recordingSynthesis() {
    const calls: Pick[][] = [];
    let parts = 0;
    const synthesize = (picks: Pick[]): number[] => {
      calls.push(picks);
      return picks.map(() => parts++);
    };
    return { calls, synthesize };
  }

  it('resolves every row in row order through one merger, each row\'s entities synthesized together', async () => {
    const merger = makeProducerMerger();
    const { calls, synthesize } = recordingSynthesis();

    const picks = await OperandInputs.resolveRows({ right: [face(1), statement(4)], left: [statement(3), edge(0), edge(2)] }, KINDS, merger, synthesize);

    expect(picks).toEqual({
      left: [{ kind: 'producer', producer: 0 }, { kind: 'selector', part: 0 }, { kind: 'selector', part: 1 }],
      right: [{ kind: 'selector', part: 2 }, { kind: 'producer', producer: 1 }],
    });
    expect(calls.map(call => call.map(pick => pick.sub.type))).toEqual([['edge', 'edge'], ['face']]);
    expect(merger.producers.map(producer => [producer.line, producer.featureType])).toEqual([[3, 'wire'], [4, 'surface']]);
  });

  it('stops at the first row whose synthesis refuses', async () => {
    let calls = 0;
    const refuse = (): null => {
      calls++;
      return null;
    };
    expect(await OperandInputs.resolveRows({ left: [edge(0)], right: [face(0)] }, KINDS, makeProducerMerger(), refuse)).toBeNull();
    expect(calls).toBe(1);
  });

  it('writes a re-picked row as picks and leaves a kept one out', async () => {
    const { synthesize } = recordingSynthesis();
    expect(await OperandInputs.resolveRowEdits({ right: [face(0)] }, KINDS, makeProducerMerger(), synthesize)).toEqual({
      right: { kind: 'picks', picks: [{ kind: 'selector', part: 0 }] },
    });
    expect(await OperandInputs.resolveRowEdits({}, KINDS, makeProducerMerger(), synthesize)).toEqual({});
  });
});

describe('DirectionInputs.validateEdit', () => {
  it('keeps the statement\'s own direction when absent or kept', () => {
    expect(DirectionInputs.validateEdit(undefined)).toEqual({ edit: undefined });
    expect(DirectionInputs.validateEdit(null)).toEqual({ edit: undefined });
    expect(DirectionInputs.validateEdit({ kind: 'keep' })).toEqual({ edit: undefined });
  });

  it('drops it when cleared, and reads a new one', () => {
    expect(DirectionInputs.validateEdit({ kind: 'cleared' })).toEqual({ edit: { kind: 'cleared' } });
    expect(DirectionInputs.validateEdit({ kind: 'standard-plane', plane: 'xz' })).toEqual({ edit: { kind: 'standard-plane', plane: 'xz' } });
  });

  it('refuses a new direction as a create refuses it, naming the slot', () => {
    expect(DirectionInputs.validateEdit({ kind: 'standard-plane', plane: 'xx' })).toEqual({
      error: `the direction's origin plane must be "xy", "xz" or "yz"`,
    });
  });
});
