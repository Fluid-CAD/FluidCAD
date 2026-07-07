import { describe, it, expect } from 'vitest';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

function spec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 3,
    filePath: '/ws/model.fluid.js',
    producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e' }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: [2] }],
    ...overrides,
  };
}

describe('applyFeatureEdit', () => {
  it('binds a bare producer statement and appends the fillet', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import {fillet, sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(3, e.endEdges(2))`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const binding', async () => {
    const code = [
      `import { sketch, rect, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const base = extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      parts: [{ producer: 0, accessor: 'endEdges', indices: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const base = extrude(30)`);
    expect(result.newCode).toContain(`fillet(3, base.endEdges())`);
    // No duplicate import added.
    expect(result.newCode.match(/fillet/g)!.length).toBe(2);
  });

  it('matches the file semicolon style', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { rect(100, 50) });`,
      `extrude(30);`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.newCode).toContain(`const e = extrude(30);`);
    expect(result.newCode).toContain(`fillet(3, e.endEdges(2));`);
  });

  it('inserts after later statements so the selection resolves on the final model', async () => {
    const code = [
      `import { sketch, rect, extrude, color } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `color('red')`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    const lines = result.newCode.split('\n');
    expect(lines.indexOf(`fillet(3, e.endEdges(2))`)).toBeGreaterThan(lines.indexOf(`color('red')`));
  });

  it('inserts before a trailing return inside a function body', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  const e = extrude(30)`,
      `  return e`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e' }],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const filletRow = lines.findIndex(l => l.includes('fillet(3, e.endEdges(2))'));
    const returnRow = lines.findIndex(l => l.trim() === 'return e');
    expect(filletRow).toBeGreaterThan(-1);
    expect(filletRow).toBeLessThan(returnRow);
    expect(lines[filletRow].startsWith('  ')).toBe(true);
  });

  it('allocates a fresh name when the hint collides', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `const e = 5`,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e' }],
    }));
    expect(result.newCode).toContain(`const e2 = extrude(30)`);
    expect(result.newCode).toContain(`fillet(3, e2.endEdges(2))`);
  });

  it('binds multiple producers and emits one arg per selector part', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch('xy', () => { rect(20, 20) })`,
      `extrude(50)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      value: 2,
      producers: [
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e' },
        { line: 6, column: 0, featureType: 'extrude', nameHint: 'e' },
      ],
      parts: [
        { producer: 0, accessor: 'endEdges', indices: null },
        { producer: 1, accessor: 'sideEdges', indices: [0, 3] },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30)`);
    expect(result.newCode).toContain(`const e2 = extrude(50)`);
    expect(result.newCode).toContain(`fillet(2, e.endEdges(), e2.sideEdges(0, 3))`);
  });

  it('refuses when the line does not hold a producer call', async () => {
    const code = [
      `import { sketch, rect, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30).new()`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, e)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e' }],
    }));
    expect(result.error).toContain('repeat()');
    expect(result.newCode).toBe(code);
  });

  it('refuses a producer call nested inside another expression', async () => {
    const code = [
      `import { sketch, rect, extrude, translate } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `translate([0, 0, 5], extrude(30))`,
      ``,
    ].join('\n');

    // The outermost call on line 4 is translate(...) — not a producer.
    const result = await applyFeatureEdit(code, spec());
    expect(result.error).toBeTruthy();
    expect(result.newCode).toBe(code);
  });

  it('handles a chained producer statement', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30).drill(false)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30).drill(false)`);
    expect(result.newCode).toContain(`fillet(3, e.endEdges(2))`);
  });

  it('adds the import when none exists', async () => {
    const code = [
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'chamfer',
      value: 1.5,
      producers: [{ line: 2, column: 0, featureType: 'extrude', nameHint: 'e' }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [0, 1] }],
    }));
    expect(result.newCode).toContain(`import { chamfer } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`chamfer(1.5, e.endEdges(0, 1))`);
  });
});
