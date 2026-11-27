import { describe, it, expect } from 'vitest';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { choiceArgValue, operandListArgs } from '../src/apply-feature-edit/ast/args.ts';
import { decomposeChain, type ChainSegment } from '../src/apply-feature-edit/ast/chain.ts';
import { insideSketchCallback } from '../src/apply-feature-edit/ast/nodes.ts';
import { editableKindOf, parseFeatureStatement } from '../src/apply-feature-edit/index.ts';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

/** The statement call on `line` of `code`, and its chain. */
async function statementAt(code: string, line: number): Promise<{ call: TSNode; root: ChainSegment; members: ChainSegment[] }> {
  const tree = (await getJavaScriptParser()).parse(code);
  const call = findEditableCallAt(tree, splitLines(code), line)!;
  return { call, ...decomposeChain(call)! };
}

/** The dialog kind of the statement on `line`. */
async function kindAt(code: string, line: number): Promise<string | null> {
  const { call, root, members } = await statementAt(code, line);
  return editableKindOf({ root, members }, call);
}

/** The chained member `name` of the statement on `line`. */
async function memberAt(code: string, line: number, name: string): Promise<ChainSegment> {
  const { members } = await statementAt(code, line);
  return members.find(member => member.name === name)!;
}

const MODEL = src(
  `import { sketch, rect, offset, project, intersect, extrude, cut, fuse, plane } from 'fluidcad/core'`,
  ``,
  `const e = extrude(10)`,
  `sketch('xy', () => {`,
  `  rect(40, 20)`,
  `  offset(2).close()`,
  `  project(e.endFaces())`,
  `  intersect(e)`,
  `})`,
  `offset(2, e.endFaces())`,
  `project(e.endFaces())`,
  `intersect(e)`,
  `cut(5)`,
  `fuse(e, e)`,
  `toString()`,
  `sketch(plane(offset(3)), () => {`,
  `  [1, 2].forEach(() => {`,
  `    offset(1)`,
  `  })`,
  `})`,
);

describe('editableKindOf', () => {
  it('keeps the kinds of offset, project and intersect inside a sketch callback', async () => {
    expect(await kindAt(MODEL, 6)).toBe('offset');
    expect(await kindAt(MODEL, 7)).toBe('project');
    expect(await kindAt(MODEL, 8)).toBe('project');
  });

  it('keeps the kind each callee names outside a sketch, until the form outside has a dialog', async () => {
    expect(await kindAt(MODEL, 10)).toBe('offset');
  });

  it('reads project outside a sketch as the projected curve', async () => {
    expect(await kindAt(MODEL, 11)).toBe('projected-curve');
  });

  it('reads intersect outside a sketch as the intersection curve', async () => {
    expect(await kindAt(MODEL, 12)).toBe('intersection-curve');
  });

  it('answers every other callee by its name, and null for a call no dialog edits', async () => {
    expect(await kindAt(MODEL, 3)).toBe('extrude');
    expect(await kindAt(MODEL, 13)).toBe('extrude');
    expect(await kindAt(MODEL, 14)).toBe('boolean');
    expect(await kindAt(MODEL, 4)).toBe('sketch');
    expect(await kindAt(MODEL, 5)).toBeNull();
    expect(await kindAt(MODEL, 15)).toBeNull();
  });

  it('is what the statement parser reads a kind by', async () => {
    const inSketch = await parseFeatureStatement(MODEL, 6);
    expect(inSketch).toMatchObject({ ok: true, parsed: { feature: 'offset', value: 2, close: true } });

    const sectioned = await parseFeatureStatement(MODEL, 8);
    expect(sectioned).toMatchObject({ ok: true, parsed: { feature: 'project', op: 'intersect', argsText: 'e' } });

    const unknown = await parseFeatureStatement(MODEL, 15);
    expect(unknown).toEqual({ ok: false, reason: 'toString() is not an editable feature statement' });
  });
});

describe('insideSketchCallback', () => {
  it('is true in the callback body, a nested function included, and false in the target argument and outside', async () => {
    expect(insideSketchCallback((await statementAt(MODEL, 6)).call)).toBe(true);
    expect(insideSketchCallback((await statementAt(MODEL, 18)).call)).toBe(true);
    expect(insideSketchCallback((await statementAt(MODEL, 10)).call)).toBe(false);

    // `offset(3)` in `sketch(plane(offset(3)), …)` sits in the sketch's target, not its callback.
    const { root } = await statementAt(MODEL, 16);
    const target = root.args[0].childForFieldName('arguments')!.namedChildren[0]!;
    expect(target.text).toBe('offset(3)');
    expect(insideSketchCallback(target)).toBe(false);
  });
});

describe('the option value readers', () => {
  const TOOL = src(
    `import { project, extrude, select } from 'fluidcad/core'`,
    ``,
    `const a = extrude(10)`,
    `const b = extrude(20)`,
    `const mode = 'normal'`,
    `project(a, b).mode('normal').adjacent(a, b.sideFaces(0), select(face()))`,
    `project(a, b).mode('sideways').adjacent(...faces)`,
    `project(a, b).mode(mode).adjacent([a, b])`,
    'project(a, b).mode(`normal`).adjacent(3)',
    `project(a, b).mode(4).adjacent()`,
  );
  const MODES = ['direction', 'normal'] as const;

  it("reads a string literal out of a fixed set: .mode('normal')", async () => {
    const mode = await memberAt(TOOL, 6, 'mode');
    expect(choiceArgValue(mode.args[0], MODES)).toBe('normal');
  });

  it('refuses another word, a variable, a template and a number', async () => {
    for (const line of [7, 8, 9, 10]) {
      const mode = await memberAt(TOOL, line, 'mode');
      expect(choiceArgValue(mode.args[0], MODES), `line ${line}`).toBeNull();
    }
  });

  it('reads a list of operands with the statement each bare variable names: .adjacent(a, b)', async () => {
    const { call } = await statementAt(TOOL, 6);
    const adjacent = await memberAt(TOOL, 6, 'adjacent');

    expect(operandListArgs(adjacent.args, call.startIndex)).toEqual({
      texts: ['a', 'b.sideFaces(0)', 'select(face())'],
      refs: [{ line: 3, column: 10 }, null, null],
    });
  });

  it('refuses a spread, a list, a literal and an empty call', async () => {
    for (const line of [7, 8, 9, 10]) {
      const { call } = await statementAt(TOOL, line);
      const adjacent = await memberAt(TOOL, line, 'adjacent');
      expect(operandListArgs(adjacent.args, call.startIndex), `line ${line}`).toBeNull();
    }
  });
});
