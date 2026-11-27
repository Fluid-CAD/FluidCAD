// The shared pieces of a statement written from rows of curve or surface
// picks, on a fixture tool `join(left, right)` — a curve row and a surface
// row — and one written `wrap(gap, along, { onto })`, a value before its rows
// and a row in an options object: OperandRows (the rows' check, rendering,
// read-back, edit and part ledger), WordOption (a chained one-word option) and the `.direction(…)`
// chain helpers of Directions.

import { describe, it, expect } from 'vitest';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { decomposeChain, type ChainSegment } from '../src/apply-feature-edit/ast/chain.ts';
import {
  Directions,
  OperandRows,
  WordOption,
  type ApplyFeatureEditSpec,
  type EditRenderSpec,
  type OperandPick,
} from '../src/apply-feature-edit/index.ts';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

type Producer = ApplyFeatureEditSpec['producers'][number];
type Part = ApplyFeatureEditSpec['parts'][number];

const wire = (line: number, nameHint = 'c'): Producer => ({ line, column: 0, featureType: 'wire', nameHint, bind: true });
const surface = (line: number): Producer => ({ line, column: 0, featureType: 'surface', nameHint: 's', bind: true });
const solid = (line: number): Producer => ({ line, column: 0, featureType: 'extrude', nameHint: 'e', bind: true });
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices, filterArgs: null });
const whole = (producer: number): OperandPick => ({ kind: 'producer', producer });
const selector = (part: number): OperandPick => ({ kind: 'selector', part });

/** Names by producer index, null for an unnamed one. */
const named = (...names: (string | null)[]) => (producer: number): string | null => names[producer] ?? null;

/** The fixture: a curve row and a surface row. */
const JOIN = new OperandRows<'left' | 'right'>({
  callee: 'join',
  tool: 'join',
  rows: {
    left: { kind: 'curve', label: 'the left side', wants: 'a curve or edges' },
    right: { kind: 'surface', label: 'the right side', wants: 'a surface or faces' },
  },
  shapeError: 'join() takes two rows — edit it in the source',
});

/** A spec over a curve (0), a surface (1) and a solid (2) with an edge part (0) and a face part (1). */
const SPEC: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'> = {
  producers: [wire(3), surface(4), solid(5)],
  parts: [bucket(2, 'sideEdges', 0), bucket(2, 'endFaces')],
};

/** The call on `line` of `code`: its root arguments, its members by name, and where it starts. */
async function callAt(code: string, line: number): Promise<{ args: TSNode[]; members: Map<string, ChainSegment>; start: number }> {
  const tree = (await getJavaScriptParser()).parse(code);
  const call = findEditableCallAt(tree, splitLines(code), line)!;
  const chain = decomposeChain(call)!;
  return { args: chain.root.args, members: new Map(chain.members.map(member => [member.name, member])), start: call.startIndex };
}

const CODE = src(
  `import { join } from 'fluidcad/core'`,
  ``,
  `const rail = sketch('xy', () => {})`,
  `const skin = load('skin.step')`,
  `join(rail, [skin, e.endFaces()]).mode('all').direction('z')`,
  `join(rail)`,
  `join(...rows, skin)`,
);

describe('OperandRows', () => {
  it('lists its rows in argument order with the kind each takes', () => {
    expect(JOIN.names).toEqual(['left', 'right']);
    expect(JOIN.kinds).toEqual({ left: 'curve', right: 'surface' });
  });

  it('writes the call with each row in its place, one pick bare and several as a list', () => {
    const args = JOIN.arguments({ left: [whole(0)], right: [whole(1), selector(1)] }, SPEC.parts, named('rail', 'skin', 'e'));
    expect(args).toEqual({ left: 'rail', right: '[skin, e.endFaces()]' });
    expect(JOIN.call(args)).toBe('join(rail, [skin, e.endFaces()])');
  });

  it('words a malformed spec as the tool, with what is wrong when given', () => {
    expect(JOIN.malformed()).toBe('malformed join edit spec');
    expect(JOIN.malformed('bad mode')).toBe('malformed join edit spec: bad mode');
  });

  describe('check', () => {
    it('answers the selector parts the rows render', () => {
      expect(JOIN.check({ left: [selector(0)], right: [whole(1), selector(1)] }, SPEC)).toEqual({ parts: [0, 1] });
    });

    it('refuses a pick of the wrong kind as malformed, naming the row', () => {
      expect(JOIN.check({ left: [whole(1)], right: [whole(1)] }, SPEC)).toEqual({
        error: 'malformed join edit spec: the left side takes curves and edges: a pick references a statement that is neither',
      });
      expect(JOIN.check({ left: [whole(0)], right: [selector(0)] }, SPEC)).toEqual({
        error: 'malformed join edit spec: the right side takes surfaces and faces, not an edge',
      });
    });

    it('refuses an empty row in the tool\'s own words, the first row first', () => {
      expect(JOIN.check({ left: [], right: [] }, SPEC)).toEqual({ error: 'join: the left side is empty — pick a curve or edges for it' });
      expect(JOIN.check({ left: [whole(0)], right: [] }, SPEC)).toEqual({ error: 'join: the right side is empty — pick a surface or faces for it' });
    });
  });

  describe('parse and read', () => {
    it('reads each row back with its operands, the statements they name and the argument as written', async () => {
      const { args, start } = await callAt(CODE, 5);
      expect(JOIN.parse(args, start)).toEqual({
        leftTexts: ['rail'],
        leftRefs: [{ line: 3, column: 13 }],
        rightTexts: ['skin', 'e.endFaces()'],
        rightRefs: [{ line: 4, column: 13 }, null],
        leftArg: 'rail',
        rightArg: '[skin, e.endFaces()]',
      });
    });

    it('refuses another count of arguments, or a spread, in the tool\'s words', async () => {
      const short = await callAt(CODE, 6);
      expect(JOIN.parse(short.args, short.start)).toEqual({ error: 'join() takes two rows — edit it in the source' });
      const spread = await callAt(CODE, 7);
      expect(JOIN.parse(spread.args, spread.start)).toEqual({ error: 'join() takes two rows — edit it in the source' });
    });

    it('reads rows given by argument node, wherever they sit in the call', async () => {
      const { args, start } = await callAt(CODE, 5);
      const read = JOIN.read({ left: args[1], right: args[0] }, start);
      expect(read.leftArg).toBe('[skin, e.endFaces()]');
      expect(read.rightTexts).toEqual(['rail']);
    });
  });

  describe('edited', () => {
    const parsed = {
      leftTexts: ['rail'], leftRefs: [null], rightTexts: ['skin'], rightRefs: [null],
      leftArg: 'rail', rightArg: '[skin,  /* kept */ e.endFaces()]',
    };
    const editSpec = (parts: Part[] = []): EditRenderSpec => ({
      feature: 'intersection-curve', producers: [wire(3, 'rail2'), solid(5)], parts,
    });

    it('writes a kept row (absent too) verbatim and a re-picked row from its picks', () => {
      const result = JOIN.edited({ left: { kind: 'keep' } }, parsed, editSpec(), named());
      expect(result).toEqual({ args: { left: 'rail', right: '[skin,  /* kept */ e.endFaces()]' }, parts: [] });

      const repicked = JOIN.edited({ left: { kind: 'picks', picks: [whole(0)] } }, parsed, editSpec(), named());
      expect(repicked).toEqual({ args: { left: 'rail2', right: '[skin,  /* kept */ e.endFaces()]' }, parts: [] });
    });

    it('names a re-picked producer by the binding before its hint, and answers the parts the re-picks render', () => {
      const spec = editSpec([bucket(1, 'endFaces')]);
      const result = JOIN.edited({ right: { kind: 'picks', picks: [selector(0)] } }, parsed, spec, named(null, 'body'));
      expect(result).toEqual({ args: { left: 'rail', right: 'body.endFaces()' }, parts: [0] });
    });

    it('refuses a row neither kept nor picked, and a re-picked row that fails its check', () => {
      const odd = { kind: 'other' } as unknown as { kind: 'keep' };
      expect(JOIN.edited({ right: odd }, parsed, editSpec(), named())).toEqual({
        error: 'malformed join edit spec: the right side is neither kept nor picked',
      });
      expect(JOIN.edited({ left: { kind: 'picks', picks: [] } }, parsed, editSpec(), named())).toEqual({
        error: 'join: the left side is empty — pick a curve or edges for it',
      });
    });
  });

  describe('with a value before the rows and a row in an options object', () => {
    /** The fixture: `wrap(gap, along, { onto })` — a value, a curve row and a surface row written as an option. */
    const WRAP = new OperandRows<'along' | 'onto'>({
      callee: 'wrap',
      tool: 'wrap',
      values: ['gap'],
      rows: {
        along: { kind: 'curve', label: 'the curves', wants: 'a curve or edges' },
        onto: { kind: 'surface', label: '{ onto }', wants: 'faces', option: true },
      },
      shapeError: 'wrap() takes the gap, the curves and { onto } — edit it in the source',
      optionsError: 'wrap: the only option is { onto: faces } — edit it in the source',
    });
    const WRAPPED = src(
      `const rail = sketch('xy', () => {})`,
      `const onto = load('skin.step')`,
      `wrap(2, rail, { onto: [onto, e.endFaces()] })`,
      `wrap(gap * 2, [rail], { onto })`,
      `wrap(2, rail)`,
      `wrap(2, ...rails, { onto })`,
      `wrap(2, rail, onto)`,
      `wrap(2, rail, {})`,
      `wrap(2, rail, { onto, extend: true })`,
      `wrap(2, rail, { [key]: onto })`,
      `wrap(2, rail, { ...options })`,
      `wrap(2, rail, { 'onto': onto, /* kept */ })`,
    );

    it('lists every row, the option among them, with the kind each takes', () => {
      expect(WRAP.names).toEqual(['along', 'onto']);
      expect(WRAP.kinds).toEqual({ along: 'curve', onto: 'surface' });
    });

    it('writes the values first, the argument rows, then the option rows as one object, shorthand for a variable of its own name', () => {
      const args = WRAP.arguments({ along: [whole(0)], onto: [whole(1), selector(1)] }, SPEC.parts, named('rail', 'skin', 'e'));
      expect(args).toEqual({ along: 'rail', onto: '[skin, e.endFaces()]' });
      expect(WRAP.call(args, ['2'])).toBe('wrap(2, rail, { onto: [skin, e.endFaces()] })');
      expect(WRAP.call({ along: 'rail', onto: 'onto' }, ['gap'])).toBe('wrap(gap, rail, { onto })');
    });

    it('reads the rows back past the values, an option by its key and a shorthand as the variable it names', async () => {
      const listed = await callAt(WRAPPED, 3);
      expect(WRAP.parse(listed.args, listed.start)).toEqual({
        alongTexts: ['rail'],
        alongRefs: [{ line: 1, column: 13 }],
        ontoTexts: ['onto', 'e.endFaces()'],
        ontoRefs: [{ line: 2, column: 13 }, null],
        alongArg: 'rail',
        ontoArg: '[onto, e.endFaces()]',
      });
      const shorthand = await callAt(WRAPPED, 4);
      expect(WRAP.parse(shorthand.args, shorthand.start)).toEqual({
        alongTexts: ['rail'],
        alongRefs: [{ line: 1, column: 13 }],
        ontoTexts: ['onto'],
        ontoRefs: [{ line: 2, column: 13 }],
        alongArg: '[rail]',
        ontoArg: 'onto',
      });
      const quoted = await callAt(WRAPPED, 12);
      expect(WRAP.parse(quoted.args, quoted.start)).toMatchObject({ ontoTexts: ['onto'], ontoArg: 'onto' });
    });

    it('refuses another count of arguments, a spread or no options object in the shape\'s words', async () => {
      for (const line of [5, 6, 7]) {
        const { args, start } = await callAt(WRAPPED, line);
        expect(WRAP.parse(args, start), `line ${line}`).toEqual({ error: 'wrap() takes the gap, the curves and { onto } — edit it in the source' });
      }
    });

    it('refuses an options object missing its row, with another key, a computed key or a spread in the options\' words', async () => {
      for (const line of [8, 9, 10, 11]) {
        const { args, start } = await callAt(WRAPPED, line);
        expect(WRAP.parse(args, start), `line ${line}`).toEqual({ error: 'wrap: the only option is { onto: faces } — edit it in the source' });
      }
    });

    it('writes an edit with the rows kept or re-picked in their places', () => {
      const parsed = {
        alongTexts: ['rail'], alongRefs: [null], ontoTexts: ['onto'], ontoRefs: [null], alongArg: 'rail', ontoArg: 'onto',
      };
      const edited = WRAP.edited({ along: { kind: 'picks', picks: [whole(0)] } }, parsed, {
        feature: 'intersection-curve', producers: [wire(3, 'rail2')], parts: [],
      }, named());
      expect(edited).toEqual({ args: { along: 'rail2', onto: 'onto' }, parts: [] });
      expect(WRAP.call((edited as { args: Record<'along' | 'onto', string> }).args, ['2.50'])).toBe('wrap(2.50, rail2, { onto })');
    });
  });

  describe('partsError', () => {
    it('passes when every part is rendered exactly once', () => {
      expect(JOIN.partsError([1, 0], SPEC)).toBeNull();
    });

    it('refuses a part rendered twice or not at all, naming what may own one', () => {
      expect(JOIN.partsError([0], SPEC)).toBe('malformed join edit spec: every selector part belongs to exactly one pick');
      expect(JOIN.partsError([0, 0], SPEC, 'one pick or the direction')).toBe(
        'malformed join edit spec: every selector part belongs to exactly one pick or the direction',
      );
    });
  });
});

describe('WordOption', () => {
  const mode = new WordOption<'direction' | 'normal'>('mode', ['direction', 'normal']);

  it('knows its words', () => {
    expect(mode.has('normal')).toBe(true);
    expect(mode.has('sideways')).toBe(false);
    expect(mode.has(undefined)).toBe(false);
  });

  it('writes no chain for the default and the chain for any other word', () => {
    expect(mode.chain('direction')).toBe('');
    expect(mode.chain('normal')).toBe(`.mode('normal')`);
  });

  it('reads the chain back: the default when absent, the word, and refuses anything else', async () => {
    const code = src(
      `join(a, b)`,
      `join(a, b).mode('normal')`,
      `join(a, b).mode(m)`,
      `join(a, b).mode('sideways')`,
      `join(a, b).mode()`,
    );
    const read = async (line: number) => mode.read((await callAt(code, line)).members.get('mode'));
    expect(await read(1)).toEqual({ value: 'direction' });
    expect(await read(2)).toEqual({ value: 'normal' });
    const refusal = { error: `the .mode() argument is not 'direction' or 'normal' — edit it in the source` };
    expect(await read(3)).toEqual(refusal);
    expect(await read(4)).toEqual(refusal);
    expect(await read(5)).toEqual(refusal);
  });

  it('reads a create request\'s field, absent as the default, and an edit\'s, absent as kept', () => {
    expect(mode.fromRequest(undefined)).toEqual({ value: 'direction' });
    expect(mode.fromRequest(null)).toEqual({ value: 'direction' });
    expect(mode.fromRequest('normal')).toEqual({ value: 'normal' });
    expect(mode.editFromRequest(undefined)).toEqual({ value: undefined });
    expect(mode.editFromRequest('normal')).toEqual({ value: 'normal' });
    expect(mode.fromRequest('sideways')).toEqual({ error: 'mode must be "direction" or "normal"' });
    expect(mode.editFromRequest(3)).toEqual({ error: 'mode must be "direction" or "normal"' });
  });
});

describe('Directions, as a .direction(…) chain', () => {
  const spec = {
    producers: [{ line: 7, column: 0, featureType: 'axis', nameHint: 'a', bind: true }, solid(5)],
    parts: [bucket(1, 'sideEdges', 2)],
  } satisfies Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>;

  it('writes the chain for a text and nothing for none', () => {
    expect(Directions.chain(`'z'`)).toBe(`.direction('z')`);
    expect(Directions.chain(null)).toBe('');
  });

  it('answers the selector part a picked edge or face renders, and none for the other forms', () => {
    expect(Directions.parts({ kind: 'edge' })).toEqual([0]);
    expect(Directions.parts({ kind: 'face', part: 3 })).toEqual([3]);
    expect(Directions.parts({ kind: 'standard', axis: 'z' })).toEqual([]);
    expect(Directions.parts({ kind: 'axis', producer: 0 })).toEqual([]);
  });

  it('reads the chain back verbatim, null when absent, and refuses another argument shape', async () => {
    const code = src(
      `join(a, b)`,
      `join(a, b).direction(e.sideEdges(2))`,
      `join(a, b).direction('z', 'x')`,
      `join(a, b).direction(...d)`,
    );
    const read = async (line: number) => Directions.readChain((await callAt(code, line)).members.get('direction'));
    expect(await read(1)).toEqual({ text: null });
    expect(await read(2)).toEqual({ text: 'e.sideEdges(2)' });
    const refusal = { error: 'the .direction() chain has an argument shape the dialog cannot edit — edit it in the source' };
    expect(await read(3)).toEqual(refusal);
    expect(await read(4)).toEqual(refusal);
  });

  it('edits the argument: kept as written (absent too), cleared, or a new direction with its part', () => {
    expect(Directions.edited(undefined, `'x'`, spec, named())).toEqual({ text: `'x'`, parts: [] });
    expect(Directions.edited({ kind: 'keep' }, null, spec, named())).toEqual({ text: null, parts: [] });
    expect(Directions.edited({ kind: 'cleared' }, `'x'`, spec, named())).toEqual({ text: null, parts: [] });
    expect(Directions.edited({ kind: 'axis', producer: 0 }, `'x'`, spec, named())).toEqual({ text: 'a', parts: [] });
    expect(Directions.edited({ kind: 'edge', part: 0 }, null, spec, named(null, 'body'))).toEqual({ text: 'body.sideEdges(2)', parts: [0] });
  });

  it('refuses a new direction the spec does not hold, in the check\'s own words', () => {
    expect(Directions.edited({ kind: 'axis', producer: 1 }, null, spec, named())).toEqual({
      error: 'the direction references a non-axis producer',
    });
  });
});
