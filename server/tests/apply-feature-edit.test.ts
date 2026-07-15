import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  extractNumericParams,
  makeProducerNamer,
  resolveParamValues,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit.ts';

function spec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 3,
    filePath: '/ws/model.fluid.js',
    producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
    imports: [],
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
      parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }],
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
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
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
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
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
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
        { line: 6, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'endEdges', indices: null, filterArgs: null },
        { producer: 1, accessor: 'sideEdges', indices: [0, 3], filterArgs: null },
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
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
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

  it('emits filter arguments on a bound accessor and imports the filter symbol', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: "edge().verticalTo('xz')" }],
      imports: ['edge'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(3, e.endEdges(edge().verticalTo('xz')))`);
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
  });

  it('writes a global select() anchored on an unbound statement', async () => {
    const code = [
      `import { sketch, rect, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(20, 20) })`,
      `const e = extrude(10).new()`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, e)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      value: 2,
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{
        producer: null,
        accessor: 'select',
        indices: null,
        filterArgs: "edge().onPlane('xy', 10).above('yz', 30).below('yz', 70)",
      }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    // No variable binding happened anywhere.
    expect(result.newCode).toContain(`repeat('linear', 'x', { count: 3, offset: 40 }, e)`);
    const lines = result.newCode.split('\n');
    const filletRow = lines.findIndex(l =>
      l === `fillet(2, select(edge().onPlane('xy', 10).above('yz', 30).below('yz', 70)))`);
    expect(filletRow).toBeGreaterThan(lines.findIndex(l => l.startsWith('repeat(')));
    expect(result.newCode).toContain(` select,`);
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
  });

  it('hoists an anchor inside a loop body to the enclosing function scope', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `for (let i = 0; i < 3; i++) {`,
      `  sketch('xy', () => { rect(20, 20) })`,
      `  extrude(10)`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: "edge().circle(5)" }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const filletRow = lines.findIndex(l => l.includes('fillet(3, select(edge().circle(5)))'));
    const loopCloseRow = lines.findIndex(l => l === '}');
    // Inserted after the loop, at top level — never inside the loop body.
    expect(filletRow).toBeGreaterThan(loopCloseRow);
    expect(lines[filletRow].startsWith(' ')).toBe(false);
  });

  it('refuses a part that references an unbound producer', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }],
    }));
    expect(result.error).toContain('unbound producer');
    expect(result.newCode).toBe(code);
  });

  it('emits a user-edited argument list verbatim and derives its imports', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      // Synthesis produced endEdges(2); the user widened it to the whole
      // bucket plus a select() — the override wins and brings its imports.
      rawArgs: 'e.endEdges(), select(edge().circle(5))',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(3, e.endEdges(), select(edge().circle(5)))`);
    expect(result.newCode).toContain(` select,`);
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
    // The producer still gets bound — the override references its variable.
    expect(result.newCode).toContain(`const e = extrude(30)`);
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
      producers: [{ line: 2, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [0, 1], filterArgs: null }],
    }));
    expect(result.newCode).toContain(`import { chamfer } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`chamfer(1.5, e.endEdges(0, 1))`);
  });
});

describe('shell and sketch statement templates', () => {
  it('emits shell with a negative thickness and imports it', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'shell',
      value: -2,
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import {shell, sketch, rect, extrude } from 'fluidcad/core'`);
    expect(result.newCode).toContain(`const e = extrude(30)`);
    expect(result.newCode).toContain(`shell(-2, e.endFaces())`);
  });

  it('emits a shell join chain for a non-default join type', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'shell',
      value: -2,
      shell: { joinType: 'tangent' },
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, e.endFaces()).join('tangent')`);
  });

  it('emits no join chain for the default arc join type', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'shell',
      value: -2,
      shell: { joinType: 'arc' },
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, e.endFaces())`);
    expect(result.newCode).not.toContain(`.join(`);
  });

  it('emits sketch with an empty multi-line callback and no numeric parameter', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'sketch',
      value: undefined,
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      `sketch(e.endFaces(), () => {`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('indents the sketch callback body inside a function scope and keeps semicolon style', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core';`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { rect(100, 50) });`,
      `  const e = extrude(30);`,
      `  return e;`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'sketch',
      value: undefined,
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  sketch(e.endFaces(), () => {`,
      ``,
      `  });`,
      `  return e;`,
    ].join('\n'));
  });

  it('refuses a sketch spec with more than one selector part', async () => {
    const code = [
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'sketch',
      value: undefined,
      producers: [{ line: 2, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [
        { producer: 0, accessor: 'endFaces', indices: null, filterArgs: null },
        { producer: 0, accessor: 'startFaces', indices: null, filterArgs: null },
      ],
    }));
    expect(result.error).toBe('sketch takes a single face selection');
    expect(result.newCode).toBe(code);
  });

  it('wraps a user-edited argument list in the sketch callback template', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'sketch',
      value: undefined,
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
      rawArgs: 'select(face().onPlane(\'xy\', 30))',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch(select(face().onPlane('xy', 30)), () => {`);
    expect(result.newCode).toMatch(/import \{\s*select,/);
    expect(result.newCode).toContain(`import { face } from 'fluidcad/filters';`);
  });
});

describe('plane sketch (no picks)', () => {
  const planeSpec = () => spec({ feature: 'sketch', value: undefined, producers: [], parts: [] });

  it('appends the statement after the last statement without binding anything', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, planeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch(() => {`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('starts an empty file with the statement and its import', async () => {
    const result = await applyFeatureEdit('', planeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch } from 'fluidcad/core';`,
      `sketch(() => {`,
      ``,
      `});`,
      ``,
    ].join('\n'));
  });

  it('targets the plane the spec carries', async () => {
    const result = await applyFeatureEdit('', { ...planeSpec(), sketchPlane: 'xz' });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xz', () => {`);
  });

  it('matches the file semicolon style', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { rect(100, 50) });`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, planeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `sketch('xy', () => { rect(100, 50) });`,
      `sketch(() => {`,
      ``,
      `});`,
    ].join('\n'));
  });
});

describe('part()-scoped insertion', () => {
  it('inserts a select()-based edit at the end of the enclosing part() body', async () => {
    const code = [
      `import { part, sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `part('a', () => {`,
      `    sketch('xy', () => { rect(20, 20) })`,
      `    extrude(10)`,
      `})`,
      ``,
      `part('b', () => {`,
      `    sketch('xy', () => { rect(30, 30) })`,
      `    extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: 'edge().arc()' }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    // The statement lands inside part 'a', after its extrude and before the
    // closing brace — never at the end of the file where the select() would
    // resolve against a different (or no) part scope.
    const insertedAt = result.newCode.indexOf(`fillet(3, select(edge().arc()))`);
    expect(insertedAt).toBeGreaterThan(result.newCode.indexOf('extrude(10)'));
    expect(insertedAt).toBeLessThan(result.newCode.indexOf(`part('b'`));
    // No variable was bound to the anchor.
    expect(result.newCode).not.toContain('const e = extrude(10)');
  });
});

describe('breakpoint-aware insertion', () => {
  it('inserts the feature before an active breakpoint, not at end of scope', async () => {
    const code = [
      `import { sketch, rect, extrude, color, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `breakpoint()`,
      `color('red')`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const filletRow = lines.indexOf(`fillet(3, e.endEdges(2))`);
    expect(filletRow).toBeGreaterThan(lines.indexOf(`const e = extrude(30)`));
    expect(filletRow).toBeLessThan(lines.indexOf(`breakpoint()`));
  });

  it('inserts before the breakpoint inside a function body, keeping the indent', async () => {
    const code = [
      `import { sketch, rect, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  const e = extrude(30)`,
      `  breakpoint()`,
      `  return e`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const filletRow = lines.indexOf(`  fillet(3, e.endEdges(2))`);
    expect(filletRow).toBeGreaterThan(-1);
    expect(filletRow).toBeLessThan(lines.indexOf(`  breakpoint()`));
  });

  it('ignores a breakpoint that precedes the producer', async () => {
    const code = [
      `import { sketch, rect, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `breakpoint()`,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(lines.indexOf(`fillet(3, e.endEdges(2))`)).toBeGreaterThan(lines.indexOf(`const e = extrude(30)`));
  });

  it('inserts a plane sketch before an active breakpoint', async () => {
    const code = [
      `import { sketch, rect, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `breakpoint()`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(
      code,
      spec({ feature: 'sketch', value: undefined, producers: [], parts: [] }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, rect, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch(() => {`,
      ``,
      `})`,
      `breakpoint()`,
      ``,
    ].join('\n'));
  });
});

describe('makeProducerNamer', () => {
  it('returns the existing const name for a bound producer', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const base = extrude(30)`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    expect(namer([{ line: 4, nameHint: 'e' }])).toEqual(['base']);
  });

  it('suffixes past colliding file identifiers for a bare statement', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `const e = 42`,
      `sketch('xy', () => { rect(100, e) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    // `e` is taken by the user's own variable — the transform would write
    // `const e2 = extrude(30)`, so the preview must say `e2` too.
    expect(namer([{ line: 5, nameHint: 'e' }])).toEqual(['e2']);
  });

  it('maps unresolvable producers to null', async () => {
    const code = [
      `import { repeat } from 'fluidcad/core'`,
      ``,
      `repeat('linear', ['x'], { count: 3, length: 30 })`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    // Line 3 is not a producer callee; line 99 has no call at all.
    expect(namer([
      { line: 3, nameHint: 'e' },
      { line: 99, nameHint: 'e' },
    ])).toEqual([null, null]);
  });
});

describe('extractNumericParams', () => {
  it('collects top-level numeric const/let/var declarations', async () => {
    const code = [
      `import { sketch } from 'fluidcad/core'`,
      ``,
      `const height = 30`,
      `let width = 12.5`,
      `var depth = -4`,
      `const name = 'hello'`,
      `const computed = 10 + 5`,
      `function build() {`,
      `  const local = 7`,
      `}`,
      ``,
    ].join('\n');

    const params = await extractNumericParams(code);
    expect(params).toEqual([
      { name: 'height', value: 30 },
      { name: 'width', value: 12.5 },
      { name: 'depth', value: -4 },
    ]);
  });

  it('extracts param() declarations with their label and numeric default', async () => {
    const code = [
      `import { param } from 'fluidcad/core'`,
      ``,
      `const baseThickness = param("Base Thickness", 12)`,
      `const sides = param("Sides", 6, 'number', { min: 3, max: 12 })`,
      `const offset = param('Offset', -4)`,
      `const label = param("Label", 'engraved')`,
      ``,
    ].join('\n');

    const params = await extractNumericParams(code);
    expect(params).toEqual([
      { name: 'baseThickness', value: 12, label: 'Base Thickness' },
      { name: 'sides', value: 6, label: 'Sides' },
      { name: 'offset', value: -4, label: 'Offset' },
    ]);
  });

  it('resolves param() entries against the registry, override-aware', () => {
    const entries = [
      { name: 'height', value: 30 },
      { name: 'baseThickness', value: 12, label: 'Base Thickness' },
      { name: 'engraving', value: 1, label: 'Engraving' },
      { name: 'legacy', value: 5, label: 'Removed Param' },
    ];
    const definitions = [
      { label: 'Base Thickness', currentValue: 15 },   // overridden in the UI
      { label: 'Engraving', currentValue: 'deep' },    // non-numeric — never links
    ];

    expect(resolveParamValues(entries, definitions)).toEqual([
      { name: 'height', value: 30 },
      { name: 'baseThickness', value: 15 },
      { name: 'legacy', value: 5 },
    ]);
  });
});

describe('extrude statement templates', () => {
  function extrudeSpec(
    extrude: Partial<NonNullable<ApplyFeatureEditSpec['extrude']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'extrude',
      filePath: '/ws/model.fluid.js',
      extrude: {
        op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, drill: true,
        thin: null, profile: 'implicit', ...extrude,
      },
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const activeSketchCode = [
    `import { sketch, rect } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { rect(100, 50) })`,
    ``,
  ].join('\n');

  it('appends an implicit-profile extrude after the active sketch', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const sketchRow = lines.findIndex(l => l.startsWith(`sketch('xy'`));
    expect(lines[sketchRow + 1]).toBe(`extrude(25)`);
    expect(result.newCode).toMatch(/import \{ ?extrude,/);
  });

  it('renders a through-all remove as cut() and imports cut', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ op: 'remove', distance: null }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`cut()`);
    expect(result.newCode).toMatch(/import \{ ?cut,/);
    expect(result.newCode).not.toMatch(/import \{ ?extrude,/);
  });

  it('renders a depth-limited remove as cut(depth)', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ op: 'remove', distance: 7 }));
    expect(result.newCode).toContain(`cut(7)`);
  });

  it('chains .thin() and .new() after the call', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ op: 'new', distance: 10, thin: [2] }));
    expect(result.newCode).toContain(`extrude(10).thin(2).new()`);
  });

  it('renders both thin offsets', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ thin: [1.5, 3] }));
    expect(result.newCode).toContain(`extrude(25).thin(1.5, 3)`);
  });

  it('renders a two-distance extrude', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ distance: 10, distance2: 20 }));
    expect(result.newCode).toContain(`extrude(10, 20)`);
  });

  it('chains .symmetric(), .draft() and .drill(false) before thin and new', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({
      op: 'new', distance: 10, symmetric: true, draft: -2.5, drill: false, thin: [1],
    }));
    expect(result.newCode).toContain(`extrude(10).symmetric().draft(-2.5).drill(false).thin(1).new()`);
  });

  it('renders a symmetric through-all cut', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({
      op: 'remove', distance: null, symmetric: true,
    }));
    expect(result.newCode).toContain(`cut().symmetric()`);
  });

  it('binds a bound-profile sketch and inserts directly after it', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `sketch('xz', () => { circle(10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec(
      { profile: 'bound' },
      { producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const boundRow = lines.findIndex(l => l === `const s = sketch('xy', () => { rect(100, 50) })`);
    expect(boundRow).toBeGreaterThan(-1);
    expect(lines[boundRow + 1]).toBe(`extrude(25, s)`);
    // The later sketch stays last, so it remains the active sketch.
    expect(lines[boundRow + 2]).toBe(`sketch('xz', () => { circle(10) })`);
  });

  it('reuses an existing const binding for the bound profile', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { rect(100, 50) })`,
      `sketch('xz', () => { circle(10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec(
      { profile: 'bound' },
      { producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const profileRow = lines.findIndex(l => l === `const profile = sketch('xy', () => { rect(100, 50) })`);
    expect(lines[profileRow + 1]).toBe(`extrude(25, profile)`);
  });

  it('matches the file semicolon style', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { rect(100, 50) });`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec());
    expect(result.newCode).toContain(`extrude(25);`);
  });

  it('refuses when the profile line is not a sketch call', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec(
      {},
      { producers: [{ line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: false }] },
    ));
    expect(result.error).toContain('extrude()');
    expect(result.newCode).toBe(code);
  });

  it('refuses a malformed spec carrying selector parts', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec(
      {},
      { parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }] },
    ));
    expect(result.error).toContain('malformed');
  });

  const toFaceCode = [
    `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { rect(100, 50) })`,
    `extrude(30)`,
    `sketch('xz', () => { circle(10) })`,
    ``,
  ].join('\n');

  it('renders a to-face extrude from its selector part at end of scope, even with a bound profile', async () => {
    const result = await applyFeatureEdit(toFaceCode, extrudeSpec(
      { profile: 'bound', toFace: true, distance: null },
      {
        producers: [
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
        ],
        parts: [{ producer: 1, accessor: 'endFaces', indices: null, filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(lines).toContain(`const e = extrude(30)`);
    const profileRow = lines.findIndex(l => l === `const s = sketch('xz', () => { circle(10) })`);
    // End of scope, not directly after the bound profile — the face selector
    // must resolve on the final model.
    expect(lines[profileRow + 1]).toBe(`extrude(e.endFaces(), s)`);
  });

  it('renders an implicit-profile to-face cut from a global select part', async () => {
    const result = await applyFeatureEdit(toFaceCode, extrudeSpec(
      { op: 'remove', toFace: true, distance: null },
      {
        producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
        parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: `face().parallelTo('xy')` }],
        imports: ['select', 'face'],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`cut(select(face().parallelTo('xy')))`);
    expect(result.newCode).toMatch(/import \{.*select.*\} from 'fluidcad\/core'/);
  });

  it('refuses a to-face spec without its selector part', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ toFace: true, distance: null }));
    expect(result.error).toContain('malformed');
  });
});

describe('makeProducerNamer — sketch producers', () => {
  it('resolves a bound sketch by its const name', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { rect(100, 50) })`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    expect(namer([{ line: 3, nameHint: 's', featureType: 'sketch' }])).toEqual(['profile']);
  });

  it('allocates the hint for a bare sketch statement and refuses non-sketch lines', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    expect(namer([
      { line: 3, nameHint: 's', featureType: 'sketch' },
      { line: 4, nameHint: 's', featureType: 'sketch' },
    ])).toEqual(['s', null]);
  });
});

describe('sweep statement templates', () => {
  function sweepSpec(
    sweep: Partial<NonNullable<ApplyFeatureEditSpec['sweep']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'sweep',
      filePath: '/ws/model.fluid.js',
      sweep: {
        op: 'add', thin: null, profile: 'implicit',
        path: { kind: 'sketch', producer: 0 },
        ...sweep,
      },
      producers: [
        { line: 3, column: 0, featureType: 'sketch', nameHint: 'p', bind: true },
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
      ],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const twoSketchCode = [
    `import { sketch, rect, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xz', () => { circle(5) })`,
    `sketch('xy', () => { rect(10, 10) })`,
    ``,
  ].join('\n');

  it('binds a sketch path and appends sweep(p) after the implicit profile', async () => {
    const result = await applyFeatureEdit(twoSketchCode, sweepSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const pathRow = lines.findIndex(l => l === `const p = sketch('xz', () => { circle(5) })`);
    expect(pathRow).toBeGreaterThan(-1);
    // End-of-scope insertion: after the (implicit-profile) active sketch.
    expect(lines[pathRow + 1]).toBe(`sketch('xy', () => { rect(10, 10) })`);
    expect(lines[pathRow + 2]).toBe(`sweep(p)`);
    expect(result.newCode).toMatch(/import \{ ?sweep,/);
  });

  it('inserts a fully-bound sweep after the later input sketch', async () => {
    const code = [
      `import { sketch, rect, circle, polygon } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { rect(10, 10) })`,
      `sketch('yz', () => { polygon(6, 20) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      { profile: { producer: 1 }, path: { kind: 'sketch', producer: 0 } },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 'p', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const profileRow = lines.findIndex(l => l === `const s = sketch('xy', () => { rect(10, 10) })`);
    expect(profileRow).toBeGreaterThan(-1);
    expect(lines[profileRow + 1]).toBe(`sweep(p, s)`);
    // The later sketch stays last, so it remains the active sketch.
    expect(lines[profileRow + 2]).toBe(`sketch('yz', () => { polygon(6, 20) })`);
  });

  it('renders a selector path at end of scope with the implicit profile', async () => {
    const code = [
      `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { circle(5) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      { path: { kind: 'selector' } },
      {
        producers: [
          { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        ],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(result.newCode).toContain(`const e = extrude(30)`);
    const sweepRow = lines.findIndex(l => l === `sweep(e.endEdges(2))`);
    expect(sweepRow).toBeGreaterThan(lines.findIndex(l => l.startsWith(`sketch('xz'`)));
  });

  it('chains .thin() and .remove()', async () => {
    const result = await applyFeatureEdit(twoSketchCode, sweepSpec({ op: 'remove', thin: [2] }));
    expect(result.newCode).toContain(`sweep(p).thin(2).remove()`);
  });

  it('chains .new()', async () => {
    const result = await applyFeatureEdit(twoSketchCode, sweepSpec({ op: 'new' }));
    expect(result.newCode).toContain(`sweep(p).new()`);
  });

  it('reuses an existing const binding for the path sketch', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `const spine = sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { rect(10, 10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const spine = sketch('xz', () => { circle(5) })`);
    expect(result.newCode).toContain(`sweep(spine)`);
  });

  it('refuses when a sketch producer line is not a sketch call', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      {},
      {
        producers: [
          { line: 4, column: 0, featureType: 'sketch', nameHint: 'p', bind: true },
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        ],
      },
    ));
    expect(result.error).toContain('expected a sketch() call');
    expect(result.newCode).toBe(code);
  });

  it('refuses a selector path without parts', async () => {
    const result = await applyFeatureEdit(twoSketchCode, sweepSpec({ path: { kind: 'selector' } }));
    expect(result.error).toContain('malformed');
  });
});

describe('loft statement templates', () => {
  function loftSpec(
    loft: Partial<NonNullable<ApplyFeatureEditSpec['loft']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'loft',
      filePath: '/ws/model.fluid.js',
      loft: {
        op: 'add', thin: null,
        profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'sketch', producer: 1 }],
        ...loft,
      },
      producers: [
        { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      ],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const twoSketchCode = [
    `import { sketch, rect, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { rect(10, 10) })`,
    `sketch('xz', () => { circle(5) })`,
    ``,
  ].join('\n');

  it('binds both sketches and inserts directly after the latest input', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const firstRow = lines.findIndex(l => l === `const s = sketch('xy', () => { rect(10, 10) })`);
    expect(firstRow).toBeGreaterThan(-1);
    expect(lines[firstRow + 1]).toBe(`const s2 = sketch('xz', () => { circle(5) })`);
    expect(lines[firstRow + 2]).toBe(`loft(s, s2)`);
    expect(result.newCode).toMatch(/import \{ ?loft,/);
  });

  it('keeps a later active sketch active when every input is earlier', async () => {
    const code = [
      `import { sketch, rect, circle, polygon } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      `sketch('yz', () => { polygon(6, 20) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const loftRow = lines.findIndex(l => l === `loft(s, s2)`);
    expect(loftRow).toBeGreaterThan(-1);
    // The uninvolved sketch stays last, so it remains the active sketch.
    expect(lines[loftRow + 1]).toBe(`sketch('yz', () => { polygon(6, 20) })`);
  });

  it('preserves the profile argument order independent of producer order', async () => {
    const code = [
      `import { sketch, rect, circle, polygon } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      `sketch('yz', () => { polygon(6, 20) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec(
      {
        profiles: [
          { kind: 'sketch', producer: 2 },
          { kind: 'sketch', producer: 0 },
          { kind: 'sketch', producer: 1 },
        ],
      },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s3, s, s2)`);
  });

  it('renders a selector profile at end of scope', async () => {
    const code = [
      `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { circle(5) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec(
      { profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'selector', part: 0 }] },
      {
        producers: [
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
        ],
        parts: [{ producer: 1, accessor: 'endFaces', indices: null, filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(result.newCode).toContain(`const e = extrude(30)`);
    const loftRow = lines.findIndex(l => l === `loft(s, e.endFaces())`);
    expect(loftRow).toBeGreaterThan(lines.findIndex(l => l.startsWith(`const s = sketch('xz'`)));
  });

  it('chains .thin() and .remove()', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({ op: 'remove', thin: [2] }));
    expect(result.newCode).toContain(`loft(s, s2).thin(2).remove()`);
  });

  it('chains .new()', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({ op: 'new' }));
    expect(result.newCode).toContain(`loft(s, s2).new()`);
  });

  it('reuses existing const bindings for the profile sketches', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `const base = sketch('xy', () => { rect(10, 10) })`,
      `const tip = sketch('xz', () => { circle(5) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(base, tip)`);
  });

  it('refuses when a sketch producer line is not a sketch call', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec(
      {},
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        ],
      },
    ));
    expect(result.error).toContain('expected a sketch() call');
    expect(result.newCode).toBe(code);
  });

  it('refuses fewer than two profiles', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec(
      { profiles: [{ kind: 'sketch', producer: 0 }] },
    ));
    expect(result.error).toContain('malformed');
  });

  it('refuses a selector profile without its part', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec(
      { profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'selector', part: 0 }] },
    ));
    expect(result.error).toContain('malformed');
  });

  it('refuses parts no profile references', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec(
      {},
      { parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }] },
    ));
    expect(result.error).toContain('malformed');
  });

  const threeSketchCode = [
    `import { sketch, rect, circle, bezier } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { rect(10, 10) })`,
    `sketch('xz', () => { circle(5) })`,
    `sketch('yz', () => { bezier([0, 0], [5, 10], [0, 20]) })`,
    ``,
  ].join('\n');

  const threeProducers: Partial<ApplyFeatureEditSpec> = {
    producers: [
      { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      { line: 5, column: 0, featureType: 'sketch', nameHint: 'g', bind: true },
    ],
  };

  it('chains .guides() and inserts after the latest input — the guide', async () => {
    const result = await applyFeatureEdit(threeSketchCode, loftSpec(
      { guides: [{ kind: 'sketch', producer: 2 }] },
      threeProducers,
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const guideRow = lines.findIndex(l => l.startsWith(`const g = sketch('yz'`));
    expect(guideRow).toBeGreaterThan(-1);
    expect(lines[guideRow + 1]).toBe(`loft(s, s2).guides(g)`);
  });

  it('renders condition chains, omitting the default magnitude', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({
      startCondition: { type: 'normal', magnitude: 1 },
      endCondition: { type: 'tangent', magnitude: 2.5 },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s, s2).startCondition('normal').endCondition('tangent', 2.5)`);
  });

  it('orders condition chains ahead of thin and the op chain', async () => {
    // Conditions compose with thin (both walls are conditioned); guides don't.
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({
      op: 'new', thin: [1.5],
      endCondition: { type: 'normal', magnitude: 1 },
    }));
    expect(result.newCode).toContain(`loft(s, s2).endCondition('normal').thin(1.5).new()`);
  });

  it('refuses guides combined with thin walls', async () => {
    const result = await applyFeatureEdit(threeSketchCode, loftSpec(
      { thin: [2], guides: [{ kind: 'sketch', producer: 2 }] },
      threeProducers,
    ));
    expect(result.error).toContain('thin walls');
    expect(result.newCode).toBe(threeSketchCode);
  });

  it('refuses more than two guides', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({
      guides: [0, 0, 0].map(producer => ({ kind: 'sketch' as const, producer })),
    }));
    expect(result.error).toContain('malformed');
  });

  it('refuses a guide whose producer is not a sketch', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec(
      { guides: [{ kind: 'sketch', producer: 2 }] },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
        ],
      },
    ));
    expect(result.error).toContain('malformed');
  });

  it('refuses a zero condition magnitude', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec({
      startCondition: { type: 'normal', magnitude: 0 },
    }));
    expect(result.error).toContain('malformed');
  });
});

// ---------------------------------------------------------------------------
// In-place statement editing (timeline double-click → edit dialog)
// ---------------------------------------------------------------------------

import { parseFeatureStatement, type FeatureStatementEditTarget } from '../src/apply-feature-edit.ts';

const editBase = [
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  ``,
  `const s = sketch('xy', () => { rect(100, 50) })`,
].join('\n');

function editSpec(
  feature: ApplyFeatureEditSpec['feature'],
  edit: FeatureStatementEditTarget,
  overrides: Partial<ApplyFeatureEditSpec> = {},
): ApplyFeatureEditSpec {
  return {
    feature,
    filePath: '/ws/model.fluid.js',
    producers: [],
    parts: [],
    imports: [],
    edit,
    ...overrides,
  };
}

function extrudeEditOptions(
  overrides: Partial<NonNullable<FeatureStatementEditTarget['extrude']>> = {},
): NonNullable<FeatureStatementEditTarget['extrude']> {
  return {
    op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, drill: true,
    thin: null, ...overrides,
  };
}

describe('parseFeatureStatement', () => {
  it('reads a plain extrude', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'add', distance: 30, distance2: null, symmetric: false,
        draft: null, drill: true, thin: null, profileText: null, toFaceText: null,
      },
      statement: 'extrude(30)',
    });
  });

  it('reads a bound thin new extrude', async () => {
    const code = `${editBase}\nconst body = extrude(25, s).thin(2).new()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'new', distance: 25, distance2: null, symmetric: false,
        draft: null, drill: true, thin: [2], profileText: 's', toFaceText: null,
      },
      statement: 'extrude(25, s).thin(2).new()',
    });
  });

  it('reads a through-all bound cut', async () => {
    const code = `${editBase}\ncut(s)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'remove', distance: null, distance2: null, symmetric: false,
        draft: null, drill: true, thin: null, profileText: 's', toFaceText: null,
      },
      statement: 'cut(s)',
    });
  });

  it('reads a two-distance bound extrude with draft and drill chains', async () => {
    const code = `${editBase}\nextrude(10, 20, s).draft(5).drill(false)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'add', distance: 10, distance2: 20, symmetric: false,
        draft: 5, drill: false, thin: null, profileText: 's', toFaceText: null,
      },
      statement: 'extrude(10, 20, s).draft(5).drill(false)',
    });
  });

  it('reads a symmetric extrude and a bare .drill() as true', async () => {
    const code = `${editBase}\nextrude(30).symmetric().drill()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', symmetric: true, drill: true, distance: 30, distance2: null },
    });
  });

  it('refuses .symmetric() on a two-distance extrude', async () => {
    const code = `${editBase}\nextrude(10, 20).symmetric()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('symmetric');
    }
  });

  it('refuses a per-side draft array', async () => {
    const code = `${editBase}\nextrude(10).draft([2, 4])\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('draft');
    }
  });

  it('refuses a non-literal .drill() argument', async () => {
    const code = `${editBase}\nextrude(10).drill(flag)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('drill');
    }
  });

  it('refuses an extrude with three numeric arguments', async () => {
    const code = `${editBase}\nextrude(10, 20, 30)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
  });

  it('reads a sweep with a remove chain', async () => {
    const code = `${editBase}\nconst p = sketch('xz', () => { rect(1, 60) })\nsweep(p, s).remove()\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'sweep', op: 'remove', thin: null, pathText: 'p', profileText: 's' },
      statement: 'sweep(p, s).remove()',
    });
  });

  it('reads a loft with guides and conditions', async () => {
    const code = `${editBase}\nloft(s, s2, e.endFaces()).guides(g).startCondition('normal').endCondition('tangent', 2).new()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'loft',
        op: 'new',
        thin: null,
        profileTexts: ['s', 's2', 'e.endFaces()'],
        guideTexts: ['g'],
        startCondition: { type: 'normal', magnitude: 1 },
        endCondition: { type: 'tangent', magnitude: 2 },
      },
    });
  });

  it('reads a shell keeping the selector args verbatim', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces(),  face().onPlane('xy'))\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'shell', value: -2, argsText: `e.endFaces(),  face().onPlane('xy')`, joinType: 'arc' },
      statement: `shell(-2, e.endFaces(),  face().onPlane('xy'))`,
    });
  });

  it('reads a shell join chain', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces()).join('tangent')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'shell', value: -2, argsText: 'e.endFaces()', joinType: 'tangent' },
      statement: `shell(-2, e.endFaces()).join('tangent')`,
    });
  });

  it('refuses a shell join type it does not know', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces()).join('bevel')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain(`'bevel'`);
    }
  });

  it('refuses a non-literal shell join type', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces()).join(mode)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('not a plain string');
    }
  });

  it('keeps chained calls after the options out of the statement span', async () => {
    const code = `${editBase}\nextrude(10).fillet(2, e => e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', op: 'add', distance: 10 },
      statement: 'extrude(10)',
    });
  });

  it('refuses a variable distance', async () => {
    const code = `${editBase}\nextrude(height)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('not a plain number');
    }
  });

  it('reads a bound to-face extrude', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nextrude(e.endFaces(), s).draft(3)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'add', distance: null, distance2: null, symmetric: false,
        draft: 3, drill: true, thin: null, profileText: 's', toFaceText: 'e.endFaces()',
      },
      statement: 'extrude(e.endFaces(), s).draft(3)',
    });
  });

  it('reads an implicit to-face cut from a call-expression argument', async () => {
    const code = `${editBase}\ncut(select(face().parallelTo('xy')))\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'remove', distance: null, profileText: null,
        toFaceText: `select(face().parallelTo('xy'))`,
      },
    });
  });

  it('still reads a bare-identifier cut argument as a through-all profile', async () => {
    const code = `${editBase}\ncut(s)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', op: 'remove', distance: null, profileText: 's', toFaceText: null },
    });
  });

  it('refuses a to-face extrude chaining .symmetric()', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nextrude(e.endFaces(), s).symmetric()\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('symmetric');
    }
  });

  it('refuses an option chain hiding behind an unknown member', async () => {
    const code = `${editBase}\nextrude(10).color('red').new()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
  });

  it('refuses a non-feature call', async () => {
    const result = await parseFeatureStatement(editBase, 3);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('applyFeatureEdit (in-place statement edit)', () => {
  it('replaces the distance in place', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 45 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${editBase}\nextrude(45)\n`);
  });

  it('switches add to a through-all cut and imports cut', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ op: 'remove', distance: null }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`cut()`);
    expect(result.newCode).toContain(`cut,`);
    expect(result.newCode).not.toContain(`extrude(30)`);
  });

  it('preserves the binding and a chained suffix', async () => {
    const code = `${editBase}\nconst body = extrude(25, s).thin(2).fillet(1, e => e.endEdges());\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 40 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const body = extrude(40, s).fillet(1, e => e.endEdges());`);
  });

  it('adds direction and taper chains in place', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 30, symmetric: true, draft: -2, drill: false }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(30).symmetric().draft(-2).drill(false)`);
  });

  it('switches a symmetric extrude to two distances', async () => {
    const code = `${editBase}\nextrude(30, s).symmetric().drill(false)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 10, distance2: 20 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(10, 20, s)\n`);
    expect(result.newCode).not.toContain(`.symmetric()`);
  });

  it('refuses a two-distance symmetric edit spec', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 10, distance2: 20, symmetric: true }),
    }));
    expect(result.error).toContain('symmetric');
    expect(result.newCode).toBe(code);
  });

  const toFaceEditBase = `${editBase}\nconst e = extrude(30)`;

  it('keeps a to-face target verbatim while editing other options', async () => {
    const code = `${toFaceEditBase}\nextrude(e.endFaces(), s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: null, draft: 3, toFace: { kind: 'keep' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(e.endFaces(), s).draft(3)\n`);
  });

  it('switches a distance extrude to a re-picked to-face target', async () => {
    const code = `${toFaceEditBase}\nextrude(40, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: null, toFace: { kind: 'selector' } }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(e.endFaces(), s)\n`);
    expect(result.newCode).not.toContain(`extrude(40, s)`);
  });

  it('switches a to-face extrude back to a distance, dropping the target', async () => {
    const code = `${toFaceEditBase}\nextrude(e.endFaces(), s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 45 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(45, s)\n`);
    expect(result.newCode).not.toContain(`endFaces`);
  });

  it('refuses to keep a to-face target the statement does not have', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: null, toFace: { kind: 'keep' } }),
    }));
    expect(result.error).toContain('no to-face target');
    expect(result.newCode).toBe(code);
  });

  it('refuses a to-face edit carrying a distance', async () => {
    const code = `${toFaceEditBase}\nextrude(e.endFaces(), s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 25, toFace: { kind: 'keep' } }),
    }));
    expect(result.error).toContain('to-face');
    expect(result.newCode).toBe(code);
  });

  it('adds thin and remove chains to a sweep', async () => {
    const code = `${editBase}\nconst p = sketch('xz', () => { rect(1, 60) })\nsweep(p, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 5, column: 0,
      sweep: { op: 'remove', thin: [1.5] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(p, s).thin(1.5).remove()`);
  });

  it('rewrites loft conditions while keeping profiles and guides verbatim', async () => {
    const code = `${editBase}\nloft(s, s2).guides(g).startCondition('normal')\n`;
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 4, column: 0,
      loft: { op: 'new', thin: null, endCondition: { type: 'tangent', magnitude: 2 } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s, s2).guides(g).endCondition('tangent', 2).new()`);
  });

  it('refuses thin on a loft that has guides', async () => {
    const code = `${editBase}\nloft(s, s2).guides(g)\n`;
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 4, column: 0,
      loft: { op: 'add', thin: [2] },
    }));
    expect(result.error).toContain('thin walls');
    expect(result.newCode).toBe(code);
  });

  it('replaces a shell value and keeps its selector', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces())\n`;
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 4, column: 0,
    }, { value: -3 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-3, e.endFaces())`);
  });

  it('applies an edited selector argument list and its imports', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces())\n`;
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 4, column: 0,
    }, { value: -2, rawArgs: `face().onPlane('xy')` }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, face().onPlane('xy'))`);
    expect(result.newCode).toContain(`from 'fluidcad/filters'`);
  });

  it('adds a shell join chain in place', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces())\n`;
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 4, column: 0,
      shell: { joinType: 'intersection' },
    }, { value: -2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, e.endFaces()).join('intersection')`);
  });

  it('drops the join chain when the edit selects the default arc', async () => {
    const code = `${editBase}\nshell(-2, e.endFaces()).join('tangent')\n`;
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 4, column: 0,
      shell: { joinType: 'arc' },
    }, { value: -2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, e.endFaces())`);
    expect(result.newCode).not.toContain(`.join(`);
  });

  it('keeps the statement join type when the edit spec carries none', async () => {
    const code = `${editBase}\nshell(-3, e.endFaces()).join('tangent')\n`;
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 4, column: 0,
    }, { value: -2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, e.endFaces()).join('tangent')`);
  });

  it('refuses when the statement is not the expected feature', async () => {
    const code = `${editBase}\nfillet(2, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 10 }),
    }));
    expect(result.error).toContain('expected a extrude');
    expect(result.newCode).toBe(code);
  });
});

describe('plane statement templates', () => {
  const planeOptions = (over: Partial<import('../src/apply-feature-edit.ts').PlaneEditOptions> = {}) => ({
    type: 'offset' as const,
    offset: null,
    rotateX: null,
    rotateY: null,
    rotateZ: null,
    bases: [{ kind: 'standard' as const, plane: 'xy' as const }],
    ...over,
  });

  const planeSpec = (
    pl: ReturnType<typeof planeOptions>,
    over: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec => ({
    feature: 'plane',
    filePath: '/ws/model.fluid.js',
    plane: pl,
    producers: [],
    parts: [],
    imports: [],
    ...over,
  });

  const base = [
    `import { sketch, rect, extrude } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { rect(100, 50) })`,
    `extrude(30)`,
    ``,
  ].join('\n');

  it('appends a standard-base offset plane at top level and imports plane', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions({ offset: 10 })));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import {plane, sketch, rect, extrude } from 'fluidcad/core'`);
    expect(result.newCode).toContain(`extrude(30)\nplane('xy', 10)`);
  });

  it('renders a bare standard plane without options', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions()));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane('xy')`);
  });

  it('renders rotation as a transform options object', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions({ offset: 10, rotateX: 15, rotateZ: -30 })));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane('xy', { offset: 10, rotateX: 15, rotateZ: -30 })`);
  });

  it('appends a standard-base plane before an active breakpoint', async () => {
    const code = [
      `import { sketch, rect, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `extrude(30)`,
      `breakpoint()`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, planeSpec(planeOptions({ offset: 5 })));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane('xy', 5)\nbreakpoint()`);
  });

  it('renders an offset plane from a picked face selector at end of scope', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { rect(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, planeSpec(
      planeOptions({ offset: 5, bases: [{ kind: 'selector', part: 0 }] }),
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30)`);
    // End-of-scope: after the later sketch, so the selection resolves on the
    // final model.
    expect(result.newCode).toContain(`sketch('xz', () => { rect(10, 10) })\nplane(e.endFaces(), 5)`);
  });

  it('wraps selector bases for a mid plane', async () => {
    const result = await applyFeatureEdit(base, planeSpec(
      planeOptions({
        type: 'mid',
        rotateY: 30,
        bases: [{ kind: 'selector', part: 0 }, { kind: 'standard', plane: 'xz' }],
      }),
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(plane(e.endFaces()), 'xz', { rotateY: 30 })`);
  });

  it('keeps the object form for a mid plane with only an offset', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions({
      type: 'mid',
      offset: 10,
      bases: [{ kind: 'standard', plane: 'xy' }, { kind: 'standard', plane: 'xz' }],
    })));
    expect(result.error).toBeUndefined();
    // plane(p1, p2, …) reads its third argument as options — never a bare number.
    expect(result.newCode).toContain(`plane('xy', 'xz', { offset: 10 })`);
  });

  it('binds plane producers and inserts a mid plane after the latest input', async () => {
    const code = [
      `import { sketch, rect, extrude, plane } from 'fluidcad/core'`,
      ``,
      `plane('xy')`,
      `plane('xy', 40)`,
      `sketch('xz', () => { rect(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, planeSpec(
      planeOptions({
        type: 'mid',
        bases: [{ kind: 'plane', producer: 0 }, { kind: 'plane', producer: 1 }],
      }),
      {
        producers: [
          { line: 3, column: 0, featureType: 'plane', nameHint: 'p', bind: true },
          { line: 4, column: 0, featureType: 'plane', nameHint: 'p', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const p = plane('xy')`);
    // Inserted directly after the later input, before the trailing sketch.
    expect(result.newCode).toContain(`const p2 = plane('xy', 40)\nplane(p, p2)\nsketch('xz'`);
  });

  it('renders an edge plane with its normalized position', async () => {
    const result = await applyFeatureEdit(base, planeSpec(
      planeOptions({ type: 'edge', position: 0.5, bases: [{ kind: 'selector', part: 0 }] }),
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideEdges', indices: [0], filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(e.sideEdges(0), 0.5)`);
  });

  it('refuses an edge plane carrying rotation', async () => {
    const result = await applyFeatureEdit(base, planeSpec(
      planeOptions({ type: 'edge', position: 0.5, rotateX: 15, bases: [{ kind: 'selector', part: 0 }] }),
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideEdges', indices: [0], filterArgs: null }],
      },
    ));
    expect(result.error).toContain('malformed plane edit spec');
    expect(result.newCode).toBe(base);
  });

  it('refuses when a plane producer line is not a plane call', async () => {
    const result = await applyFeatureEdit(base, planeSpec(
      planeOptions({ bases: [{ kind: 'plane', producer: 0 }] }),
      { producers: [{ line: 4, column: 0, featureType: 'plane', nameHint: 'p', bind: true }] },
    ));
    expect(result.error).toContain('expected a plane() call');
    expect(result.newCode).toBe(base);
  });

  it('refuses a malformed mid spec with a single base', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions({ type: 'mid' })));
    expect(result.error).toContain('malformed plane edit spec');
    expect(result.newCode).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// In-place statement editing with re-sourced slots (edit-mode re-picking)
// ---------------------------------------------------------------------------

describe('applyFeatureEdit (re-sourced statement edit)', () => {
  const sketchProducer = (line: number) =>
    ({ line, column: 0, featureType: 'sketch', nameHint: 's', bind: true });
  const extrudeProducer = (line: number) =>
    ({ line, column: 0, featureType: 'extrude', nameHint: 'e', bind: true });

  it('re-sources an extrude profile to a bound sketch, reusing its const', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 45, profile: { kind: 'sketch', producer: 0 } }),
    }, { producers: [sketchProducer(3)] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${editBase}\nextrude(45, s)\n`);
  });

  it('re-sources an extrude profile to a bare sketch, prepending its binding', async () => {
    const code = [
      editBase,
      `sketch('xz', () => { rect(20, 20) })`,
      `extrude(30, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 30, profile: { kind: 'sketch', producer: 0 } }),
    }, { producers: [sketchProducer(4)] }));
    expect(result.error).toBeUndefined();
    // The existing `s` keeps its name; the new binding suffixes past it.
    expect(result.newCode).toContain(`const s2 = sketch('xz', () => { rect(20, 20) })`);
    expect(result.newCode).toContain(`extrude(30, s2)`);
  });

  it('keeps the profile verbatim when the edit carries kind: keep', async () => {
    const code = `${editBase}\nextrude(30, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 45, profile: { kind: 'keep' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${editBase}\nextrude(45, s)\n`);
  });

  it('re-sources a sweep path to picked edges rendered from parts', async () => {
    const code = [
      `import { sketch, rect, circle, extrude, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(40)`,
      `const p = sketch('xz', () => { circle(30) })`,
      `sweep(p, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 6, column: 0,
      sweep: { op: 'add', thin: null, path: { kind: 'selector' } },
    }, {
      producers: [extrudeProducer(4)],
      parts: [{ producer: 0, accessor: 'sideEdges', indices: [0], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(e.sideEdges(0), s)`);
  });

  it('re-sources a sweep path and profile to other sketches', async () => {
    const code = [
      `import { sketch, rect, circle, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `const p = sketch('xz', () => { circle(30) })`,
      `const p2 = sketch('yz', () => { circle(10) })`,
      `sweep(p, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 6, column: 0,
      sweep: {
        op: 'add', thin: null,
        path: { kind: 'sketch', producer: 0 },
        profile: { kind: 'sketch', producer: 1 },
      },
    }, { producers: [sketchProducer(5), sketchProducer(3)] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(p2, s)`);
  });

  it('reorders kept loft profiles and appends a re-picked sketch', async () => {
    const code = [
      `import { sketch, circle, loft } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { circle(80) })`,
      `const s2 = sketch('xy', () => { circle(60) })`,
      `const s3 = sketch('xy', () => { circle(40) })`,
      `loft(s, s2)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 6, column: 0,
      loft: {
        op: 'add', thin: null,
        profiles: [
          { kind: 'verbatim', sourceIndex: 1 },
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'sketch', producer: 0 },
        ],
      },
    }, { producers: [sketchProducer(5)] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s2, s, s3)`);
  });

  it('removing all guides unlocks thin walls (effective-guide rule)', async () => {
    const code = [
      `import { sketch, circle, loft } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { circle(80) })`,
      `const s2 = sketch('xy', () => { circle(60) })`,
      `const g = sketch('xz', () => { circle(40) })`,
      `loft(s, s2).guides(g)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 6, column: 0,
      loft: { op: 'add', thin: [2], guides: [] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s, s2).thin(2)`);
    expect(result.newCode).not.toContain(`.guides(`);
  });

  it('still refuses thin walls when a kept guide remains', async () => {
    const code = [
      `import { sketch, circle, loft } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { circle(80) })`,
      `const s2 = sketch('xy', () => { circle(60) })`,
      `const g = sketch('xz', () => { circle(40) })`,
      `loft(s, s2).guides(g)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 6, column: 0,
      loft: { op: 'add', thin: [2], guides: [{ kind: 'verbatim', sourceIndex: 0 }] },
    }));
    expect(result.error).toContain('guides cannot be combined');
    expect(result.newCode).toBe(code);
  });

  it('re-sources a shell selection from parts', async () => {
    const code = [
      editBase,
      `const e = extrude(40)`,
      `shell(-2, e.endFaces())`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 5, column: 0,
    }, {
      value: -3,
      producers: [extrudeProducer(4)],
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [0, 2], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-3, e.sideFaces(0, 2))`);
  });

  it('user-edited rawArgs win over re-picked parts and import their filters', async () => {
    const code = [
      editBase,
      `const e = extrude(40)`,
      `shell(-2, e.endFaces())`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 5, column: 0,
    }, {
      value: -2,
      rawArgs: `face().onPlane('xy')`,
      producers: [extrudeProducer(4)],
      parts: [{ producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`shell(-2, face().onPlane('xy'))`);
    expect(result.newCode).toContain(`from 'fluidcad/filters'`);
  });

  it('applies when expectedStatement matches and refuses when it drifted', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const matching = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0, expectedStatement: 'extrude(30)',
      extrude: extrudeEditOptions({ distance: 45 }),
    }));
    expect(matching.error).toBeUndefined();
    expect(matching.newCode).toContain('extrude(45)');

    const drifted = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0, expectedStatement: 'extrude(31)',
      extrude: extrudeEditOptions({ distance: 45 }),
    }));
    expect(drifted.error).toContain('changed since the dialog opened');
    expect(drifted.newCode).toBe(code);
  });

  it('refuses a producer at or after the edited statement (self/forward reference)', async () => {
    const code = [
      editBase,
      `extrude(30, s)`,
      `sketch('xz', () => { rect(20, 20) })`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 30, profile: { kind: 'sketch', producer: 0 } }),
    }, { producers: [sketchProducer(5)] }));
    expect(result.error).toContain('does not precede');
    expect(result.newCode).toBe(code);
  });

  it('refuses a producer in a different scope than the edited statement', async () => {
    const code = [
      editBase,
      `function make() {`,
      `  sketch('xz', () => { rect(20, 20) })`,
      `}`,
      `extrude(30, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 7, column: 0,
      extrude: extrudeEditOptions({ distance: 30, profile: { kind: 'sketch', producer: 0 } }),
    }, { producers: [sketchProducer(5)] }));
    expect(result.error).toContain('different scope');
    expect(result.newCode).toBe(code);
  });

  it('refuses loft selector parts that no profile references', async () => {
    const code = [
      `import { sketch, circle, extrude, loft } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { circle(80) })`,
      `const s2 = sketch('xy', () => { circle(60) })`,
      `const e = extrude(5)`,
      `loft(s, s2)`,
      '',
    ].join('\n');
    const withoutList = await applyFeatureEdit(code, editSpec('loft', {
      line: 6, column: 0,
      loft: { op: 'add', thin: null },
    }, {
      producers: [extrudeProducer(5)],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(withoutList.error).toContain('selector parts without a profile list');

    const uncovered = await applyFeatureEdit(code, editSpec('loft', {
      line: 6, column: 0,
      loft: {
        op: 'add', thin: null,
        profiles: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'verbatim', sourceIndex: 1 }],
      },
    }, {
      producers: [extrudeProducer(5)],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(uncovered.error).toContain('belongs to no profile');
  });

  it('refuses a kept loft profile whose index drifted off the statement', async () => {
    const code = [
      `import { sketch, circle, loft } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { circle(80) })`,
      `const s2 = sketch('xy', () => { circle(60) })`,
      `loft(s, s2)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 5, column: 0,
      loft: {
        op: 'add', thin: null,
        profiles: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'verbatim', sourceIndex: 5 }],
      },
    }));
    expect(result.error).toContain('no longer matches the statement');
    expect(result.newCode).toBe(code);
  });

  it('refuses to parse a to-face cut target as a profile', async () => {
    const code = `${editBase}\ncut('first-face')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('first-face/last-face');
    }
  });

  it('strips the breakpoint atomically with the rewrite when clearBreakpoints is set', async () => {
    const code = [
      `import { breakpoint, sketch, rect, extrude, shell } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30, s)`,
      `shell(-2, e.endFaces())`,
      `breakpoint();`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 5, column: 0,
    }, { value: -3, clearBreakpoints: true }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('shell(-3, e.endFaces())');
    expect(result.newCode).not.toContain('breakpoint()');
  });

  it('keeps the breakpoint when clearBreakpoints is absent', async () => {
    const code = [
      `import { breakpoint, sketch, rect, extrude, shell } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30, s)`,
      `shell(-2, e.endFaces())`,
      `breakpoint();`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('shell', {
      line: 5, column: 0,
    }, { value: -3 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('breakpoint()');
  });

  it('refuses a selector sweep path with more than one part', async () => {
    const code = [
      `import { sketch, rect, extrude, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(40)`,
      `sweep(s, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 5, column: 0,
      sweep: { op: 'add', thin: null, path: { kind: 'selector' } },
    }, {
      producers: [extrudeProducer(4)],
      parts: [
        { producer: 0, accessor: 'sideEdges', indices: [0], filterArgs: null },
        { producer: 0, accessor: 'endEdges', indices: [1], filterArgs: null },
      ],
    }));
    expect(result.error).toContain('exactly one part');
    expect(result.newCode).toBe(code);
  });
});

describe('revolve statement templates', () => {
  function revolveSpec(
    revolve: Partial<NonNullable<ApplyFeatureEditSpec['revolve']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'revolve',
      filePath: '/ws/model.fluid.js',
      revolve: {
        op: 'add', angle: 360, thin: null, profile: 'implicit',
        axis: { kind: 'standard', axis: 'z' },
        ...revolve,
      },
      producers: [
        { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
      ],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const oneSketchCode = [
    `import { sketch, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xz', () => { circle([80, 0], 40) })`,
    ``,
  ].join('\n');

  it('appends an implicit-profile revolve at end of scope and imports revolve', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const sketchRow = lines.findIndex(l => l.startsWith(`sketch('xz'`));
    expect(lines[sketchRow + 1]).toBe(`revolve('z')`);
    expect(result.newCode).toMatch(/import \{ ?revolve,/);
  });

  it('omits the 360° default angle but renders a partial one', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec({ angle: 275 }));
    expect(result.newCode).toContain(`revolve('z', 275)`);
  });

  it('binds a bound profile and inserts directly after it', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      `sketch('xy', () => { rect(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, revolveSpec(
      { profile: 'bound', angle: 90 },
      { producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const profileRow = lines.findIndex(l => l === `const s = sketch('xz', () => { circle([80, 0], 40) })`);
    expect(profileRow).toBeGreaterThan(-1);
    expect(lines[profileRow + 1]).toBe(`revolve('z', 90, s)`);
    // The later sketch stays last, so it remains the active sketch.
    expect(lines[profileRow + 2]).toBe(`sketch('xy', () => { rect(10, 10) })`);
  });

  it('binds an axis statement and inserts after the later input', async () => {
    const code = [
      `import { sketch, circle, axis } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      `axis('y', { offsetZ: 290 })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, revolveSpec(
      { profile: 'bound', axis: { kind: 'axis', producer: 1 } },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'axis', nameHint: 'a', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const axisRow = lines.findIndex(l => l === `const a = axis('y', { offsetZ: 290 })`);
    expect(axisRow).toBeGreaterThan(-1);
    expect(lines[axisRow + 1]).toBe(`revolve(a, s)`);
  });

  it('renders a picked-edge axis wrapped in axis() at end of scope', async () => {
    const code = [
      `import { sketch, rect, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, revolveSpec(
      { axis: { kind: 'selector' } },
      {
        producers: [
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
          { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
        ],
        parts: [{ producer: 1, accessor: 'endEdges', indices: [2], filterArgs: null }],
        imports: ['axis'],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30)`);
    const lines = result.newCode.split('\n');
    const revolveRow = lines.findIndex(l => l === `revolve(axis(e.endEdges(2)))`);
    expect(revolveRow).toBeGreaterThan(lines.findIndex(l => l.startsWith(`sketch('xz'`)));
    expect(result.newCode).toMatch(/import \{ ?axis,/);
  });

  it('chains .thin() and .remove()', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec({ op: 'remove', angle: 90, thin: [2] }));
    expect(result.newCode).toContain(`revolve('z', 90).thin(2).remove()`);
  });

  it('chains .new()', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec({ op: 'new' }));
    expect(result.newCode).toContain(`revolve('z').new()`);
  });

  it('refuses a selector axis without its part', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec({ axis: { kind: 'selector' } }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(oneSketchCode);
  });

  it('refuses when the axis producer line is not an axis call', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      `sketch('xy', () => { rect(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, revolveSpec(
      { profile: 'bound', axis: { kind: 'axis', producer: 1 } },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'axis', nameHint: 'a', bind: true },
        ],
      },
    ));
    expect(result.error).toContain('expected a axis() call');
    expect(result.newCode).toBe(code);
  });
});

describe('parseFeatureStatement — revolve', () => {
  it('reads a plain standard-axis revolve', async () => {
    const code = `${editBase}\nrevolve('z')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'revolve', op: 'add', angle: null, thin: null,
        axisText: `'z'`, profileText: null,
      },
      statement: `revolve('z')`,
    });
  });

  it('reads a partial angle with a thin chain', async () => {
    const code = `${editBase}\nrevolve('z', 275).thin(5)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', angle: 275, thin: [5], axisText: `'z'`, profileText: null },
    });
  });

  it('reads a bound axis variable and profile with a remove chain', async () => {
    const code = `${editBase}\nrevolve(a, s).remove()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'revolve', op: 'remove', angle: null, thin: null,
        axisText: 'a', profileText: 's',
      },
      statement: `revolve(a, s).remove()`,
    });
  });

  it('keeps an axis() call argument verbatim', async () => {
    const code = `${editBase}\nrevolve(axis(e.endEdges(2)), 90)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', angle: 90, axisText: 'axis(e.endEdges(2))', profileText: null },
    });
  });

  it('keeps a trailing .symmetric() chain out of the statement span', async () => {
    const code = `${editBase}\nrevolve('z', 180).symmetric()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', angle: 180 },
      statement: `revolve('z', 180)`,
    });
  });

  it('refuses extra arguments after the profile slot', async () => {
    const code = `${editBase}\nrevolve('z', 90, 45)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('applyFeatureEdit (revolve in-place statement edit)', () => {
  // Like editBase, with revolve already imported so exact-equality
  // assertions don't trip on the import ensure.
  const revolveEditBase = [
    `import { sketch, rect, extrude, revolve } from 'fluidcad/core'`,
    ``,
    `const s = sketch('xy', () => { rect(100, 50) })`,
  ].join('\n');

  function revolveEditOptions(
    overrides: Partial<NonNullable<FeatureStatementEditTarget['revolve']>> = {},
  ): NonNullable<FeatureStatementEditTarget['revolve']> {
    return { op: 'add', angle: 360, thin: null, ...overrides };
  }

  it('replaces the angle in place', async () => {
    const code = `${revolveEditBase}\nrevolve('z', 90)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 180 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${revolveEditBase}\nrevolve('z', 180)\n`);
  });

  it('drops the angle argument for the 360° default', async () => {
    const code = `${revolveEditBase}\nrevolve('z', 90)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions(),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${revolveEditBase}\nrevolve('z')\n`);
  });

  it('adds thin and remove chains keeping the axis and profile verbatim', async () => {
    const code = `${editBase}\nrevolve(axis(e.endEdges(2)), 45, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ op: 'remove', angle: 45, thin: [2] }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`revolve(axis(e.endEdges(2)), 45, s).thin(2).remove()`);
  });

  it('re-sources the axis to a standard world axis', async () => {
    const code = `${editBase}\nrevolve(axis(e.endEdges(2)), 45)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 45, axis: { kind: 'standard', axis: 'x' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`revolve('x', 45)`);
  });

  it('re-sources the axis to an axis statement, binding it', async () => {
    const code = [
      `import { sketch, circle, axis, revolve } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xz', () => { circle([80, 0], 40) })`,
      `axis('y', { offsetZ: 290 })`,
      `revolve('z', 45)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 5, column: 0,
      revolve: revolveEditOptions({ angle: 45, axis: { kind: 'axis', producer: 0 } }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'axis', nameHint: 'a', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const a = axis('y', { offsetZ: 290 })`);
    expect(result.newCode).toContain(`revolve(a, 45)`);
  });

  it('re-sources the axis to a picked edge rendered from parts', async () => {
    const code = [
      `import { sketch, rect, circle, extrude, revolve } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      `const s = sketch('xz', () => { circle([80, 0], 40) })`,
      `revolve('z', 45, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 6, column: 0,
      revolve: revolveEditOptions({ angle: 45, axis: { kind: 'selector' } }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`revolve(axis(e.endEdges(2)), 45, s)`);
    expect(result.newCode).toMatch(/import \{ ?axis,/);
  });

  it('re-sources the profile to a bound sketch, reusing its const', async () => {
    const code = `${revolveEditBase}\nrevolve('z', 45)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 45, profile: { kind: 'sketch', producer: 0 } }),
    }, {
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${revolveEditBase}\nrevolve('z', 45, s)\n`);
  });

  it('refuses selector parts without a re-sourced axis', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nrevolve('z', 45)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 5, column: 0,
      revolve: revolveEditOptions({ angle: 45 }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
    }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(code);
  });

  it('refuses a zero angle', async () => {
    const code = `${editBase}\nrevolve('z', 45)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 0 }),
    }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(code);
  });
});
