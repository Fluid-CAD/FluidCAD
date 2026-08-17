import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit.ts';

function exposeSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'expose',
    filePath: '/ws/x-plate.part.js',
    expose: { name: 'endFace', part: { line: 4, column: 9 } },
    producers: [{ line: 6, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
    imports: [],
    ...overrides,
  };
}

describe('applyFeatureEdit — expose', () => {
  it('inserts before the trailing return of the part callback body', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { rect(100, 50) })`,
      `    const e = extrude(30)`,
      `    return { thickness: 30 }`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('endFace', e.endFaces(0))`));
    const returnRow = lines.findIndex(l => l.trim() === 'return { thickness: 30 }');
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(returnRow);
    expect(lines[exposeRow].startsWith('    ')).toBe(true);
    expect(result.newCode).toContain(`import {expose, sketch, rect, extrude, part } from 'fluidcad/core'`);
  });

  it('appends at the end of a part body with no return', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { rect(100, 50) })`,
      `    const e = extrude(30)`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('endFace', e.endFaces(0))`));
    expect(exposeRow).toBeGreaterThan(-1);
    expect(lines[exposeRow - 1].includes('const e = extrude(30)')).toBe(true);
  });

  it('renders a global select() part with its imports', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { rect(100, 50) })`,
      `    extrude(30)`,
      `    return {}`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec({
      expose: { name: 'bore', part: { line: 4, column: 9 } },
      producers: [{ line: 6, column: 4, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: 'edge().circle(5)' }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('bore', select(edge().circle(5)))`));
    const returnRow = lines.findIndex(l => l.trim() === 'return {}');
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(returnRow);
    expect(result.newCode).toContain(`select`);
    expect(result.newCode).toContain(`from 'fluidcad/filters'`);
    // The bare extrude is anchor-only — it must NOT get a const binding.
    expect(result.newCode).toContain(`\n    extrude(30)`);
    expect(result.newCode).not.toContain('const e = extrude');
  });

  it('lands inside the executed if/else branch, before that branch\'s return', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function getExtrusion(size = '80x160') {`,
      `  return part('extrusion', () => {`,
      `    if (size === '80x80') {`,
      `      sketch('xy', () => { rect(10, 10) })`,
      `      extrude(10)`,
      `      return {}`,
      `    } else {`,
      `      sketch('xy', () => { rect(20, 20) })`,
      `      const e = extrude(30)`,
      `      return {}`,
      `    }`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec({
      producers: [{ line: 11, column: 6, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('endFace', e.endFaces(0))`));
    expect(exposeRow).toBeGreaterThan(-1);
    // Inside the else branch: directly after `const e = extrude(30)`, before
    // that branch's own return — not after the whole if/else (dead code).
    expect(lines[exposeRow - 1].includes('const e = extrude(30)')).toBe(true);
    expect(lines[exposeRow + 1].trim()).toBe('return {}');
    expect(lines[exposeRow].startsWith('      ')).toBe(true);
  });

  it('refuses when the spec line does not hold a part() call', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec({
      expose: { name: 'endFace', part: { line: 3, column: 0 } },
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('no part() call found');
    expect(result.newCode).toBe(code);
  });

  it('refuses a bound producer declared outside the part body', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      `part('housing', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec({
      expose: { name: 'endFace', part: { line: 5, column: 0 } },
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('outside this part() body');
    expect(result.newCode).toBe(code);
  });

  it('refuses a malformed spec (bad name, missing payload, extra parts)', async () => {
    const code = [
      `import { part } from 'fluidcad/core'`,
      `part('housing', () => {})`,
      ``,
    ].join('\n');

    for (const bad of [
      exposeSpec({ expose: undefined }),
      exposeSpec({ expose: { name: 'not an id', part: { line: 2, column: 0 } } }),
      exposeSpec({ expose: { name: '', part: { line: 2, column: 0 } } }),
      exposeSpec({ expose: { name: 'g1' } }),
      exposeSpec({ parts: [] }),
      exposeSpec({ producers: [] }),
    ]) {
      const result = await applyFeatureEdit(code, bad);
      expect(result.error).toBe('malformed expose edit spec');
      expect(result.newCode).toBe(code);
    }
  });

  it('emits a raw selector override verbatim', async () => {
    const code = [
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { rect(100, 50) })`,
      `    const e = extrude(30)`,
      `    return { thickness: 30 }`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, exposeSpec({
      rawArgs: `e.endFaces()`,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`expose('endFace', e.endFaces())`);
  });
});
