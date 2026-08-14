import { describe, it, expect } from 'vitest';
import { applyInsertParamsEdit } from '../src/insert-params-edit.ts';
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
});
