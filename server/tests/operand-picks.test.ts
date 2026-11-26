import { describe, it, expect } from 'vitest';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { decomposeChain } from '../src/apply-feature-edit/ast/chain.ts';
import {
  applyFeatureEdit,
  OperandPicks,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type OperandPick,
} from '../src/apply-feature-edit/index.ts';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

type Producer = ApplyFeatureEditSpec['producers'][number];
type Part = ApplyFeatureEditSpec['parts'][number];

const wire = (line: number): Producer => ({ line, column: 0, featureType: 'wire', nameHint: 'p', bind: true });
const surface = (line: number): Producer => ({ line, column: 0, featureType: 'surface', nameHint: 's', bind: true });
const solid = (line: number): Producer => ({ line, column: 0, featureType: 'extrude', nameHint: 'e', bind: true });

/** `<producer>.<accessor>(<indices>)`. */
const bucket = (producer: number, accessor: string, ...indices: number[]): Part =>
  ({ producer, accessor, indices, filterArgs: null });
/** `select(<filter>)`. */
const global = (filterArgs: string): Part => ({ producer: null, accessor: 'select', indices: null, filterArgs });

/** Names by producer index, null for an unnamed one. */
const named = (...names: (string | null)[]) => (producer: number): string | null => names[producer] ?? null;

/** The root arguments of the statement on `line` of `code`, and where it starts. */
async function argsAt(code: string, line: number): Promise<{ args: TSNode[]; start: number }> {
  const tree = (await getJavaScriptParser()).parse(code);
  const call = findEditableCallAt(tree, splitLines(code), line)!;
  return { args: decomposeChain(call)!.root.args, start: call.startIndex };
}

describe('OperandPicks.render', () => {
  const parts = [bucket(1, 'sideEdges', 0, 2), global('edge().circle(5)'), bucket(1, 'endFaces', 0)];

  it('renders a whole object as its variable', () => {
    expect(OperandPicks.render([{ kind: 'producer', producer: 0 }], parts, named('spine', 'e'))).toEqual(['spine']);
  });

  it('renders an edge or a face of a body as its selector', () => {
    expect(OperandPicks.render([{ kind: 'selector', part: 0 }], parts, named('spine', 'e'))).toEqual(['e.sideEdges(0, 2)']);
    expect(OperandPicks.render([{ kind: 'selector', part: 1 }], parts, named('spine', 'e'))).toEqual(['select(edge().circle(5))']);
  });

  it('renders several picks in pick order, and names an unnamed object f', () => {
    const picks: OperandPick[] = [
      { kind: 'selector', part: 2 }, { kind: 'producer', producer: 0 }, { kind: 'producer', producer: 2 },
    ];
    expect(OperandPicks.render(picks, parts, named('spine', 'e'))).toEqual(['e.endFaces(0)', 'spine', 'f']);
  });
});

describe('OperandPicks.argument', () => {
  it('writes one pick bare and several as a list', () => {
    expect(OperandPicks.argument(['spine'])).toBe('spine');
    expect(OperandPicks.argument(['spine', 'e.sideEdges(0)'])).toBe('[spine, e.sideEdges(0)]');
  });
});

describe('OperandPicks.edited', () => {
  const parts = [bucket(1, 'sideEdges', 0)];

  it('keeps the statement own texts for a kept or an absent slot', () => {
    expect(OperandPicks.edited(undefined, ['a', 'b'], parts, named())).toEqual(['a', 'b']);
    expect(OperandPicks.edited({ kind: 'keep' }, ['a', 'b'], parts, named())).toEqual(['a', 'b']);
  });

  it('writes the picks of a re-picked slot', () => {
    const edit = { kind: 'picks' as const, picks: [{ kind: 'selector' as const, part: 0 }] };
    expect(OperandPicks.edited(edit, ['a', 'b'], parts, named('spine', 'e'))).toEqual(['e.sideEdges(0)']);
  });
});

describe('OperandPicks.parse', () => {
  const CODE = src(
    `import { helix, extrude, project } from 'fluidcad/core'`,
    ``,
    `const spring = helix('z').radius(10)`,
    `const e = extrude(10)`,
    `project(spring, [spring, e.sideEdges(0), /* rim */ e])`,
  );

  it('reads a bare argument back as one operand with the statement its variable names', async () => {
    const { args, start } = await argsAt(CODE, 5);
    expect(OperandPicks.parse(args[0], start)).toEqual({ texts: ['spring'], refs: [{ line: 3, column: 15 }] });
  });

  it('reads a list back element by element, a selector naming no statement', async () => {
    const { args, start } = await argsAt(CODE, 5);
    expect(OperandPicks.parse(args[1], start)).toEqual({
      texts: ['spring', 'e.sideEdges(0)', 'e'],
      refs: [{ line: 3, column: 15 }, null, { line: 4, column: 10 }],
    });
  });

  it('reads a slot written as the call own arguments, one operand each', async () => {
    const { args, start } = await argsAt(CODE, 5);
    expect(OperandPicks.parseArguments(args, start).texts).toEqual(['spring', '[spring, e.sideEdges(0), /* rim */ e]']);
  });

  it('round-trips through argument: what render wrote is what parse reads', async () => {
    const exprs = ['spring', 'e.sideEdges(0)'];
    const code = CODE.replace(/^project.*$/m, `project(${OperandPicks.argument(exprs)}, ${OperandPicks.argument(['e'])})`);
    const { args, start } = await argsAt(code, 5);
    expect(OperandPicks.parse(args[0], start).texts).toEqual(exprs);
    expect(OperandPicks.parse(args[1], start).texts).toEqual(['e']);
  });
});

describe('OperandPicks.validate', () => {
  const spec = {
    producers: [wire(3), solid(4), surface(5), { ...wire(6), bind: false }],
    parts: [
      bucket(1, 'sideEdges', 0), bucket(1, 'endFaces', 0), global('face().planar()'), global('edge().circle(5)'),
      bucket(1, '', 0), bucket(1, 'instance(2).tipEdges', 1),
    ],
  };

  it('takes curve producers and edge selectors in a curve slot', () => {
    const picks = [
      { kind: 'producer', producer: 0 }, { kind: 'selector', part: 0 }, { kind: 'selector', part: 3 }, { kind: 'selector', part: 5 },
    ];
    expect(OperandPicks.validate('curve', picks, 'source', spec)).toEqual(picks);
  });

  it('refuses a face selector in a curve slot and names the slot', () => {
    expect(OperandPicks.validate('curve', [{ kind: 'selector', part: 1 }], 'source', spec))
      .toEqual({ error: 'source takes curves and edges, not a face' });
    expect(OperandPicks.validate('curve', [{ kind: 'selector', part: 2 }], 'source', spec))
      .toEqual({ error: 'source takes curves and edges, not a face' });
  });

  it('takes surface holders and face selectors in a surface slot, and refuses an edge selector', () => {
    const picks = [{ kind: 'producer', producer: 2 }, { kind: 'selector', part: 1 }, { kind: 'selector', part: 2 }];
    expect(OperandPicks.validate('surface', picks, 'target', spec)).toEqual(picks);
    expect(OperandPicks.validate('surface', [{ kind: 'selector', part: 0 }], 'target', spec))
      .toEqual({ error: 'target takes surfaces and faces, not an edge' });
  });

  it('refuses a producer of another kind, an unbound one and one out of range', () => {
    const refusal = { error: 'source takes curves and edges: a pick references a statement that is neither' };
    expect(OperandPicks.validate('curve', [{ kind: 'producer', producer: 1 }], 'source', spec)).toEqual(refusal);
    expect(OperandPicks.validate('curve', [{ kind: 'producer', producer: 2 }], 'source', spec)).toEqual(refusal);
    expect(OperandPicks.validate('curve', [{ kind: 'producer', producer: 3 }], 'source', spec)).toEqual(refusal);
    expect(OperandPicks.validate('curve', [{ kind: 'producer', producer: 9 }], 'source', spec)).toEqual(refusal);
    expect(OperandPicks.validate('surface', [{ kind: 'producer', producer: 0 }], 'target', spec))
      .toEqual({ error: 'target takes surfaces and faces: a pick references a statement that is neither' });
  });

  it('lets a selector through when its part does not say what it names', () => {
    expect(OperandPicks.validate('curve', [{ kind: 'selector', part: 4 }], 'source', spec))
      .toEqual([{ kind: 'selector', part: 4 }]);
  });

  it('refuses a value that is no list of picks', () => {
    expect(OperandPicks.validate('curve', { kind: 'producer' }, 'source', spec)).toEqual({ error: 'source must be a list of picks' });
    expect(OperandPicks.validate('curve', [{ kind: 'sketch', producer: 0 }], 'source', spec))
      .toEqual({ error: 'source holds a pick of an unknown kind' });
    expect(OperandPicks.validate('curve', [{ kind: 'selector', part: 12 }], 'source', spec))
      .toEqual({ error: 'source holds a pick that references no selector part' });
  });
});

describe('the features that write through OperandPicks keep their statements', () => {
  const SWEPT = src(
    `import { sketch, circle, ellipse, extrude, helix, sweep } from 'fluidcad/core'`,
    ``,
    `const spring = helix('z').radius(10).pitch(4).turns(6)`,
    `const e = extrude(10)`,
    `const s = sketch('xy', () => { circle(2) })`,
    `const p = sketch('xz', () => { ellipse(1, 60) })`,
    `sweep(p, s)`,
  );

  /** An edit of the sweep on line 7 that re-sources its path. */
  function pathEdit(path: unknown, extra: Partial<ApplyFeatureEditSpec>): ApplyFeatureEditSpec {
    return {
      feature: 'sweep',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: { line: 7, column: 0, sweep: { op: 'add', thin: null, path } },
      ...extra,
    } as ApplyFeatureEditSpec;
  }

  it('re-sources a sweep path to a wire statement and to a picked edge', async () => {
    const wired = await applyFeatureEdit(SWEPT, pathEdit({ kind: 'sketch', producer: 0 }, { producers: [wire(3)] }));
    expect(wired.error).toBeUndefined();
    expect(wired.newCode).toContain(`sweep(spring, s)\n`);

    const picked = await applyFeatureEdit(SWEPT, pathEdit(
      { kind: 'selector' }, { producers: [solid(4)], parts: [bucket(0, 'sideEdges', 0)] },
    ));
    expect(picked.error).toBeUndefined();
    expect(picked.newCode).toContain(`sweep(e.sideEdges(0), s)\n`);
  });

  it('keeps a sweep path that is not re-sourced', async () => {
    const kept = await applyFeatureEdit(SWEPT, pathEdit({ kind: 'keep' }, {}));
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`sweep(p, s)\n`);
  });

  it('refuses a sweep path that names a solid statement, a face, or more than one part', async () => {
    const solidPath = await applyFeatureEdit(SWEPT, pathEdit({ kind: 'sketch', producer: 0 }, { producers: [solid(4)] }));
    expect(solidPath.error).toBe('malformed sweep edit spec: the path takes curves and edges: a pick references a statement that is neither');

    const facePath = await applyFeatureEdit(SWEPT, pathEdit(
      { kind: 'selector' }, { producers: [solid(4)], parts: [bucket(0, 'endFaces', 0)] },
    ));
    expect(facePath.error).toBe('malformed sweep edit spec: the path takes curves and edges, not a face');

    const twoParts = await applyFeatureEdit(SWEPT, pathEdit(
      { kind: 'selector' }, { producers: [solid(4)], parts: [bucket(0, 'sideEdges', 0), bucket(0, 'sideEdges', 1)] },
    ));
    expect(twoParts.error).toBe('malformed sweep edit spec: a selector path is exactly one part');
  });

  it('reads a boolean targets back, variadic or as one list, with their statements', async () => {
    const code = src(
      `import { extrude, fuse, subtract } from 'fluidcad/core'`,
      ``,
      `const a = extrude(10)`,
      `const b = extrude(20)`,
      `fuse(a, b)`,
      `fuse([a, b])`,
      `subtract(a, b)`,
      `subtract([a, b])`,
      `fuse(a)`,
    );
    const targets = { targetTexts: ['a', 'b'], targetRefs: [{ line: 3, column: 10 }, { line: 4, column: 10 }] };

    expect(await parseFeatureStatement(code, 5)).toMatchObject({ ok: true, parsed: { feature: 'boolean', kind: 'fuse', ...targets } });
    expect(await parseFeatureStatement(code, 6)).toMatchObject({ ok: true, parsed: { feature: 'boolean', kind: 'fuse', ...targets } });
    expect(await parseFeatureStatement(code, 7)).toMatchObject({ ok: true, parsed: { feature: 'boolean', kind: 'subtract', ...targets } });
    expect(await parseFeatureStatement(code, 8))
      .toEqual({ ok: false, reason: 'a subtract takes exactly a base and a tool — edit it in the source' });
    expect(await parseFeatureStatement(code, 9)).toMatchObject({ ok: true, parsed: { targetTexts: ['a'] } });
  });

  it('writes a re-picked boolean target as its statement variable', async () => {
    const code = src(
      `import { extrude, fuse } from 'fluidcad/core'`,
      ``,
      `const a = extrude(10)`,
      `const b = extrude(20)`,
      `const c = extrude(30)`,
      `fuse(a, b)`,
    );
    const result = await applyFeatureEdit(code, {
      feature: 'boolean',
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 5, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
      edit: {
        line: 6, column: 0,
        boolean: { kind: 'common', targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }] },
      },
    } as ApplyFeatureEditSpec);

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`common(a, c)\n`);
  });
});
