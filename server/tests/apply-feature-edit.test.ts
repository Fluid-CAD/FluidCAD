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
      extrude: { op: 'add', distance: 25, thin: null, profile: 'implicit', ...extrude },
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
});
