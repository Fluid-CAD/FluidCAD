import { describe, it, expect } from 'vitest';
import { applyInsertParamsEdit, getInsertParamExpressions } from '../src/insert-params-edit.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

describe('applyInsertParamsEdit', () => {
  it('creates the second argument when absent', async () => {
    const code = `const front = insert(extrusion);\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 300 } });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: 300 });\n`);
  });

  it('creates the second argument on a chained insert', async () => {
    const code = `const left = insert(extrusion).translate(-350, 0, 0).grounded();\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 300 } });
    expect(result.newCode).toBe(
      `const left = insert(extrusion, { Length: 300 }).translate(-350, 0, 0).grounded();\n`,
    );
  });

  it('appends a new label after the last existing property', async () => {
    const code = `const front = insert(extrusion, { Size: '80x80' });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 300 } });
    expect(result.newCode).toBe(
      `const front = insert(extrusion, { Size: '80x80', Length: 300 });\n`,
    );
  });

  it('replaces only the matching property value', async () => {
    const code = `const front = insert(extrusion, { Size: '80x80', Length: 150 });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 300 } });
    expect(result.newCode).toBe(
      `const front = insert(extrusion, { Size: '80x80', Length: 300 });\n`,
    );
  });

  it('preserves untouched expression entries verbatim', async () => {
    const code = `const front = insert(extrusion, { Length: width - 160, Size: '80x80' });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Size: '80x120' } });
    expect(result.newCode).toBe(
      `const front = insert(extrusion, { Length: width - 160, Size: '80x120' });\n`,
    );
  });

  it('replaces an expression when that exact label was edited', async () => {
    const code = `const front = insert(extrusion, { Length: width - 160 });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 540 } });
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: 540 });\n`);
  });

  it('rewrites a shorthand property into an explicit pair', async () => {
    const code = `const front = insert(extrusion, { Length });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 540 } });
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: 540 });\n`);
  });

  it('matches quoted labels and renders non-identifier keys quoted', async () => {
    const code = `const p = insert(plate, { 'Guide Width': 12 });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { 'Guide Width': 20 } });
    expect(result.newCode).toBe(`const p = insert(plate, { 'Guide Width': 20 });\n`);
  });

  it('splices an empty object open', async () => {
    const code = `const p = insert(plate, {});\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Thickness: 20 } });
    expect(result.newCode).toBe(`const p = insert(plate, { Thickness: 20 });\n`);
  });

  it('works with a factory-call first argument', async () => {
    const code = `const p = insert(sidePlate());\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Thickness: 20 } });
    expect(result.newCode).toBe(`const p = insert(sidePlate(), { Thickness: 20 });\n`);
  });

  it('applies several changes in one call', async () => {
    const code = `const front = insert(extrusion, { Length: 150 });\n`;
    const result = await applyInsertParamsEdit(code, {
      line: 1,
      set: { Length: 300, Size: '80x120', Capped: true },
    });
    expect(result.newCode).toBe(
      `const front = insert(extrusion, { Length: 300, Size: '80x120', Capped: true });\n`,
    );
  });

  it('addresses the statement by its line in a multi-line file', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      ``,
      `const a = insert(extrusion, { Length: 100 });`,
      `const b = insert(extrusion, { Length: 200 });`,
      ``,
    ].join('\n');
    const result = await applyInsertParamsEdit(code, { line: 4, set: { Length: 999 } });
    expect(result.newCode).toContain(`const a = insert(extrusion, { Length: 100 });`);
    expect(result.newCode).toContain(`const b = insert(extrusion, { Length: 999 });`);
  });

  it('refuses a non-insert statement', async () => {
    const code = `const m = mate('fastened', a, b);\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 1 } });
    expect(result.error).toContain('not an insert()');
    expect(result.newCode).toBe(code);
  });

  it('refuses a non-literal second argument', async () => {
    const code = `const p = insert(plate, opts);\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 1 } });
    expect(result.error).toContain('non-literal second argument');
    expect(result.newCode).toBe(code);
  });

  it('refuses unsupported values and empty sets, returning the original code', async () => {
    const code = `const p = insert(plate);\n`;
    const bad = await applyInsertParamsEdit(code, { line: 1, set: { Length: Number.NaN } });
    expect(bad.error).toContain(`'Length'`);
    expect(bad.newCode).toBe(code);
    const empty = await applyInsertParamsEdit(code, { line: 1, set: {} });
    expect(empty.error).toContain('No parameter changes');
  });

  it('refuses a line with no statement', async () => {
    const code = `const p = insert(plate);\n`;
    const result = await applyInsertParamsEdit(code, { line: 3, set: { Length: 1 } });
    expect(result.error).toContain('no statement found at line 3');
  });

  it('unset removes an entry and keeps its neighbors verbatim', async () => {
    const code = `const f = insert(extrusion, { Size: '80x80', Length: width - 160, Capped: true });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: {}, unset: ['Length'] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`const f = insert(extrusion, { Size: '80x80', Capped: true });\n`);
  });

  it('unset removes the first entry cleanly', async () => {
    const code = `const f = insert(extrusion, { Size: '80x80', Length: 150 });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: {}, unset: ['Size'] });
    expect(result.newCode).toBe(`const f = insert(extrusion, { Length: 150 });\n`);
  });

  it('unset of the last remaining entry drops the whole argument', async () => {
    const code = `const f = insert(extrusion, { Length: 900 }).grounded();\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: {}, unset: ['Length'] });
    expect(result.newCode).toBe(`const f = insert(extrusion).grounded();\n`);
  });

  it('unset no-ops on absent labels and missing arguments', async () => {
    const withArg = `const f = insert(extrusion, { Size: '80x80' });\n`;
    const noOp = await applyInsertParamsEdit(withArg, { line: 1, set: {}, unset: ['Length'] });
    expect(noOp.error).toBeUndefined();
    expect(noOp.newCode).toBe(withArg);
    const bare = `const f = insert(extrusion);\n`;
    const bareResult = await applyInsertParamsEdit(bare, { line: 1, set: {}, unset: ['Length'] });
    expect(bareResult.newCode).toBe(bare);
  });

  it('combines set and unset in one call', async () => {
    const code = `const f = insert(extrusion, { Size: '80x80', Length: 900 });\n`;
    const result = await applyInsertParamsEdit(code, {
      line: 1,
      set: { Size: '80x120' },
      unset: ['Length'],
    });
    expect(result.newCode).toBe(`const f = insert(extrusion, { Size: '80x120' });\n`);
  });

  it('refuses a label that is both set and reset', async () => {
    const code = `const f = insert(extrusion, { Length: 900 });\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: 5 }, unset: ['Length'] });
    expect(result.error).toContain('both set and reset');
    expect(result.newCode).toBe(code);
  });

  it('rides applyFeatureEdit as a side-channel spec', async () => {
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: '/ws/index.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      insertParams: { line: 1, set: { Length: 300 } },
    };
    const result = await applyFeatureEdit(`const front = insert(extrusion);\n`, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: 300 });\n`);
  });

  it('writes an { expr } value verbatim', async () => {
    const code = `const front = insert(extrusion, { Length: 540 });\n`;
    const result = await applyInsertParamsEdit(code, {
      line: 1,
      set: { Length: { expr: 'width - (80 * 2)' } },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: width - (80 * 2) });\n`);
  });

  it('creates the second argument from an { expr } value', async () => {
    const code = `const front = insert(extrusion);\n`;
    const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: { expr: 'width' } } });
    expect(result.newCode).toBe(`const front = insert(extrusion, { Length: width });\n`);
  });

  it('refuses unsafe { expr } text', async () => {
    const code = `const front = insert(extrusion, { Length: 540 });\n`;
    for (const expr of ['a; b', 'a, b', 'x = 5', 'a\nb', '(a']) {
      const result = await applyInsertParamsEdit(code, { line: 1, set: { Length: { expr } } });
      expect(result.error).toContain(`'Length'`);
      expect(result.newCode).toBe(code);
    }
  });

  it('lands newVariables declarations before the insert statement via applyFeatureEdit', async () => {
    const code = [
      `import { assembly, insert } from 'fluidcad/core';`,
      ``,
      `export const frame = assembly('frame', () => {`,
      `    const front = insert(extrusion, { Length: 540 });`,
      `});`,
      ``,
    ].join('\n');
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: '/ws/frame.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      insertParams: { line: 4, set: { Length: { expr: 'beamLength' } } },
      newVariables: [{ name: 'beamLength', initializer: '540' }],
    };
    const result = await applyFeatureEdit(code, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    const beamLength = 540;\n    const front = insert(extrusion, { Length: beamLength });`);
  });

  it('lands a param() declaration after the imports via applyFeatureEdit', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      ``,
      `const front = insert(extrusion, { Length: 540 });`,
      ``,
    ].join('\n');
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: '/ws/index.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      insertParams: { line: 3, set: { Length: { expr: 'beamLength' } } },
      newVariables: [{ name: 'beamLength', initializer: `param("beamLength", 540)` }],
    };
    const result = await applyFeatureEdit(code, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toMatch(/import \{\s*param, insert \} from 'fluidcad\/core';/);
    expect(result.newCode).toContain(`const beamLength = param("beamLength", 540);`);
    expect(result.newCode).toContain(`const front = insert(extrusion, { Length: beamLength });`);
  });
});

describe('getInsertParamExpressions', () => {
  it('returns non-literal entry texts keyed by label', async () => {
    const code = `const front = insert(extrusion, { Length: width - (80 * 2), Size: '80x80', Count: 4 });\n`;
    const result = await getInsertParamExpressions(code, 1);
    expect(result).toEqual({ Length: 'width - (80 * 2)' });
  });

  it('reads shorthand properties as their identifier', async () => {
    const code = `const front = insert(extrusion, { Length });\n`;
    const result = await getInsertParamExpressions(code, 1);
    expect(result).toEqual({ Length: 'Length' });
  });

  it('skips literal values, negative numbers and literal arrays included', async () => {
    const code = `const p = insert(plate, { A: -5, B: true, C: [1, 'x'], D: 'txt' });\n`;
    const result = await getInsertParamExpressions(code, 1);
    expect(result).toEqual({});
  });

  it('reads quoted labels and chained inserts', async () => {
    const code = `const p = insert(plate, { 'Guide Width': w / 2 }).translate(1, 2, 3);\n`;
    const result = await getInsertParamExpressions(code, 1);
    expect(result).toEqual({ 'Guide Width': 'w / 2' });
  });

  it('returns an empty map for a single-argument insert', async () => {
    expect(await getInsertParamExpressions(`const p = insert(plate);\n`, 1)).toEqual({});
  });

  it('returns null for a non-literal second argument', async () => {
    expect(await getInsertParamExpressions(`const p = insert(plate, opts);\n`, 1)).toBeNull();
  });

  it('returns null when the line has no insert()', async () => {
    expect(await getInsertParamExpressions(`const m = mate('fastened', a, b);\n`, 1)).toBeNull();
    expect(await getInsertParamExpressions(`const p = insert(plate);\n`, 5)).toBeNull();
  });
});
