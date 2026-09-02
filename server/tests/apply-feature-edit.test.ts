import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  extractNumericParams,
  makeProducerNamer,
  parseOffsetTargetDescriptors,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { fillet, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(3, e.endEdges(2))`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const binding', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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

  it('reuses the variable of a whole assignment statement', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `let base`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `base = extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`base = extrude(30)`);
    expect(result.newCode).toContain(`fillet(3, base.endEdges(2))`);
    expect(result.newCode).not.toContain(`const base = extrude`);
  });

  it('refuses to reuse a variable reassigned after the producing call', async () => {
    const code = [
      `import { sketch, ellipse, extrude, shell, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `let s = extrude(30)`,
      `s = shell(-4, s.endFaces())`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('reassigned');
    expect(result.newCode).toBe(code);
  });

  it('matches the file semicolon style', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) });`,
      `extrude(30);`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec());
    expect(result.newCode).toContain(`const e = extrude(30);`);
    expect(result.newCode).toContain(`fillet(3, e.endEdges(2));`);
  });

  it('inserts after later statements so the selection resolves on the final model', async () => {
    const code = [
      `import { sketch, ellipse, extrude, color } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `const e = 5`,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xy', () => { ellipse(20, 20) })`,
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
      `import { sketch, ellipse, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, translate } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(20, 20) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `for (let i = 0; i < 3; i++) {`,
      `  sketch('xy', () => { ellipse(20, 20) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `sketch('xy', () => { ellipse(100, 50) })`,
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

describe('chamfer second-value overloads', () => {
  const code = [
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    ``,
  ].join('\n');
  const chamferSpec = (chamfer: ApplyFeatureEditSpec['chamfer']): ApplyFeatureEditSpec => spec({
    feature: 'chamfer',
    value: 1.5,
    chamfer,
    producers: [{ line: 2, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: [0, 1], filterArgs: null }],
  });

  it('renders a two-distance chamfer', async () => {
    const result = await applyFeatureEdit(code, chamferSpec({ distance2: 3, isAngle: false }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(1.5, 3, e.endEdges(0, 1))`);
  });

  it('renders a distance-and-angle chamfer with the literal true', async () => {
    const result = await applyFeatureEdit(code, chamferSpec({ distance2: 45, isAngle: true }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(1.5, 45, true, e.endEdges(0, 1))`);
  });

  it('renders the plain form for an explicit null second value', async () => {
    const result = await applyFeatureEdit(code, chamferSpec({ distance2: null, isAngle: false }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(1.5, e.endEdges(0, 1))`);
  });

  it('refuses a non-positive second distance', async () => {
    const result = await applyFeatureEdit(code, chamferSpec({ distance2: 0, isAngle: false }));
    expect(result.error).toContain('malformed chamfer');
    expect(result.newCode).toBe(code);
  });

  it('refuses an angle of 90 degrees or more', async () => {
    const result = await applyFeatureEdit(code, chamferSpec({ distance2: 90, isAngle: true }));
    expect(result.error).toContain('malformed chamfer');
    expect(result.newCode).toBe(code);
  });
});

describe('shell and sketch statement templates', () => {
  it('emits shell with a negative thickness and imports it', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, spec({
      feature: 'shell',
      value: -2,
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { shell, sketch, ellipse, extrude } from 'fluidcad/core'`);
    expect(result.newCode).toContain(`const e = extrude(30)`);
    expect(result.newCode).toContain(`shell(-2, e.endFaces())`);
  });

  it('emits a shell join chain for a non-default join type', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch(e.endFaces(), () => {`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('indents the sketch callback body inside a function scope and keeps semicolon style', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core';`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { ellipse(100, 50) });`,
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
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, planeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) });`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, planeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `sketch('xy', () => { ellipse(100, 50) });`,
      `sketch(() => {`,
      ``,
      `});`,
    ].join('\n'));
  });
});

describe('sketch on a plane feature', () => {
  const onPlaneSpec = (line: number) => spec({
    feature: 'sketch',
    value: undefined,
    sketchOnPlane: true,
    producers: [{ line, column: 0, featureType: 'plane', nameHint: 'p', bind: true }],
    parts: [],
  });

  it('binds the plane statement and appends the sketch at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, extrude, plane } from 'fluidcad/core'`,
      ``,
      `plane('xy', 20)`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, onPlaneSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, ellipse, extrude, plane } from 'fluidcad/core'`,
      ``,
      `const p = plane('xy', 20)`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch(p, () => {`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const binding of the plane', async () => {
    const code = [
      `import { sketch, ellipse, plane } from 'fluidcad/core'`,
      ``,
      `const top = plane('xy', 20)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, onPlaneSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const top = plane('xy', 20)`);
    expect(result.newCode).toContain(`sketch(top, () => {`);
  });

  it('refuses when the producer line does not hold a plane() call', async () => {
    const code = [
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, onPlaneSpec(2));
    expect(result.error).toContain('expected a plane() call');
    expect(result.newCode).toBe(code);
  });

  it('refuses a malformed spec whose producer is not a plane', async () => {
    const result = await applyFeatureEdit('extrude(30)\n', spec({
      feature: 'sketch',
      value: undefined,
      sketchOnPlane: true,
      producers: [{ line: 1, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [],
    }));
    expect(result.error).toBe('malformed sketch-on-plane edit spec');
  });
});

describe('part()-scoped insertion', () => {
  it('inserts a select()-based edit at the end of the enclosing part() body', async () => {
    const code = [
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `part('a', () => {`,
      `    sketch('xy', () => { ellipse(20, 20) })`,
      `    extrude(10)`,
      `})`,
      ``,
      `part('b', () => {`,
      `    sketch('xy', () => { ellipse(30, 30) })`,
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
      `import { sketch, ellipse, extrude, color, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `export function bracket() {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `breakpoint()`,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const base = extrude(30)`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    expect(namer([{ line: 4, nameHint: 'e' }])).toEqual(['base']);
  });

  it('suffixes past colliding file identifiers for a bare statement', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `const e = 42`,
      `sketch('xy', () => { ellipse(100, e) })`,
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
        op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, endOffset: null,
        drill: true, thin: null, profile: 'implicit', ...extrude,
      },
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const activeSketchCode = [
    `import { sketch, ellipse } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
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

  it('chains .symmetric(), .draft(), .endOffset() and .drill(false) before thin and new', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({
      op: 'new', distance: 10, symmetric: true, draft: -2.5, endOffset: 1.5, drill: false, thin: [1],
    }));
    expect(result.newCode).toContain(
      `extrude(10).symmetric().draft(-2.5).endOffset(1.5).drill(false).thin(1).new()`);
  });

  it('chains .endOffset() on an up-to-face extrude — it shifts the target face', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec(
      { distance: null, endOffset: 2, toFace: 'first-face' }));
    expect(result.newCode).toContain(`extrude('first-face').endOffset(2)`);
  });

  it('renders a symmetric through-all cut', async () => {
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({
      op: 'remove', distance: null, symmetric: true,
    }));
    expect(result.newCode).toContain(`cut().symmetric()`);
  });

  it('binds a bound-profile sketch and appends the extrude at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `sketch('xz', () => { circle(10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec(
      { profile: 'bound' },
      { producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const boundRow = lines.findIndex(l => l === `const s = sketch('xy', () => { ellipse(100, 50) })`);
    expect(boundRow).toBeGreaterThan(-1);
    // End of scope: after the later sketch, not directly after the profile.
    expect(lines[boundRow + 1]).toBe(`sketch('xz', () => { circle(10) })`);
    expect(lines[boundRow + 2]).toBe(`extrude(25, s)`);
  });

  it('reuses an existing const binding for the bound profile', async () => {
    const code = [
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { ellipse(100, 50) })`,
      `sketch('xz', () => { circle(10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec(
      { profile: 'bound' },
      { producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const profileRow = lines.findIndex(l => l === `const profile = sketch('xy', () => { ellipse(100, 50) })`);
    expect(lines[profileRow + 1]).toBe(`sketch('xz', () => { circle(10) })`);
    expect(lines[profileRow + 2]).toBe(`extrude(25, profile)`);
  });

  it('matches the file semicolon style', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core';`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) });`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, extrudeSpec());
    expect(result.newCode).toContain(`extrude(25);`);
  });

  it('refuses when the profile line is not a sketch call', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
    `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xz', () => { circle(10) })`,
    ``,
  ].join('\n');

  it('renders a to-face extrude from its selector part at end of scope, even with a bound profile', async () => {
    const result = await applyFeatureEdit(toFaceCode, extrudeSpec(
      { profile: 'bound', toFace: 'selector', distance: null },
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
      { op: 'remove', toFace: 'selector', distance: null },
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
    const result = await applyFeatureEdit(activeSketchCode, extrudeSpec({ toFace: 'selector', distance: null }));
    expect(result.error).toContain('malformed');
  });

  it('renders a first-face extrude as the literal, with no selector part', async () => {
    const result = await applyFeatureEdit(toFaceCode, extrudeSpec(
      { toFace: 'first-face', distance: null },
      { producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false }] },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude('first-face')`);
  });

  it('renders a bound-profile last-face cut at end of scope', async () => {
    const result = await applyFeatureEdit(toFaceCode, extrudeSpec(
      { op: 'remove', profile: 'bound', toFace: 'last-face', distance: null },
      { producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const profileRow = lines.findIndex(l => l === `const s = sketch('xz', () => { circle(10) })`);
    // End of scope, like every up-to-face form — the target is resolved
    // against the model the statement runs on.
    expect(lines[profileRow + 1]).toBe(`cut('last-face', s)`);
  });
});

describe('makeProducerNamer — sketch producers', () => {
  it('resolves a bound sketch by its const name', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');

    const namer = await makeProducerNamer(code);
    expect(namer([{ line: 3, nameHint: 's', featureType: 'sketch' }])).toEqual(['profile']);
  });

  it('allocates the hint for a bare sketch statement and refuses non-sketch lines', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
    `import { sketch, ellipse, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xz', () => { circle(5) })`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    ``,
  ].join('\n');

  it('binds a sketch path and appends sweep(p) after the implicit profile', async () => {
    const result = await applyFeatureEdit(twoSketchCode, sweepSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const pathRow = lines.findIndex(l => l === `const p = sketch('xz', () => { circle(5) })`);
    expect(pathRow).toBeGreaterThan(-1);
    // End-of-scope insertion: after the (implicit-profile) active sketch.
    expect(lines[pathRow + 1]).toBe(`sketch('xy', () => { ellipse(10, 10) })`);
    expect(lines[pathRow + 2]).toBe(`sweep(p)`);
    expect(result.newCode).toMatch(/import \{ ?sweep,/);
  });

  it('appends a fully-bound sweep at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, circle, arc } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `sketch('yz', () => { arc([6, 6], [20, 20]) })`,
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
    const profileRow = lines.findIndex(l => l === `const s = sketch('xy', () => { ellipse(10, 10) })`);
    expect(profileRow).toBeGreaterThan(-1);
    // End of scope: after the uninvolved trailing sketch.
    expect(lines[profileRow + 1]).toBe(`sketch('yz', () => { arc([6, 6], [20, 20]) })`);
    expect(lines[profileRow + 2]).toBe(`sweep(p, s)`);
  });

  it('renders a selector path at end of scope with the implicit profile', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `const spine = sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const spine = sketch('xz', () => { circle(5) })`);
    expect(result.newCode).toContain(`sweep(spine)`);
  });

  it('refuses when a sketch producer line is not a sketch call', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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

  it('binds a helix path through a wire producer', async () => {
    const code = [
      `import { sketch, ellipse, helix } from 'fluidcad/core'`,
      ``,
      `const spring = helix('z').radius(10).pitch(4).turns(6)`,
      `sketch('xy', () => { ellipse(2, 2) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      {},
      {
        producers: [
          { line: 3, column: 0, featureType: 'wire', nameHint: 'p', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const spring = helix('z').radius(10).pitch(4).turns(6)`);
    expect(result.newCode).toContain(`sweep(spring)`);
  });

  it('refuses a wire producer line holding neither a sketch nor a helix call', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      {},
      {
        producers: [
          { line: 4, column: 0, featureType: 'wire', nameHint: 'p', bind: true },
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        ],
      },
    ));
    expect(result.error).toContain('expected a sketch() or helix() call');
    expect(result.newCode).toBe(code);
  });

  it('refuses a helix line as the sweep profile — the profile producer stays sketch-only', async () => {
    const code = [
      `import { sketch, circle, helix } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle(5) })`,
      `helix('z').radius(10).pitch(4).turns(6)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sweepSpec(
      { profile: { producer: 1 }, path: { kind: 'sketch', producer: 0 } },
      {
        producers: [
          { line: 3, column: 0, featureType: 'wire', nameHint: 'p', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        ],
      },
    ));
    expect(result.error).toContain('expected a sketch() call');
    expect(result.newCode).toBe(code);
  });
});

describe('wrap statement templates', () => {
  function wrapSpec(
    wrap: Partial<NonNullable<ApplyFeatureEditSpec['wrap']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'wrap',
      filePath: '/ws/model.fluid.js',
      wrap: { op: 'add', thickness: 2, sketch: { producer: 0 }, ...wrap },
      producers: [
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
      ],
      parts: [{ producer: 1, accessor: 'sideFaces', indices: [0], filterArgs: null }],
      imports: [],
      ...overrides,
    };
  }

  const wrapCode = [
    `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { circle(30) })`,
    `extrude(60)`,
    `sketch('xz', () => { ellipse(10, 10) })`,
    ``,
  ].join('\n');

  it('binds the sketch and target producers and appends wrap at end of scope', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(result.newCode).toContain(`const e = extrude(60)`);
    const sketchRow = lines.findIndex(l => l === `const s = sketch('xz', () => { ellipse(10, 10) })`);
    expect(sketchRow).toBeGreaterThan(-1);
    // The face selector must resolve on the final model — end of scope.
    expect(lines[sketchRow + 1]).toBe(`wrap(2, s, e.sideFaces(0))`);
    expect(result.newCode).toMatch(/import \{ ?wrap,/);
  });

  it('chains .remove()', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec({ op: 'remove' }));
    expect(result.newCode).toContain(`wrap(2, s, e.sideFaces(0)).remove()`);
  });

  it('chains .new()', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec({ op: 'new', thickness: 0.5 }));
    expect(result.newCode).toContain(`wrap(0.5, s, e.sideFaces(0)).new()`);
  });

  it('refuses a wrap without exactly one selector part', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec({}, { parts: [] }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(wrapCode);
  });

  it('refuses a non-positive thickness', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec({ thickness: 0 }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(wrapCode);
  });

  it('refuses when the sketch producer line is not a sketch call', async () => {
    const result = await applyFeatureEdit(wrapCode, wrapSpec({}, {
      producers: [
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
      ],
    }));
    expect(result.error).toContain('expected a sketch() call');
    expect(result.newCode).toBe(wrapCode);
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
    `import { sketch, ellipse, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `sketch('xz', () => { circle(5) })`,
    ``,
  ].join('\n');

  it('binds both sketches and inserts directly after the latest input', async () => {
    const result = await applyFeatureEdit(twoSketchCode, loftSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const firstRow = lines.findIndex(l => l === `const s = sketch('xy', () => { ellipse(10, 10) })`);
    expect(firstRow).toBeGreaterThan(-1);
    expect(lines[firstRow + 1]).toBe(`const s2 = sketch('xz', () => { circle(5) })`);
    expect(lines[firstRow + 2]).toBe(`loft(s, s2)`);
    expect(result.newCode).toMatch(/import \{ ?loft,/);
  });

  it('appends at end of scope when every input is earlier', async () => {
    const code = [
      `import { sketch, ellipse, circle, arc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      `sketch('yz', () => { arc([6, 6], [20, 20]) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const loftRow = lines.findIndex(l => l === `loft(s, s2)`);
    expect(loftRow).toBeGreaterThan(-1);
    // End of scope: after the uninvolved trailing sketch.
    expect(lines[loftRow - 1]).toBe(`sketch('yz', () => { arc([6, 6], [20, 20]) })`);
  });

  it('preserves the profile argument order independent of producer order', async () => {
    const code = [
      `import { sketch, ellipse, circle, arc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      `sketch('yz', () => { arc([6, 6], [20, 20]) })`,
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
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `const base = sketch('xy', () => { ellipse(10, 10) })`,
      `const tip = sketch('xz', () => { circle(5) })`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(base, tip)`);
  });

  it('refuses when a sketch producer line is not a sketch call', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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
    `import { sketch, ellipse, circle, bezier } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(10, 10) })`,
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

  it('binds a helix guide through a wire producer', async () => {
    const code = [
      `import { sketch, ellipse, circle, helix } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      `helix('z').radius(10).pitch(4).turns(2)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, loftSpec(
      { guides: [{ kind: 'sketch', producer: 2 }] },
      {
        producers: [
          { line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 5, column: 0, featureType: 'wire', nameHint: 'g', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const guideRow = lines.findIndex(l => l === `const g = helix('z').radius(10).pitch(4).turns(2)`);
    expect(guideRow).toBeGreaterThan(-1);
    expect(lines[guideRow + 1]).toBe(`loft(s, s2).guides(g)`);
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
  `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
  ``,
  `const s = sketch('xy', () => { ellipse(100, 50) })`,
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
    op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, endOffset: null,
    drill: true, thin: null, ...overrides,
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
        draft: null, endOffset: null, drill: true, thin: null, profileText: null,
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
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
        draft: null, endOffset: null, drill: true, thin: [2], profileText: 's',
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
      },
      statement: 'extrude(25, s).thin(2).new()',
    });
  });

  it('reads a two-offset thin extrude', async () => {
    const code = `${editBase}\nextrude(25, s).thin(-2, 3.5)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'add', distance: 25, distance2: null, symmetric: false,
        draft: null, endOffset: null, drill: true, thin: [-2, 3.5], profileText: 's',
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
      },
      statement: 'extrude(25, s).thin(-2, 3.5)',
    });
  });

  it('reads a through-all bound cut', async () => {
    const code = `${editBase}\ncut(s)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'remove', distance: null, distance2: null, symmetric: false,
        draft: null, endOffset: null, drill: true, thin: null, profileText: 's',
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
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
        draft: 5, endOffset: null, drill: false, thin: null, profileText: 's',
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
      },
      statement: 'extrude(10, 20, s).draft(5).drill(false)',
    });
  });

  it('reads an .endOffset() chain', async () => {
    const code = `${editBase}\ncut(20).endOffset(1.5)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'remove', distance: 20, distance2: null, symmetric: false,
        draft: null, endOffset: 1.5, drill: true, thin: null, profileText: null,
        toFaceText: null, toFaceKind: null, scopeTexts: [], scopeRefs: [],
      },
      statement: 'cut(20).endOffset(1.5)',
    });
  });

  it('reads an .endOffset() expression as verbatim text', async () => {
    const code = `${editBase}\nextrude(10).endOffset(gap)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'extrude', endOffset: 'gap' } });
  });

  it('refuses an argument-less .endOffset() chain', async () => {
    const code = `${editBase}\nextrude(10).endOffset()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('endOffset');
    }
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

  it('reads a per-side draft array as verbatim expression text', async () => {
    const code = `${editBase}\nextrude(10).draft([2, 4])\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'extrude', draft: '[2, 4]' } });
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
    const code = `${editBase}\nconst p = sketch('xz', () => { ellipse(1, 60) })\nsweep(p, s).remove()\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'sweep', op: 'remove', thin: null, pathText: 'p', profileText: 's',
        scopeTexts: [], scopeRefs: [],
      },
      statement: 'sweep(p, s).remove()',
    });
  });

  it('reads a wrap with a remove chain', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nwrap(2, s, e.sideFaces(0)).remove()\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'wrap', op: 'remove', thickness: 2, sketchText: 's', faceText: 'e.sideFaces(0)' },
      statement: 'wrap(2, s, e.sideFaces(0)).remove()',
    });
  });

  it('reads a variable wrap thickness as expression text', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nwrap(t, s, e.sideFaces(0))\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'wrap', thickness: 't', sketchText: 's', faceText: 'e.sideFaces(0)' },
    });
  });

  it('refuses a wrap missing its face argument', async () => {
    const code = `${editBase}\nwrap(2, s)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
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

  it('reads an equal-distance chamfer with no second value', async () => {
    const code = `${editBase}\nchamfer(2, e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'chamfer', value: 2, argsText: 'e.endEdges()', distance2: null, isAngle: false },
      statement: 'chamfer(2, e.endEdges())',
    });
  });

  it('reads a two-distance chamfer', async () => {
    const code = `${editBase}\nchamfer(1, 2.5, e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'chamfer', value: 1, argsText: 'e.endEdges()', distance2: 2.5, isAngle: false },
      statement: 'chamfer(1, 2.5, e.endEdges())',
    });
  });

  it('reads a distance-and-angle chamfer', async () => {
    const code = `${editBase}\nchamfer(1, 45, true, e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'chamfer', value: 1, argsText: 'e.endEdges()', distance2: 45, isAngle: true },
      statement: 'chamfer(1, 45, true, e.endEdges())',
    });
  });

  it('reads an explicit false angle flag as two distances', async () => {
    const code = `${editBase}\nchamfer(1, 2, false, e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'chamfer', value: 1, argsText: 'e.endEdges()', distance2: 2, isAngle: false },
    });
  });

  it('reads a numeric-variable second value as expression text', async () => {
    const code = `${editBase}\nconst d = 2\nchamfer(1, d, e.endEdges())\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'chamfer', value: 1, argsText: 'e.endEdges()', distance2: 'd', isAngle: false },
    });
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
        draft: 3, endOffset: null, drill: true, thin: null, profileText: 's',
        toFaceText: 'e.endFaces()', toFaceKind: 'selector', scopeTexts: [], scopeRefs: [],
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
    const code = `${editBase}\nconst b = box(10, 10, 10)\n`;
    const result = await parseFeatureStatement(code, 4);
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

  it('switches a distance extrude to a first-face target, with no picked part', async () => {
    const code = `${toFaceEditBase}\nextrude(40, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: null, toFace: { kind: 'first-face' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude('first-face', s)\n`);
  });

  it('switches a picked to-face target to last-face, dropping the selector', async () => {
    const code = `${toFaceEditBase}\nextrude(e.endFaces(), s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: null, op: 'remove', toFace: { kind: 'last-face' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`cut('last-face', s)\n`);
    expect(result.newCode).not.toContain(`endFaces()`);
  });

  it('keeps a first-face target verbatim while editing other options', async () => {
    const code = `${toFaceEditBase}\nextrude('first-face', s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: null, drill: false, toFace: { kind: 'keep' } }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude('first-face', s).drill(false)\n`);
  });

  it('switches a first-face extrude back to a distance, dropping the target', async () => {
    const code = `${toFaceEditBase}\nextrude('first-face', s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 45 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(45, s)\n`);
    expect(result.newCode).not.toContain(`first-face`);
  });

  it('adds thin and remove chains to a sweep', async () => {
    const code = `${editBase}\nconst p = sketch('xz', () => { ellipse(1, 60) })\nsweep(p, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 5, column: 0,
      sweep: { op: 'remove', thin: [1.5] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(p, s).thin(1.5).remove()`);
  });

  it('rewrites wrap thickness and op in place, keeping both arguments verbatim', async () => {
    const code = `${editBase}\nconst e = extrude(30)\nwrap(2, s, e.sideFaces(0))\n`;
    const result = await applyFeatureEdit(code, editSpec('wrap', {
      line: 5, column: 0,
      wrap: { op: 'remove', thickness: 3.5 },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`wrap(3.5, s, e.sideFaces(0)).remove()`);
    expect(result.newCode).not.toContain(`wrap(2,`);
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

  it('keeps a chamfer second value when the edit spec carries none', async () => {
    const code = `${editBase}\nchamfer(2, 3, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('chamfer', {
      line: 4, column: 0,
    }, { value: 4 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(4, 3, e.endEdges())`);
  });

  it('adds a second distance to an equal-distance chamfer in place', async () => {
    const code = `${editBase}\nchamfer(2, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('chamfer', {
      line: 4, column: 0,
      chamfer: { distance2: 3, isAngle: false },
    }, { value: 2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(2, 3, e.endEdges())`);
  });

  it('switches a two-distance chamfer to distance and angle', async () => {
    const code = `${editBase}\nchamfer(2, 3, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('chamfer', {
      line: 4, column: 0,
      chamfer: { distance2: 60, isAngle: true },
    }, { value: 2 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(2, 60, true, e.endEdges())`);
  });

  it('returns a distance-and-angle chamfer to the equal-distance form', async () => {
    const code = `${editBase}\nchamfer(2, 45, true, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('chamfer', {
      line: 4, column: 0,
      chamfer: { distance2: null, isAngle: false },
    }, { value: 3 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`chamfer(3, e.endEdges())`);
    expect(result.newCode).not.toContain(`45`);
  });

  it('refuses a chamfer edit with an out-of-range angle', async () => {
    const code = `${editBase}\nchamfer(2, e.endEdges())\n`;
    const result = await applyFeatureEdit(code, editSpec('chamfer', {
      line: 4, column: 0,
      chamfer: { distance2: 120, isAngle: true },
    }, { value: 2 }));
    expect(result.error).toContain('malformed chamfer');
    expect(result.newCode).toBe(code);
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
    `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    ``,
  ].join('\n');

  it('appends a standard-base offset plane at top level and imports plane', async () => {
    const result = await applyFeatureEdit(base, planeSpec(planeOptions({ offset: 10 })));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { plane, sketch, ellipse, extrude } from 'fluidcad/core'`);
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
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
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
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { ellipse(10, 10) })`,
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
    expect(result.newCode).toContain(`sketch('xz', () => { ellipse(10, 10) })\nplane(e.endFaces(), 5)`);
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

  it('binds plane producers and appends a mid plane at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, extrude, plane } from 'fluidcad/core'`,
      ``,
      `plane('xy')`,
      `plane('xy', 40)`,
      `sketch('xz', () => { ellipse(10, 10) })`,
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
    // End of scope: after the trailing sketch.
    expect(result.newCode).toContain(`const p2 = plane('xy', 40)\nsketch('xz', () => { ellipse(10, 10) })\nplane(p, p2)`);
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

  it('binds a helix edge plane through a wire base and appends at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, helix } from 'fluidcad/core'`,
      ``,
      `const spring = helix('z').radius(10).pitch(4).turns(6)`,
      `sketch('xz', () => { ellipse(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, planeSpec(
      planeOptions({ type: 'edge', position: 0.5, bases: [{ kind: 'wire', producer: 0 }] }),
      { producers: [{ line: 3, column: 0, featureType: 'wire', nameHint: 'h', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    // End of scope: after the trailing sketch.
    expect(result.newCode).toContain(`const spring = helix('z').radius(10).pitch(4).turns(6)\nsketch('xz', () => { ellipse(10, 10) })\nplane(spring, 0.5)`);
  });

  it('refuses a wire base outside the edge form', async () => {
    const code = [
      `import { helix } from 'fluidcad/core'`,
      ``,
      `helix('z').radius(10).pitch(4).turns(6)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, planeSpec(
      planeOptions({ offset: 5, bases: [{ kind: 'wire', producer: 0 }] }),
      { producers: [{ line: 3, column: 0, featureType: 'wire', nameHint: 'h', bind: true }] },
    ));
    expect(result.error).toContain('malformed plane edit spec');
    expect(result.newCode).toBe(code);
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
      `sketch('xz', () => { ellipse(20, 20) })`,
      `extrude(30, s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 30, profile: { kind: 'sketch', producer: 0 } }),
    }, { producers: [sketchProducer(4)] }));
    expect(result.error).toBeUndefined();
    // The existing `s` keeps its name; the new binding suffixes past it.
    expect(result.newCode).toContain(`const s2 = sketch('xz', () => { ellipse(20, 20) })`);
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
      `import { sketch, ellipse, circle, extrude, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, circle, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
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

  it('re-picks a wrap target face rendered from parts', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude, wrap } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(40)`,
      `const p = sketch('xz', () => { circle(30) })`,
      `wrap(2, p, e.sideFaces(0))`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('wrap', {
      line: 6, column: 0,
      wrap: { op: 'add', thickness: 2, face: { kind: 'selector' } },
    }, {
      producers: [extrudeProducer(4)],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`wrap(2, p, e.endFaces())`);
  });

  it('re-sources a wrap sketch to another sketch, keeping the face verbatim', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude, wrap } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(40)`,
      `const p = sketch('xz', () => { circle(30) })`,
      `wrap(2, p, e.sideFaces(0))`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('wrap', {
      line: 6, column: 0,
      wrap: { op: 'add', thickness: 2, sketch: { kind: 'sketch', producer: 0 } },
    }, { producers: [sketchProducer(3)] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`wrap(2, s, e.sideFaces(0))`);
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
      `sketch('xz', () => { ellipse(20, 20) })`,
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
      `  sketch('xz', () => { ellipse(20, 20) })`,
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

  it('reads a first-face cut as its own target kind, not as a profile', async () => {
    const code = `${editBase}\ncut('first-face')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'remove', distance: null, profileText: null,
        toFaceText: `'first-face'`, toFaceKind: 'first-face',
      },
    });
  });

  it('reads a bound last-face extrude', async () => {
    const code = `${editBase}\nextrude('last-face', s)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'extrude', op: 'add', distance: null, profileText: 's',
        toFaceText: `'last-face'`, toFaceKind: 'last-face',
      },
    });
  });

  it('refuses a filtered first-face target — the dialog cannot represent filters', async () => {
    const code = `${editBase}\nextrude('first-face', face().cylinder())\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('filtered');
    }
  });

  it('refuses a target string that is neither first-face nor last-face', async () => {
    const code = `${editBase}\nextrude('middle-face')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain(`'first-face' or 'last-face'`);
    }
  });

  it('strips the breakpoint atomically with the rewrite when clearBreakpoints is set', async () => {
    const code = [
      `import { breakpoint, sketch, ellipse, extrude, shell } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { breakpoint, sketch, ellipse, extrude, shell } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
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
      `import { sketch, ellipse, extrude, sweep } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
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
        op: 'add', angle: 360, symmetric: false, thin: null, profile: 'implicit',
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

  it('binds a bound profile and appends the revolve at end of scope', async () => {
    const code = [
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      `sketch('xy', () => { ellipse(10, 10) })`,
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
    // End of scope: after the later sketch, not directly after the profile.
    expect(lines[profileRow + 1]).toBe(`sketch('xy', () => { ellipse(10, 10) })`);
    expect(lines[profileRow + 2]).toBe(`revolve('z', 90, s)`);
  });

  it('binds an axis statement and appends at end of scope', async () => {
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
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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

  it('chains .symmetric() before the thin and operation chains', async () => {
    const result = await applyFeatureEdit(oneSketchCode, revolveSpec({ op: 'remove', angle: 90, symmetric: true, thin: [2] }));
    expect(result.newCode).toContain(`revolve('z', 90).symmetric().thin(2).remove()`);
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
      `import { sketch, ellipse, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      `sketch('xy', () => { ellipse(10, 10) })`,
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

describe('helix statement templates', () => {
  function helixSpec(
    helix: Partial<NonNullable<ApplyFeatureEditSpec['helix']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'helix',
      filePath: '/ws/model.fluid.js',
      helix: {
        source: { kind: 'standard', axis: 'z' },
        radius: null, endRadius: null, pitch: null, turns: null,
        height: null, startOffset: null, endOffset: null,
        ...helix,
      },
      producers: [],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const seedCode = [
    `import { sketch, circle } from 'fluidcad/core'`,
    ``,
    `sketch('xz', () => { circle(2) })`,
    ``,
  ].join('\n');

  it('appends a standard-axis helix at top level and imports helix', async () => {
    const result = await applyFeatureEdit(seedCode, helixSpec({ radius: 15, pitch: 10, turns: 4 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`helix('z').radius(15).pitch(10).turns(4)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bhelix\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('chains only the set options, in canonical order', async () => {
    const result = await applyFeatureEdit(seedCode, helixSpec({
      radius: 20, endRadius: 10, pitch: 5, turns: 3, height: 30, startOffset: -5, endOffset: 5,
    }));
    expect(result.newCode).toContain(
      `helix('z').radius(20).endRadius(10).pitch(5).turns(3).height(30).startOffset(-5).endOffset(5)`,
    );
  });

  it('binds an axis statement and inserts after it', async () => {
    const code = [
      `import { axis } from 'fluidcad/core'`,
      ``,
      `axis('y', { offsetZ: 100 })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, helixSpec(
      { source: { kind: 'axis', producer: 0 }, turns: 3 },
      { producers: [{ line: 3, column: 0, featureType: 'axis', nameHint: 'a', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const axisRow = lines.findIndex(l => l === `const a = axis('y', { offsetZ: 100 })`);
    expect(axisRow).toBeGreaterThan(-1);
    expect(lines[axisRow + 1]).toBe(`helix(a).turns(3)`);
  });

  it('wraps a picked-edge source in axis() and imports axis', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, helixSpec(
      { source: { kind: 'edge' }, turns: 2 },
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
        imports: ['axis'],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`helix(axis(e.endEdges(2))).turns(2)`);
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b/);
  });

  it('renders a picked-face source on its own', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, helixSpec(
      { source: { kind: 'face' }, turns: 6 },
      {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideFaces', indices: [0], filterArgs: null }],
        imports: [],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`helix(e.sideFaces(0)).turns(6)`);
  });

  it('refuses a selector source without its part', async () => {
    const result = await applyFeatureEdit(seedCode, helixSpec({ source: { kind: 'face' } }));
    expect(result.error).toContain('malformed');
    expect(result.newCode).toBe(seedCode);
  });
});

describe('parseFeatureStatement — helix', () => {
  it('reads a standard-axis helix with options', async () => {
    const code = `${editBase}\nhelix('z').radius(15).pitch(10).turns(4)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'helix', sourceText: `'z'`, sourceMode: 'axis',
        radius: 15, endRadius: null, pitch: 10, turns: 4, height: null,
        startOffset: null, endOffset: null,
      },
      statement: `helix('z').radius(15).pitch(10).turns(4)`,
    });
  });

  it('reads a face-selector source as face mode', async () => {
    const code = `${editBase}\nhelix(e.sideFaces(0)).turns(6)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'helix', sourceText: 'e.sideFaces(0)', sourceMode: 'face', turns: 6 },
    });
  });

  it('reads an axis() source as axis mode, kept verbatim', async () => {
    const code = `${editBase}\nhelix(axis(e.edges(3))).turns(3).height(50)\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'helix', sourceText: 'axis(e.edges(3))', sourceMode: 'axis', turns: 3, height: 50 },
    });
  });

  it('keeps a trailing unrecognized chain out of the statement span', async () => {
    const code = `${editBase}\nhelix('z').turns(4).name('coil')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'helix', turns: 4 },
      statement: `helix('z').turns(4)`,
    });
  });
});

describe('applyFeatureEdit (helix in-place statement edit)', () => {
  const helixEditBase = [
    `import { cylinder, helix, axis } from 'fluidcad/core'`,
    ``,
    `cylinder(15, 60)`,
  ].join('\n');

  function helixEditOptions(
    overrides: Partial<NonNullable<FeatureStatementEditTarget['helix']>> = {},
  ): NonNullable<FeatureStatementEditTarget['helix']> {
    return {
      radius: null, endRadius: null, pitch: null, turns: null,
      height: null, startOffset: null, endOffset: null, ...overrides,
    };
  }

  it('replaces options in place, keeping the source verbatim', async () => {
    const code = `${helixEditBase}\nhelix('z').radius(15).turns(4)\n`;
    const result = await applyFeatureEdit(code, editSpec('helix', {
      line: 4, column: 0,
      helix: helixEditOptions({ radius: 20, pitch: 8, turns: 6 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${helixEditBase}\nhelix('z').radius(20).pitch(8).turns(6)\n`);
  });

  it('keeps a face-selector source verbatim while editing turns', async () => {
    const code = `${helixEditBase}\nhelix(e.sideFaces(0)).turns(6)\n`;
    const result = await applyFeatureEdit(code, editSpec('helix', {
      line: 4, column: 0,
      helix: helixEditOptions({ turns: 8 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${helixEditBase}\nhelix(e.sideFaces(0)).turns(8)\n`);
  });

  it('drops an option cleared to null', async () => {
    const code = `${helixEditBase}\nhelix('z').radius(15).endRadius(8).turns(4)\n`;
    const result = await applyFeatureEdit(code, editSpec('helix', {
      line: 4, column: 0,
      helix: helixEditOptions({ radius: 15, turns: 4 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${helixEditBase}\nhelix('z').radius(15).turns(4)\n`);
  });
});

describe('parseFeatureStatement — revolve', () => {
  it('reads a plain standard-axis revolve', async () => {
    const code = `${editBase}\nrevolve('z')\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'revolve', op: 'add', angle: null, symmetric: false, thin: null,
        axisText: `'z'`, profileText: null, scopeTexts: [], scopeRefs: [],
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
        feature: 'revolve', op: 'remove', angle: null, symmetric: false, thin: null,
        axisText: 'a', profileText: 's', scopeTexts: [], scopeRefs: [],
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

  it('reads a .symmetric() chain into the statement span', async () => {
    const code = `${editBase}\nrevolve('z', 180).symmetric()\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', angle: 180, symmetric: true },
      statement: `revolve('z', 180).symmetric()`,
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
    `import { sketch, ellipse, extrude, revolve } from 'fluidcad/core'`,
    ``,
    `const s = sketch('xy', () => { ellipse(100, 50) })`,
  ].join('\n');

  function revolveEditOptions(
    overrides: Partial<NonNullable<FeatureStatementEditTarget['revolve']>> = {},
  ): NonNullable<FeatureStatementEditTarget['revolve']> {
    return { op: 'add', angle: 360, symmetric: false, thin: null, ...overrides };
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

  it('adds and drops the .symmetric() chain in place', async () => {
    const code = `${revolveEditBase}\nrevolve('z', 90)\n`;
    const added = await applyFeatureEdit(code, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 90, symmetric: true }),
    }));
    expect(added.error).toBeUndefined();
    expect(added.newCode).toBe(`${revolveEditBase}\nrevolve('z', 90).symmetric()\n`);

    const dropped = await applyFeatureEdit(added.newCode!, editSpec('revolve', {
      line: 4, column: 0,
      revolve: revolveEditOptions({ angle: 90 }),
    }));
    expect(dropped.error).toBeUndefined();
    expect(dropped.newCode).toBe(code);
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
      `import { sketch, ellipse, circle, extrude, revolve } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
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

// ---------------------------------------------------------------------------
// Text statements (timeline double-click → text edit dialog)
// ---------------------------------------------------------------------------

const textEditBase = [
  `import { sketch, text } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => {`,
].join('\n');

function textEditOptions(
  overrides: Partial<NonNullable<FeatureStatementEditTarget['text']>> = {},
): NonNullable<FeatureStatementEditTarget['text']> {
  return {
    text: 'Hello', size: 10, font: null, weight: 400, italic: false,
    align: 'left', lineSpacing: 1, letterSpacing: 0,
    offset: 0, startAt: 0, flip: false, ...overrides,
  };
}

describe('parseFeatureStatement — text', () => {
  it('reads a bare text call with defaults', async () => {
    const code = `${textEditBase}\n  text("Hello")\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'text', text: 'Hello', size: 10, font: null, weight: 400,
        italic: false, align: 'left', lineSpacing: 1, letterSpacing: 0,
        offset: 0, startAt: 0, flip: false, pathText: null,
      },
      statement: 'text("Hello")',
    });
  });

  it('reads a full option chain', async () => {
    const code = `${textEditBase}\n  text("Hi").font('Georgia').size(14).bold().italic().align('center').lineSpacing(1.2).letterSpacing(-0.5)\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.parsed).toMatchObject({
        feature: 'text', text: 'Hi', font: 'Georgia', size: 14, weight: 700,
        italic: true, align: 'center', lineSpacing: 1.2, letterSpacing: -0.5,
      });
    }
  });

  it('decodes string escapes into the value', async () => {
    const code = `${textEditBase}\n  text("Line1\\nLine2's")\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.feature === 'text') {
      expect(result.parsed.text).toBe("Line1\nLine2's");
    }
  });

  it('maps weight names and normalizes start alignment', async () => {
    const code = `${textEditBase}\n  text("Hi").weight('semibold').align('start')\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.feature === 'text') {
      expect(result.parsed.weight).toBe(600);
      expect(result.parsed.align).toBe('left');
    }
  });

  it('keeps a path argument verbatim and reads the path-only chains', async () => {
    const code = `${textEditBase}\n  text("Hi", p.arc).size(5).offset(2).startAt(10).flip()\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.feature === 'text') {
      expect(result.parsed.pathText).toBe('p.arc');
      expect(result.parsed.offset).toBe(2);
      expect(result.parsed.startAt).toBe(10);
      expect(result.parsed.flip).toBe(true);
      expect(result.statement).toBe('text("Hi", p.arc).size(5).offset(2).startAt(10).flip()');
    }
  });

  it('refuses a non-literal text string', async () => {
    const code = `${textEditBase}\n  text(label)\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('plain string') });
  });

  it('refuses a variable size', async () => {
    const code = `${textEditBase}\n  text("Hi").size(h)\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('.size()') });
  });

  it('refuses chaining both weight and bold', async () => {
    const code = `${textEditBase}\n  text("Hi").weight(300).bold()\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('.weight() and .bold()') });
  });

  it('reads the distributed alignments on a path statement', async () => {
    const code = `${textEditBase}\n  text("Hi", p).align('space-between')\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result.ok).toBe(true);
    if (result.ok && result.parsed.feature === 'text') {
      expect(result.parsed.align).toBe('space-between');
    }
  });

  it('refuses the distributed alignments on a path-less statement', async () => {
    const code = `${textEditBase}\n  text("Hi").align('space-between')\n})\n`;
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('.align()') });
  });
});

describe('applyFeatureEdit (text in-place statement edit)', () => {
  it('rewrites the options in place at the statement indent', async () => {
    const code = `${textEditBase}\n  text("Hello").size(12)\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: textEditOptions({ text: 'Hi there', font: 'Georgia', size: 14, weight: 700, align: 'center' }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `${textEditBase}\n  text("Hi there").font('Georgia').size(14).bold().align('center')\n})\n`,
    );
  });

  it('drops chains back to defaults', async () => {
    const code = `${textEditBase}\n  text("Hi").size(14).bold().italic()\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: textEditOptions({ text: 'Hi' }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  text("Hi")\n`);
  });

  it('keeps the path argument verbatim and rewrites the path-only chains', async () => {
    const code = `${textEditBase}\n  text("Hi", p.arc).size(5).offset(2).flip()\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: textEditOptions({ text: 'New', size: 8, offset: 3, startAt: 5, flip: true }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  text("New", p.arc).size(8).offset(3).startAt(5).flip()\n`);
  });

  it('refuses path-only options when the path is dropped', async () => {
    const code = `${textEditBase}\n  text("Hi", p.arc).flip()\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: { ...textEditOptions({ text: 'Hi', flip: true }), path: { kind: 'none' } },
    }));
    expect(result.error).toContain('only apply to text following a path');
    expect(result.newCode).toBe(code);
  });

  it('drops the path argument on path: none', async () => {
    const code = `${textEditBase}\n  text("Hi", p.arc).size(5)\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: { ...textEditOptions({ text: 'Hi', size: 5 }), path: { kind: 'none' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  text("Hi").size(5)\n`);
  });

  it('re-targets the path onto a picked geometry, binding its statement', async () => {
    const code = `${textEditBase.replace("{ sketch, text }", "{ sketch, text, arc }")}\n  arc([0, 0], [60, 0], 40)\n  text("Hi", p.arc)\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 5, column: 2,
      text: { ...textEditOptions({ text: 'Hi' }), path: { kind: 'selector' } },
    }, {
      producers: [{ line: 4, column: 2, featureType: 'arc', nameHint: 'a', bind: true }],
      parts: [{ producer: 0, accessor: '', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const a = arc([0, 0], [60, 0], 40)\n`);
    expect(result.newCode).toContain(`  text("Hi", a)\n`);
  });

  it('refuses a selector path without exactly one part', async () => {
    const code = `${textEditBase}\n  text("Hi", p.arc)\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: { ...textEditOptions({ text: 'Hi' }), path: { kind: 'selector' } },
    }));
    expect(result.error).toContain('exactly one geometry');
    expect(result.newCode).toBe(code);
  });

  it('escapes the new string as a double-quoted literal', async () => {
    const code = `${textEditBase}\n  text("Hi")\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: textEditOptions({ text: 'Line1\nLine2 "q"' }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  text("Line1\\nLine2 \\"q\\"")\n`);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${textEditBase}\n  text("Hello")\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      expectedStatement: 'text("Something else")',
      text: textEditOptions(),
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });

  it('refuses an empty replacement text', async () => {
    const code = `${textEditBase}\n  text("Hello")\n})\n`;
    const result = await applyFeatureEdit(code, editSpec('text', {
      line: 4, column: 2,
      text: textEditOptions({ text: '   ' }),
    }));
    expect(result.error).toContain('empty');
    expect(result.newCode).toBe(code);
  });
});

describe('parseFeatureStatement — sketch', () => {
  it('reads a plane-string sketch, body verbatim', async () => {
    const code = `${editBase}\nextrude(30)\n`;
    const result = await parseFeatureStatement(code, 3);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'sketch', targetText: `'xy'`, bodyText: '() => { ellipse(100, 50) }', solvedText: null },
      statement: `sketch('xy', () => { ellipse(100, 50) })`,
    });
  });

  it('reads a bare one-argument sketch', async () => {
    const code = [`import { sketch, ellipse } from 'fluidcad/core'`, ``, `sketch(() => { ellipse(4, 4) })`, ``].join('\n');
    const result = await parseFeatureStatement(code, 3);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'sketch', targetText: null, bodyText: '() => { ellipse(4, 4) }' },
    });
  });

  it('refuses a sketch with an argument shape the dialog cannot edit', async () => {
    const code = [`import { sketch } from 'fluidcad/core'`, ``, `sketch('xy', 3, () => {})`, ``].join('\n');
    const result = await parseFeatureStatement(code, 3);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('applyFeatureEdit (sketch retarget)', () => {
  it('rewrites the target onto an origin plane, keeping the body and chains', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  ellipse(100, 50)`,
      `}).name('base')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'standard', plane: 'xz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => {`,
      `  ellipse(100, 50)`,
      `}).name('base')`,
      ``,
    ].join('\n'));
  });

  it('preserves the solved-mode flag of a 3-arg sketch through a retarget (P5)', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  line([0, 0], [10, 0]);`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'standard', plane: 'xz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xz', () => {`);
    expect(result.newCode).toContain(`})`);
  });

  it('retargets a bare solved sketch (callback + flag only) onto a plane, keeping the flag', async () => {
    const code = [
      `import { sketch } from 'fluidcad/core'`,
      ``,
      `sketch(() => {`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'standard', plane: 'xz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xz', () => {`);
    expect(result.newCode).toContain(`})`);
  });

  it('gives a bare one-argument sketch its first target argument', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch(() => { ellipse(4, 4) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'standard', plane: 'yz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('yz', () => { ellipse(4, 4) })`);
  });

  it('rewrites the target onto a picked face selector, binding its producer', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => { ellipse(5, 5) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 5, column: 0,
      sketch: { target: { kind: 'selector' } },
    }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30)`);
    expect(result.newCode).toContain(`sketch(e.endFaces(0), () => { ellipse(5, 5) })`);
  });

  it('rewrites the target onto a plane feature, reusing its binding', async () => {
    const code = [
      `import { sketch, ellipse, plane } from 'fluidcad/core'`,
      ``,
      `const top = plane('xy', 20)`,
      `sketch('xy', () => { ellipse(5, 5) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 4, column: 0,
      sketch: { target: { kind: 'plane', producer: 0 } },
    }, {
      producers: [{ line: 3, column: 12, featureType: 'plane', nameHint: 'p', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch(top, () => { ellipse(5, 5) })`);
  });

  it('refuses a plane feature that follows the sketch statement', async () => {
    const code = [
      `import { sketch, ellipse, plane } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(5, 5) })`,
      `const top = plane('xy', 20)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'plane', producer: 0 } },
    }, {
      producers: [{ line: 4, column: 12, featureType: 'plane', nameHint: 'p', bind: true }],
    }));
    expect(result.error).toContain('does not precede');
    expect(result.newCode).toBe(code);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${editBase}\n`;
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      expectedStatement: `sketch('xz', () => {})`,
      sketch: { target: { kind: 'standard', plane: 'yz' } },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });
});

describe('repeat statement templates', () => {
  const base = [
    `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `cut(5)`,
  ].join('\n');

  function repeatSpec(
    repeat: NonNullable<ApplyFeatureEditSpec['repeat']>,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'repeat',
      repeat,
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('binds two bare targets and appends a linear repeat on a standard axis', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { repeat, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, f, f2)`,
      ``,
    ].join('\n'));
  });

  it('renders the length mode with the centered flag', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'linear',
      spacingMode: 'length',
      directions: [{ axis: { kind: 'standard', axis: 'y' }, count: 4, value: 120 }],
      centered: true,
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `repeat('linear', 'y', { count: 4, length: 120, centered: true }, f)`,
    );
  });

  it('renders two directions as the array forms', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [
        { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
        { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 30 },
      ],
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `repeat('linear', ['x', 'y'], { count: [3, 2], offset: [40, 30] }, f)`,
    );
  });

  it('renders a picked-edge axis as axis(<selector>) on the target itself', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'selector', part: 0 }, count: 2, value: 25 }],
      targets: [{ producer: 0 }],
    }, {
      parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `repeat('linear', axis(f.endEdges(2)), { count: 2, offset: 25 }, f)`,
    );
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\brepeat\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('renders a circular repeat around an existing axis statement, reusing bindings', async () => {
    const code = [
      `import { sketch, ellipse, extrude, axis } from 'fluidcad/core'`,
      ``,
      `const a = axis('z')`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, repeatSpec({
      kind: 'circular',
      axis: { kind: 'axis', producer: 1 },
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 3, column: 10, featureType: 'axis', nameHint: 'a', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('circular', a, { count: 6, angle: 360 }, e)`);
  });

  it('renders a mirror across a picked face lifted into plane(<selector>)', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'mirror',
      plane: { kind: 'selector', part: 0 },
      targets: [{ producer: 0 }],
    }, {
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      imports: ['plane'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('mirror', plane(f.endFaces(0)), f)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bplane\b[^}]*\brepeat\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('accepts a fillet statement as a repeat target', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(2, e.endEdges())`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, repeatSpec({
      kind: 'mirror',
      plane: { kind: 'standard', plane: 'yz' },
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 5, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = fillet(2, e.endEdges())`);
    expect(result.newCode).toContain(`repeat('mirror', 'yz', f)`);
  });

  it('accepts a select statement as a repeat target', async () => {
    const code = [
      `import { sketch, ellipse, extrude, select } from 'fluidcad/core'`,
      `import { face } from 'fluidcad/filters'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `const s = select(face().top())`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, repeatSpec({
      kind: 'mirror',
      plane: { kind: 'standard', plane: 'yz' },
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('mirror', 'yz', e, s)`);
  });

  it('omits the 90-degree rotate default and renders other angles', async () => {
    const ninety = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'rotate',
      axis: { kind: 'standard', axis: 'z' },
      angle: 90,
      targets: [{ producer: 0 }],
    }));
    expect(ninety.error).toBeUndefined();
    expect(ninety.newCode).toContain(`repeat('rotate', 'z', f)`);

    const tilted = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'rotate',
      axis: { kind: 'standard', axis: 'z' },
      angle: 45,
      targets: [{ producer: 0 }],
    }));
    expect(tilted.error).toBeUndefined();
    expect(tilted.newCode).toContain(`repeat('rotate', 'z', 45, f)`);
  });

  it('refuses a target line that holds a sketch call', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'rotate',
      axis: { kind: 'standard', axis: 'z' },
      angle: 45,
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toContain('expected a feature()-producing call');
    expect(result.newCode).toBe(`${base}\n`);
  });

  it('refuses a repeat spec with no targets', async () => {
    const result = await applyFeatureEdit(`${base}\n`, repeatSpec({
      kind: 'mirror',
      plane: { kind: 'standard', plane: 'xy' },
      targets: [],
    }, { producers: [] }));
    expect(result.error).toBe('malformed repeat edit spec');
    expect(result.newCode).toBe(`${base}\n`);
  });
});

const repeatEditBase = [
  `import { sketch, ellipse, extrude, cut, repeat } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — repeat', () => {
  it('reads a single-direction linear repeat', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'repeat', kind: 'linear', axisTexts: [`'x'`], planeText: null,
        directions: [{ count: 3, value: 40 }], spacingMode: 'offset', centered: false,
        count: null, sweep: null, angle: null, targetTexts: ['e'],
        // The bound extrude call's own position — the timeline row's location.
        targetRefs: [{ line: 4, column: 10 }],
      },
      statement: `repeat('linear', 'x', { count: 3, offset: 40 }, e)`,
    });
  });

  it('reads the two-direction array forms with length and centered', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', ['x', a], { count: [3, 2], length: [120, 60], centered: true }, e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'repeat', kind: 'linear', axisTexts: [`'x'`, 'a'],
        directions: [{ count: 3, value: 120 }, { count: 2, value: 60 }],
        spacingMode: 'length', centered: true, targetTexts: ['e', 'c'],
      },
    });
  });

  it('broadcasts scalar counts and values across two directions', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', ['x', 'y'], { count: 3, offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { directions: [{ count: 3, value: 40 }, { count: 3, value: 40 }] },
    });
  });

  it('reads a circular repeat keeping the axis expression verbatim', async () => {
    const code = `${repeatEditBase}\nrepeat('circular', axis(e.endEdges(2)), { count: 6, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'repeat', kind: 'circular', axisTexts: ['axis(e.endEdges(2))'],
        count: 6, sweep: { mode: 'angle', value: 360 }, targetTexts: ['e'],
      },
    });
  });

  it('reads a mirror repeat with several targets', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'yz', e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'repeat', kind: 'mirror', axisTexts: [], planeText: `'yz'`,
        targetTexts: ['e', 'c'],
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
    });
  });

  it('resolves identifier targets to their statements and leaves other expressions null', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'yz', e, extrude(5))\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        targetTexts: ['e', 'extrude(5)'],
        targetRefs: [{ line: 4, column: 10 }, null],
      },
    });
  });

  it('reads a rotate with and without the angle argument', async () => {
    const withAngle = await parseFeatureStatement(`${repeatEditBase}\nrepeat('rotate', 'z', 45, e)\n`, 7);
    expect(withAngle).toMatchObject({
      ok: true,
      parsed: { feature: 'repeat', kind: 'rotate', axisTexts: [`'z'`], angle: 45, targetTexts: ['e'] },
    });
    const defaulted = await parseFeatureStatement(`${repeatEditBase}\nrepeat('rotate', a, e)\n`, 7);
    expect(defaulted).toMatchObject({
      ok: true,
      parsed: { feature: 'repeat', kind: 'rotate', axisTexts: ['a'], angle: null, targetTexts: ['e'] },
    });
  });

  it('reads an implicit-target repeat as empty target texts', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'xy')\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'repeat', targetTexts: [] } });
  });

  it('keeps chained calls after the root call out of the statement span', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', 'z', 45, e).name('ring')\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      statement: `repeat('rotate', 'z', 45, e)`,
    });
  });

  it('refuses the raw-matrix form', async () => {
    const code = `${repeatEditBase}\nrepeat(m, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('matrix repeat');
    }
  });

  it('refuses an option the dialog does not offer', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', 'x', { count: 3, offset: 40, skip: [[1]] }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain(`'skip'`);
    }
  });

  it('reads a variable count as expression text', async () => {
    const code = `${repeatEditBase}\nrepeat('circular', 'z', { count: n, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'repeat', kind: 'circular', count: 'n', sweep: { mode: 'angle', value: 360 } },
    });
  });

  it('refuses more than two linear directions', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', ['x', 'y', 'z'], { count: 2, offset: 10 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('more than two directions');
    }
  });

  it('refuses option arities that do not match the directions', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', 'x', { count: [3, 2], offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('do not match the directions');
    }
  });
});

describe('applyFeatureEdit (repeat in-place statement edit)', () => {
  it('replaces the numeric options in place, keeping axis and targets verbatim', async () => {
    const code = `${repeatEditBase}\nrepeat('linear', axis(e.endEdges(2)), { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: {
        kind: 'linear',
        spacingMode: 'length',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 5, value: 120 }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `${repeatEditBase}\nrepeat('linear', axis(e.endEdges(2)), { count: 5, length: 120 }, e)\n`,
    );
  });

  it('preserves the binding and a chained suffix', async () => {
    const code = `${repeatEditBase}\nconst r = repeat('rotate', 'z', 45, e).name('ring');\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 30, axis: { kind: 'keep', sourceIndex: 0 } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = repeat('rotate', 'z', 30, e).name('ring');`);
  });

  it('omits the 90-degree rotate default', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', 'z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 90, axis: { kind: 'keep', sourceIndex: 0 } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('rotate', 'z', e)\n`);
  });

  it('switches a circular repeat to a rotate, keeping the axis expression', async () => {
    const code = `${repeatEditBase}\nrepeat('circular', a, { count: 6, angle: 360 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 45, axis: { kind: 'keep', sourceIndex: 0 } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('rotate', a, 45, e)\n`);
  });

  it('replaces the target list, mixing kept and re-picked features', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: {
        kind: 'mirror',
        plane: { kind: 'keep' },
        targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
      },
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('mirror', 'yz', e, c)\n`);
  });

  it('re-sources the axis with a standard world axis', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', axis(e.endEdges(2)), 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 45, axis: { kind: 'standard', axis: 'z' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('rotate', 'z', 45, e)\n`);
  });

  it('renders a re-picked selector axis from its part', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', 'z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 45, axis: { kind: 'selector', part: 0 } },
    }, {
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [3], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('rotate', axis(e.endEdges(3)), 45, e)\n`);
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', 'z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      expectedStatement: `repeat('rotate', 'z', 44, e)`,
      repeat: { kind: 'rotate', angle: 30, axis: { kind: 'keep', sourceIndex: 0 } },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });

  it('refuses a kept axis the statement does not have', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'rotate', angle: 45, axis: { kind: 'keep', sourceIndex: 0 } },
    }));
    expect(result.error).toContain('kept axis no longer matches');
    expect(result.newCode).toBe(code);
  });

  it('refuses an empty replacement target list', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'mirror', plane: { kind: 'keep' }, targets: [] },
    }));
    expect(result.error).toContain('at least one target');
    expect(result.newCode).toBe(code);
  });

  it('keeps an implicit-target repeat implicit when no target list rides the spec', async () => {
    const code = `${repeatEditBase}\nrepeat('mirror', 'xy')\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: { kind: 'mirror', plane: { kind: 'standard', plane: 'yz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('mirror', 'yz')\n`);
  });
});

describe('copy statement templates', () => {
  const base = [
    `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `cut(5)`,
  ].join('\n');

  function copySpec(
    copy: NonNullable<ApplyFeatureEditSpec['copy']>,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'copy',
      copy,
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('binds two bare targets and appends a linear copy on a standard axis', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { copy, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `copy('linear', 'x', { count: 3, offset: 40 }, f, f2)`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const target binding', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('linear', 'x', { count: 3, offset: 40 }, e)`);
    expect(result.newCode).not.toContain('const f =');
  });

  it('renders two directions as the array forms with the centered flag', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [
        { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
        { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 30 },
      ],
      centered: true,
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `copy('linear', ['x', 'y'], { count: [3, 2], offset: [40, 30], centered: true }, f)`,
    );
  });

  it('closes a linear options object with the skip list, cells and all', async () => {
    const single = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 4, value: 40 }],
      skip: [[1], [3]],
      targets: [{ producer: 0 }],
    }));
    expect(single.error).toBeUndefined();
    expect(single.newCode).toContain(
      `copy('linear', 'x', { count: 4, offset: 40, skip: [[1], [3]] }, f)`,
    );

    const grid = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [
        { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
        { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 30 },
      ],
      skip: [[1, 0]],
      targets: [{ producer: 0 }],
    }));
    expect(grid.error).toBeUndefined();
    expect(grid.newCode).toContain(
      `copy('linear', ['x', 'y'], { count: [3, 2], offset: [40, 30], skip: [[1, 0]] }, f)`,
    );
  });

  /** The one place the two kinds spell a skip differently (copy-circular.ts:55). */
  it('flattens a circular skip list to bare instance indices', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'circular',
      axis: { kind: 'standard', axis: 'z' },
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      skip: [[2], [4]],
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('circular', 'z', { count: 6, angle: 360, skip: [2, 4] }, f)`);
  });

  it('renders a circular copy with angle and with offset sweeps', async () => {
    const withAngle = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'circular',
      axis: { kind: 'standard', axis: 'z' },
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      targets: [{ producer: 0 }],
    }));
    expect(withAngle.error).toBeUndefined();
    expect(withAngle.newCode).toContain(`copy('circular', 'z', { count: 6, angle: 360 }, f)`);

    const withOffset = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'circular',
      axis: { kind: 'standard', axis: 'z' },
      count: 6,
      sweep: { mode: 'offset', value: 30 },
      targets: [{ producer: 0 }],
    }));
    expect(withOffset.error).toBeUndefined();
    expect(withOffset.newCode).toContain(`copy('circular', 'z', { count: 6, offset: 30 }, f)`);
  });

  it('renders a picked-edge axis as axis(<selector>) on the target itself', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'selector', part: 0 }, count: 2, value: 25 }],
      targets: [{ producer: 0 }],
    }, {
      parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `copy('linear', axis(f.endEdges(2)), { count: 2, offset: 25 }, f)`,
    );
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\bcopy\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('renders a circular copy around an existing axis statement, reusing bindings', async () => {
    const code = [
      `import { sketch, ellipse, extrude, axis } from 'fluidcad/core'`,
      ``,
      `const a = axis('z')`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, copySpec({
      kind: 'circular',
      axis: { kind: 'axis', producer: 1 },
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 3, column: 10, featureType: 'axis', nameHint: 'a', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('circular', a, { count: 6, angle: 360 }, e)`);
  });

  it('refuses a target line that holds a sketch call', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'linear',
      spacingMode: 'offset',
      directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toContain('expected a feature()-producing call');
    expect(result.newCode).toBe(`${base}\n`);
  });

  it('refuses a copy spec with no targets', async () => {
    const result = await applyFeatureEdit(`${base}\n`, copySpec({
      kind: 'circular',
      axis: { kind: 'standard', axis: 'z' },
      count: 6,
      sweep: { mode: 'angle', value: 360 },
      targets: [],
    }, { producers: [] }));
    expect(result.error).toBe('malformed copy edit spec');
    expect(result.newCode).toBe(`${base}\n`);
  });
});

const copyEditBase = [
  `import { sketch, ellipse, extrude, cut, copy } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — copy', () => {
  it('reads a single-direction linear copy', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'copy', kind: 'linear', axisTexts: [`'x'`],
        directions: [{ count: 3, value: 40 }], spacingMode: 'offset', centered: false,
        count: null, sweep: null, center: null, skip: null, targetTexts: ['e'],
        // The bound extrude call's own position — the timeline row's location.
        targetRefs: [{ line: 4, column: 10 }],
      },
      statement: `copy('linear', 'x', { count: 3, offset: 40 }, e)`,
    });
  });

  it('reads the two-direction array forms with length and centered', async () => {
    const code = `${copyEditBase}\ncopy('linear', ['x', a], { count: [3, 2], length: [120, 60], centered: true }, e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'copy', kind: 'linear', axisTexts: [`'x'`, 'a'],
        directions: [{ count: 3, value: 120 }, { count: 2, value: 60 }],
        spacingMode: 'length', centered: true, targetTexts: ['e', 'c'],
      },
    });
  });

  it('broadcasts scalar counts and values across two directions', async () => {
    const code = `${copyEditBase}\ncopy('linear', ['x', 'y'], { count: 3, offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { directions: [{ count: 3, value: 40 }, { count: 3, value: 40 }] },
    });
  });

  it('reads a circular copy keeping the axis expression verbatim', async () => {
    const code = `${copyEditBase}\ncopy('circular', axis(e.endEdges(2)), { count: 6, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'copy', kind: 'circular', axisTexts: ['axis(e.endEdges(2))'],
        count: 6, sweep: { mode: 'angle', value: 360 }, targetTexts: ['e'],
      },
    });
  });

  it('reads the circular center-point form (the 2D in-sketch copy)', async () => {
    const code = `${copyEditBase}\ncopy('circular', [10, 20], { count: 6, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'copy', kind: 'circular', center: [10, 20],
        count: 6, sweep: { mode: 'angle', value: 360 }, targetTexts: ['e'],
      },
    });
  });

  it('refuses a center point that is not a plain [x, y] pair', async () => {
    const code = `${copyEditBase}\ncopy('circular', [10, 20, 30], { count: 6, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('[x, y]');
    }
  });

  it('refuses a copy type the dialog does not know', async () => {
    const code = `${copyEditBase}\ncopy('spiral', 'z', { count: 6, angle: 360 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain(`'spiral'`);
    }
  });

  it('refuses an option the dialog does not offer', async () => {
    const linear = await parseFeatureStatement(
      `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40, spacing: 5 }, e)\n`, 7,
    );
    expect(linear).toMatchObject({ ok: false });
    if (linear.ok === false) {
      expect(linear.reason).toContain(`'spacing'`);
    }
    const circular = await parseFeatureStatement(
      `${copyEditBase}\ncopy('circular', 'z', { count: 6, angle: 360, centered: true }, e)\n`, 7,
    );
    expect(circular).toMatchObject({ ok: false });
    if (circular.ok === false) {
      expect(circular.reason).toContain(`'centered'`);
    }
  });

  it('reads a linear skip list as index tuples', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 4, offset: 40, skip: [[1], [3]] }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'copy', kind: 'linear', skip: [[1], [3]] },
    });
  });

  it('reads a grid skip list, a whole-row entry included', async () => {
    const code = `${copyEditBase}\ncopy('linear', ['x', 'y'], { count: [3, 2], offset: [40, 30], skip: [[1, 0], [2]] }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { skip: [[1, 0], [2]] },
    });
  });

  it("reads a circular skip list as the dialog's single-index tuples", async () => {
    const code = `${copyEditBase}\ncopy('circular', 'z', { count: 6, angle: 360, skip: [2, 4] }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'copy', kind: 'circular', skip: [[2], [4]] },
    });
  });

  it('refuses a skip list that is not plain instance indices', async () => {
    for (const statement of [
      `copy('linear', 'x', { count: 3, offset: 40, skip: [[n]] }, e)`,
      `copy('linear', 'x', { count: 3, offset: 40, skip: [1] }, e)`,
      `copy('circular', 'z', { count: 6, angle: 360, skip: [[1]] }, e)`,
    ]) {
      const result = await parseFeatureStatement(`${copyEditBase}\n${statement}\n`, 7);
      expect(result, statement).toMatchObject({ ok: false });
      if (result.ok === false) {
        expect(result.reason).toContain('skip');
      }
    }
  });

  it('refuses a skip entry wider than the copy has directions', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40, skip: [[1, 2]] }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('more indices than the copy has directions');
    }
  });

  it('refuses more than two linear directions', async () => {
    const code = `${copyEditBase}\ncopy('linear', ['x', 'y', 'z'], { count: 2, offset: 10 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('more than two directions');
    }
  });

  it('refuses option arities that do not match the directions', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: [3, 2], offset: 40 }, e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('do not match the directions');
    }
  });
});

describe('applyFeatureEdit (copy in-place statement edit)', () => {
  it('replaces the numeric options in place, keeping axis and targets verbatim', async () => {
    const code = `${copyEditBase}\ncopy('linear', axis(e.endEdges(2)), { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'length',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 5, value: 120 }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `${copyEditBase}\ncopy('linear', axis(e.endEdges(2)), { count: 5, length: 120 }, e)\n`,
    );
  });

  it('rewrites a linear copy into a circular one, keeping the axis and targets', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'z', { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'circular',
        axis: { kind: 'keep', sourceIndex: 0 },
        count: 6,
        sweep: { mode: 'angle', value: 360 },
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('circular', 'z', { count: 6, angle: 360 }, e)\n`);
  });

  /**
   * The Skip field owns the option outright, the way the Centered toggle does:
   * a list edits the statement's own, and an emptied field drops it.
   */
  it('rewrites and drops the skip list', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 4, offset: 40, skip: [[1]] }, e)\n`;
    const rewritten = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 40 }],
        skip: [[1], [2]],
      },
    }));
    expect(rewritten.error).toBeUndefined();
    expect(rewritten.newCode).toBe(
      `${copyEditBase}\ncopy('linear', 'x', { count: 4, offset: 40, skip: [[1], [2]] }, e)\n`,
    );

    const dropped = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 40 }],
      },
    }));
    expect(dropped.error).toBeUndefined();
    expect(dropped.newCode).toBe(
      `${copyEditBase}\ncopy('linear', 'x', { count: 4, offset: 40 }, e)\n`,
    );
  });

  it('refuses a skip entry wider than the directions it edits', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 4, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 40 }],
        skip: [[1, 2]],
      },
    }));
    expect(result.error).toBe('malformed copy edit spec: bad skip list');
  });

  it('preserves the binding and a chained suffix', async () => {
    const code = `${copyEditBase}\nconst r = copy('linear', 'x', { count: 3, offset: 40 }, e).name('row');\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 20 }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = copy('linear', 'x', { count: 4, offset: 20 }, e).name('row');`);
  });

  it('replaces the target list, mixing kept and re-picked features', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 3, value: 40 }],
        targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
      },
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('linear', 'x', { count: 3, offset: 40 }, e, c)\n`);
  });

  it('renders a re-picked selector axis from its part', async () => {
    const code = `${copyEditBase}\ncopy('circular', 'z', { count: 6, angle: 360 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'circular',
        axis: { kind: 'selector', part: 0 },
        count: 6,
        sweep: { mode: 'angle', value: 360 },
      },
    }, {
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [3], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`copy('circular', axis(e.endEdges(3)), { count: 6, angle: 360 }, e)\n`);
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      expectedStatement: `copy('linear', 'x', { count: 3, offset: 41 }, e)`,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 40 }],
      },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });

  it('refuses a kept axis the statement does not have', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'circular',
        axis: { kind: 'keep', sourceIndex: 1 },
        count: 6,
        sweep: { mode: 'angle', value: 360 },
      },
    }));
    expect(result.error).toContain('kept axis no longer matches');
    expect(result.newCode).toBe(code);
  });

  it('refuses an empty replacement target list', async () => {
    const code = `${copyEditBase}\ncopy('linear', 'x', { count: 3, offset: 40 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('copy', {
      line: 7, column: 0,
      copy: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 3, value: 40 }],
        targets: [],
      },
    }));
    expect(result.error).toContain('at least one target');
    expect(result.newCode).toBe(code);
  });
});

describe('boolean statement templates', () => {
  const base = [
    `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `cut(5)`,
  ].join('\n');

  function booleanSpec(
    bool: NonNullable<ApplyFeatureEditSpec['boolean']>,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'boolean',
      boolean: bool,
      filePath: '/ws/model.fluid.js',
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('binds two bare targets and appends a fuse at end of scope', async () => {
    const result = await applyFeatureEdit(`${base}\n`, booleanSpec({
      kind: 'fuse',
      targets: [{ producer: 0 }, { producer: 1 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { fuse, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `fuse(f, f2)`,
      ``,
    ].join('\n'));
  });

  it('renders a subtract as base and tool in argument order', async () => {
    const result = await applyFeatureEdit(`${base}\n`, booleanSpec({
      kind: 'subtract',
      targets: [{ producer: 1 }, { producer: 0 }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`subtract(f2, f)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bsubtract\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('renders a common reusing existing const target bindings', async () => {
    const code = [
      `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const c = cut(5)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, booleanSpec({
      kind: 'common',
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`common(e, c)`);
    expect(result.newCode).not.toContain('const f =');
  });

  it('refuses a subtract that does not take exactly two targets', async () => {
    const result = await applyFeatureEdit(`${base}\n`, booleanSpec({
      kind: 'subtract',
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBe('malformed boolean edit spec');
    expect(result.newCode).toBe(`${base}\n`);
  });

  it('refuses a fuse with fewer than two targets', async () => {
    const result = await applyFeatureEdit(`${base}\n`, booleanSpec({
      kind: 'fuse',
      targets: [{ producer: 0 }],
    }));
    expect(result.error).toBe('malformed boolean edit spec');
    expect(result.newCode).toBe(`${base}\n`);
  });

  it('refuses a target line that holds a sketch call', async () => {
    const result = await applyFeatureEdit(`${base}\n`, booleanSpec({
      kind: 'fuse',
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toContain('expected a feature()-producing call');
    expect(result.newCode).toBe(`${base}\n`);
  });
});

const booleanEditBase = [
  `import { sketch, ellipse, extrude, cut, fuse } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — boolean', () => {
  it('reads a fuse with identifier targets', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'boolean', kind: 'fuse', targetTexts: ['e', 'c'],
        // The bound calls' own positions — the timeline rows' locations.
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
      statement: `fuse(e, c)`,
    });
  });

  it('unpacks a single-array argument to its elements', async () => {
    const code = `${booleanEditBase}\nfuse([e, c])\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'boolean', kind: 'fuse', targetTexts: ['e', 'c'] },
    });
  });

  it('reads a subtract as its base and tool', async () => {
    const code = `${booleanEditBase}\nsubtract(e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'boolean', kind: 'subtract', targetTexts: ['e', 'c'] },
    });
  });

  it('reads an implicit common with no targets', async () => {
    const code = `${booleanEditBase}\ncommon()\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'boolean', kind: 'common', targetTexts: [] },
    });
  });

  it('refuses a subtract without exactly two arguments', async () => {
    const code = `${booleanEditBase}\nsubtract(e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('exactly a base and a tool');
    }
  });
});

describe('applyFeatureEdit (boolean in-place statement edit)', () => {
  it('rewrites a fuse into a subtract, keeping the targets verbatim', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: { kind: 'subtract' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`subtract(e, c)\n`);
    expect(result.newCode).toMatch(/import \{[^}]*\bsubtract\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('replaces the target list, mixing kept and re-picked features', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: {
        kind: 'fuse',
        targets: [{ kind: 'verbatim', sourceIndex: 1 }, { kind: 'feature', producer: 0 }],
      },
    }, {
      producers: [{ line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fuse(c, e)\n`);
  });

  it('preserves the binding and a chained suffix', async () => {
    const code = `${booleanEditBase}\nconst r = fuse(e, c).name('both');\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: { kind: 'common' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = common(e, c).name('both');`);
  });

  it('refuses a subtract edit without exactly a base and a tool', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: { kind: 'subtract', targets: [{ kind: 'verbatim', sourceIndex: 0 }] },
    }));
    expect(result.error).toContain('exactly a base and a tool');
    expect(result.newCode).toBe(code);
  });

  it('refuses a kept target the statement does not have', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: { kind: 'fuse', targets: [{ kind: 'verbatim', sourceIndex: 5 }, { kind: 'verbatim', sourceIndex: 0 }] },
    }));
    expect(result.error).toContain('kept target no longer matches');
    expect(result.newCode).toBe(code);
  });

  it('refuses an empty replacement target list', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      boolean: { kind: 'fuse', targets: [] },
    }));
    expect(result.error).toContain('at least one target');
    expect(result.newCode).toBe(code);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${booleanEditBase}\nfuse(e, c)\n`;
    const result = await applyFeatureEdit(code, editSpec('boolean', {
      line: 7, column: 0,
      expectedStatement: `fuse(e, x)`,
      boolean: { kind: 'common' },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });
});

const planeEditBase = [
  `import { sketch, ellipse, extrude, plane, helix } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `const top = plane('xy', 20)`,
  `const spring = helix('z').radius(10).turns(3)`,
].join('\n');

function planeEditOptions(
  overrides: Partial<NonNullable<FeatureStatementEditTarget['plane']>> = {},
): NonNullable<FeatureStatementEditTarget['plane']> {
  return {
    type: 'offset', offset: null, rotateX: null, rotateY: null, rotateZ: null,
    position: null, ...overrides,
  };
}

describe('parseFeatureStatement — plane', () => {
  it('reads a standard-base offset plane with its bare offset', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'plane', type: 'offset',
        bases: [{ text: `'xz'`, kind: 'plane', standard: 'xz', ref: null }],
        offset: 10, rotateX: null, rotateY: null, rotateZ: null, position: null,
      },
      statement: `plane('xz', 10)`,
    });
  });

  it('reads the transform options object', async () => {
    const code = `${planeEditBase}\nplane('xy', { offset: 10, rotateX: 15, rotateZ: -30 })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'offset',
        offset: 10, rotateX: 15, rotateY: null, rotateZ: -30,
      },
    });
  });

  it('reads a bare plane with no options', async () => {
    const code = `${planeEditBase}\nplane(top)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'offset',
        // The bound plane call's own position — the timeline row's location.
        bases: [{ text: 'top', kind: 'plane', standard: null, ref: { line: 5, column: 12 } }],
        offset: null,
      },
    });
  });

  it('reads two bases as a mid plane', async () => {
    const code = `${planeEditBase}\nplane(top, 'xz', { rotateY: 30 })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'mid',
        bases: [{ text: 'top', kind: 'plane' }, { text: `'xz'`, kind: 'plane', standard: 'xz' }],
        rotateY: 30,
      },
    });
  });

  it('reads an edge selector with a position as the edge form', async () => {
    const code = `${planeEditBase}\nplane(e.sideEdges(0), 0.25)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'edge',
        bases: [{ text: 'e.sideEdges(0)', kind: 'edge', standard: null }],
        position: 0.25, offset: null,
      },
    });
  });

  it('reads a helix variable as an edge base, named positions included', async () => {
    const code = `${planeEditBase}\nplane(spring, 'middle')\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'edge',
        bases: [{ text: 'spring', kind: 'edge', ref: { line: 6, column: 15 } }],
        position: 0.5,
      },
    });
  });

  it('reads a sketch variable as an edge base', async () => {
    const code = [
      `import { sketch, bezier, plane } from 'fluidcad/core'`,
      ``,
      `const p = sketch('xy', () => { bezier([0, 0], [38.78, 52.5], [127.59, 51.17], [128.31, 88.4]) })`,
      `plane(p, 0.5)`,
    ].join('\n');
    const result = await parseFeatureStatement(code, 4);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'edge',
        bases: [{ text: 'p', kind: 'edge', ref: { line: 3, column: 10 } }],
        position: 0.5, offset: null,
      },
    });
  });

  it('reads a face selector base as an offset plane', async () => {
    const code = `${planeEditBase}\nplane(e.endFaces(), 5)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'plane', type: 'offset',
        bases: [{ text: 'e.endFaces()', kind: 'face' }],
        offset: 5,
      },
    });
  });

  it('refuses options the dialog cannot edit', async () => {
    const code = `${planeEditBase}\nplane('xy', { offset: 10, flip: true })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('flip');
    }
  });

  it('keeps an expression option value verbatim', async () => {
    const code = `${planeEditBase}\nplane('xy', { offset: h * 2 })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'plane', type: 'offset', offset: 'h * 2' },
    });
  });

  it('refuses a mid plane carrying an offset the dialog cannot show', async () => {
    const code = `${planeEditBase}\nplane(top, 'xz', { offset: 5 })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain("mid plane's offset");
    }
  });

  it('refuses an options object the dialog cannot read back', async () => {
    const code = `${planeEditBase}\nplane('xy', { ...opts })\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('plain object literal');
    }
  });
});

describe('applyFeatureEdit (plane in-place statement edit)', () => {
  it('rewrites the offset, keeping the base verbatim', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 25 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${planeEditBase}\nplane('xz', 25)\n`);
  });

  it('adds rotation, switching the bare offset to the options object', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 10, rotateX: 15 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane('xz', { offset: 10, rotateX: 15 })`);
  });

  it('preserves the binding and a chained suffix', async () => {
    const code = `${planeEditBase}\nconst mid = plane('xz', 10).name('mid');\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 40 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const mid = plane('xz', 40).name('mid');`);
  });

  it('re-sources a base to another plane statement, binding it', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 10, bases: [{ kind: 'plane', producer: 0 }] }),
    }, {
      producers: [{ line: 5, column: 12, featureType: 'plane', nameHint: 'p', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(top, 10)`);
  });

  it('re-picks a base as a selector rendered from parts', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 10, bases: [{ kind: 'selector', part: 0 }] }),
    }, {
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [], filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(e.endFaces(), 10)`);
  });

  it('lifts a kept selector base into plane() when it becomes a mid plane', async () => {
    const code = `${planeEditBase}\nplane(e.endFaces(), 5)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({
        type: 'mid',
        bases: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'standard', plane: 'xy' }],
      }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(plane(e.endFaces()), 'xy')`);
  });

  it('rewrites an edge plane position, keeping the edge base', async () => {
    const code = `${planeEditBase}\nplane(e.sideEdges(0), 0.25)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ type: 'edge', position: 0.75 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(e.sideEdges(0), 0.75)`);
  });

  it('rewrites a named edge position numerically', async () => {
    const code = `${planeEditBase}\nplane(spring, 'middle')\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ type: 'edge', position: 1 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`plane(spring, 1)`);
  });

  it('refuses an edge plane whose kept base is not an edge source', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ type: 'edge', position: 0.5 }),
    }));
    expect(result.error).toContain('picked edge or a helix');
    expect(result.newCode).toBe(code);
  });

  it('refuses an edge plane carrying an offset', async () => {
    const code = `${planeEditBase}\nplane(e.sideEdges(0), 0.25)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ type: 'edge', position: 0.5, offset: 10 }),
    }));
    expect(result.error).toContain('no offset or rotation');
    expect(result.newCode).toBe(code);
  });

  it('refuses a base count the form does not take', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ type: 'mid', bases: [{ kind: 'standard', plane: 'xy' }] }),
    }));
    expect(result.error).toContain('exactly two bases');
    expect(result.newCode).toBe(code);
  });

  it('refuses a kept base the statement does not have', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      plane: planeEditOptions({ offset: 10, bases: [{ kind: 'verbatim', sourceIndex: 3 }] }),
    }));
    expect(result.error).toContain('kept base no longer matches');
    expect(result.newCode).toBe(code);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${planeEditBase}\nplane('xz', 10)\n`;
    const result = await applyFeatureEdit(code, editSpec('plane', {
      line: 7, column: 0,
      expectedStatement: `plane('xz', 12)`,
      plane: planeEditOptions({ offset: 25 }),
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });
});

// ---------------------------------------------------------------------------
// Expression values — variables/arithmetic in the dialogs' numeric slots,
// plus the `newVariables` declarations the expression fields commit.
// ---------------------------------------------------------------------------

import { isExpressionText, validValueExpr } from '../src/apply-feature-edit.ts';

describe('isExpressionText', () => {
  it('accepts identifiers, arithmetic and call expressions', () => {
    expect(isExpressionText('height')).toBe(true);
    expect(isExpressionText('h * 2 + 1')).toBe(true);
    expect(isExpressionText('Math.max(a, b)')).toBe(true);
    expect(isExpressionText('(a + b) / 2')).toBe(true);
  });

  it('rejects statement separators, comments and top-level commas', () => {
    expect(isExpressionText('1; drop()')).toBe(false);
    expect(isExpressionText('1, 2')).toBe(false);
    expect(isExpressionText('a // note')).toBe(false);
    expect(isExpressionText('a /* x */')).toBe(false);
    expect(isExpressionText('a = 5')).toBe(false);
    expect(isExpressionText('(a')).toBe(false);
    expect(isExpressionText('a)')).toBe(false);
    expect(isExpressionText('')).toBe(false);
  });

  it('accepts comparisons and quoted commas', () => {
    expect(isExpressionText('a >= 2 ? 3 : 4')).toBe(true);
    expect(validValueExpr('h * 2', { nonzero: true })).toBe(true);
    expect(validValueExpr(0, { nonzero: true })).toBe(false);
  });
});

describe('expression values in dialog slots', () => {
  const exprBase = [
    `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
    ``,
    `const height = 30`,
    `const s = sketch('xy', () => { ellipse(100, 50) })`,
  ].join('\n');

  it('parses a numeric-variable distance with a bound profile', async () => {
    const code = `${exprBase}\nextrude(height, s)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', distance: 'height', profileText: 's', toFaceText: null },
    });
  });

  it('parses an arithmetic distance and a variable thin offset', async () => {
    const code = `${exprBase}\nextrude(height * 2, s).thin(height / 10)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', distance: 'height * 2', thin: ['height / 10'], profileText: 's' },
    });
  });

  it('parses a chained numeric variable (const w = height * 2) as a distance', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `const height = 30`,
      `const w = height * 2`,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(w, s)`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 6);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', distance: 'w', profileText: 's' },
    });
  });

  it('still reads an unknown bare identifier as the profile, not a distance', async () => {
    const code = `${exprBase}\nextrude(s)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: false });
  });

  it('parses a variable revolve angle before a bound profile', async () => {
    const code = [
      `import { sketch, ellipse, revolve } from 'fluidcad/core'`,
      ``,
      `const ang = 180`,
      `const s = sketch('xy', () => { ellipse(100, 50) })`,
      `revolve('z', ang, s)`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', angle: 'ang', axisText: `'z'`, profileText: 's' },
    });
  });

  it('rewrites an extrude distance to an expression in place', async () => {
    const code = `${exprBase}\nextrude(25, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 'height' }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(height, s)`);
  });

  it('declares newVariables directly before the edited statement', async () => {
    const code = `${editBase}\nextrude(25)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 'depth' }),
    }, {
      newVariables: [{ name: 'depth', initializer: '25' }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const depth = 25\nextrude(depth)`);
  });

  it('declares a param() newVariable after the imports, with its import', async () => {
    const code = `${editBase}\nextrude(25)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: 'depth' }),
    }, {
      newVariables: [{ name: 'depth', initializer: 'param("depth", 25)' }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`from 'fluidcad/core'\nconst depth = param("depth", 25)\n`);
    expect(result.newCode).toContain(`extrude(depth)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bparam\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('declares a param() newVariable after a unit() statement, keeping the unit first', async () => {
    const code = [
      `import { sketch, rect, extrude, unit } from 'fluidcad/core'`,
      ``,
      `unit('in')`,
      ``,
      `sketch('xy', () => { rect(4, 2) })`,
      `extrude(1)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 6, column: 0,
      extrude: extrudeEditOptions({ distance: 'depth' }),
    }, {
      newVariables: [{ name: 'depth', initializer: 'param("depth", 1)' }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`unit('in')\nconst depth = param("depth", 1)\n`);
    expect(result.newCode).toContain(`extrude(depth)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bparam\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode.indexOf(`unit('in')`)).toBeLessThan(result.newCode.indexOf('const depth'));
  });

  it('skips declaring a newVariable the file already declares', async () => {
    const code = `${exprBase}\nextrude(25, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 5, column: 0,
      extrude: extrudeEditOptions({ distance: 'height' }),
    }, {
      newVariables: [{ name: 'height', initializer: '25' }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode.match(/const height = /g)).toHaveLength(1);
    expect(result.newCode).toContain(`extrude(height, s)`);
  });

  it('declares newVariables before a created statement', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'extrude',
      filePath: '/ws/model.fluid.js',
      extrude: {
        op: 'add', distance: 'depth', distance2: null, symmetric: false, draft: null,
        endOffset: null, drill: true, thin: null, profile: 'implicit',
      },
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
      imports: [],
      newVariables: [{ name: 'depth', initializer: '25' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const depth = 25\nextrude(depth)`);
  });

  it('splits param() newVariables to the top on a created statement', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'extrude',
      filePath: '/ws/model.fluid.js',
      extrude: {
        op: 'add', distance: 'depth', distance2: 'taper', symmetric: false, draft: null,
        endOffset: null, drill: true, thin: null, profile: 'implicit',
      },
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
      imports: [],
      newVariables: [
        { name: 'depth', initializer: 'param("depth", 25)' },
        { name: 'taper', initializer: '5' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`from 'fluidcad/core'\nconst depth = param("depth", 25)\n`);
    expect(result.newCode).toContain(`const taper = 5\nextrude(depth`);
    expect(result.newCode).toMatch(/import \{[^}]*\bparam\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('refuses a malformed newVariable declaration', async () => {
    const code = `${editBase}\nextrude(25)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({}),
    }, {
      newVariables: [{ name: 'bad name', initializer: '25' }],
    }));
    expect(result.error).toContain('new-variable');
    expect(result.newCode).toBe(code);
  });

  it('refuses an unsafe expression value', async () => {
    const code = `${editBase}\nextrude(25)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: extrudeEditOptions({ distance: '1); drop((' }),
    }));
    expect(result.error).toBeDefined();
    expect(result.newCode).toBe(code);
  });
});

describe('expression values in repeat, plane and value-feature slots', () => {
  it('parses expression counts, spacing and rotate angles', async () => {
    const code = [
      repeatEditBase,
      `const n = 4`,
      `const gap = 15`,
      `repeat('linear', 'x', { count: n, offset: gap * 2 }, e)`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 9);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'repeat', kind: 'linear',
        directions: [{ count: 'n', value: 'gap * 2' }], spacingMode: 'offset',
      },
    });
  });

  it('parses a numeric-variable rotate angle before its targets', async () => {
    const code = [
      repeatEditBase,
      `const ang = 45`,
      `repeat('rotate', 'z', ang, e)`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 8);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'repeat', kind: 'rotate', angle: 'ang', targetTexts: ['e'] },
    });
  });

  it('still reads an unknown rotate identifier as a target, not an angle', async () => {
    const code = `${repeatEditBase}\nrepeat('rotate', 'z', e)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'repeat', kind: 'rotate', angle: null, targetTexts: ['e'] },
    });
  });

  it('rewrites a repeat with expression count and sweep in place', async () => {
    const code = `${repeatEditBase}\nrepeat('circular', 'z', { count: 6, angle: 360 }, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 7, column: 0,
      repeat: {
        kind: 'circular',
        axis: { kind: 'keep', sourceIndex: 0 },
        count: 'n', sweep: { mode: 'angle', value: 'sweepAngle' },
      },
    }, {
      newVariables: [
        { name: 'n', initializer: '6' },
        { name: 'sweepAngle', initializer: '360' },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const n = 6\nconst sweepAngle = 360\nrepeat('circular', 'z', { count: n, angle: sweepAngle }, e)`);
  });

  it('parses a numeric-variable fillet radius with selector args verbatim', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `const r = 3`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(r, e.endEdges())`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 6);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'fillet', value: 'r', argsText: 'e.endEdges()' },
    });
  });

  it('still refuses a fillet whose first argument is a selector (no value)', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(e.endEdges())`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: false });
  });

  it('rewrites a fillet value to an expression in place', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `const r = 3`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(2, e.endEdges())`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('fillet', { line: 6, column: 0 }, { value: 'r' }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(r, e.endEdges())`);
  });

  it('renders a plane statement with expression offset and rotation', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `const gap = 12`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'plane',
      filePath: '/ws/model.fluid.js',
      plane: {
        type: 'offset', offset: 'gap', rotateX: 'tilt', rotateY: null, rotateZ: null,
        bases: [{ kind: 'standard', plane: 'xy' }],
      },
      producers: [],
      parts: [],
      imports: [],
      newVariables: [{ name: 'tilt', initializer: '15' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const tilt = 15\nplane('xy', { offset: gap, rotateX: tilt })`);
  });
});

describe('project into a sketch body', () => {
  const base = [
    `import { sketch, ellipse, extrude, circle, project } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xz', () => {`,
    `  circle(4)`,
    `})`,
  ].join('\n');

  function projectSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
    return {
      feature: 'project',
      project: { sketch: { line: 5, column: 0 } },
      filePath: '/ws/model.fluid.js',
      producers: [
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'endFaces', indices: null, filterArgs: '0' },
      ],
      imports: [],
      ...overrides,
    };
  }

  it('binds the source and appends the call at the end of the sketch body', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, ellipse, extrude, circle, project } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `sketch('xz', () => {`,
      `  circle(4)`,
      `  project(e.endFaces(0))`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('opens an empty sketch body at one indent level in', async () => {
    const code = [
      `import { sketch, ellipse, extrude, project } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => {`,
      ``,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, projectSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xz', () => {\n  project(e.endFaces(0))\n`);
  });

  it('hoists a producer-less select() out of the sketch body', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      producers: [
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: false },
      ],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` }],
      imports: ['select', 'face'],
    }));
    expect(result.error).toBeUndefined();
    // select() would capture the sketch's own scope from inside the callback,
    // so it is lifted to a const before the sketch and referenced by name.
    expect(result.newCode).toContain(`const sel = select(face().planar())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(sel)`);
    expect(result.newCode).not.toContain('project(select(');
    expect(result.newCode).not.toContain('const e = extrude(30)');
    expect(result.newCode).toMatch(/import \{[^}]*\bselect\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode).toMatch(/import \{[^}]*\bface\b[^}]*\} from 'fluidcad\/filters'/);
  });

  it('keeps producer accessors inline while hoisting only the select()', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      parts: [
        { producer: 0, accessor: 'endFaces', indices: null, filterArgs: '0' },
        { producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` },
      ],
      imports: ['select', 'face'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const sel = select(face().planar())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(e.endFaces(0), sel)`);
    // The bound producer still binds outside the sketch, as before.
    expect(result.newCode).toContain('const e = extrude(30)');
  });

  it('hoists multiple selects as sel, sel2 in argument order', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      producers: [
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: false },
      ],
      parts: [
        { producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` },
        { producer: null, accessor: 'select', indices: null, filterArgs: `edge().circular()` },
      ],
      imports: ['select', 'face', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `const sel = select(face().planar())\nconst sel2 = select(edge().circular())\nsketch('xz', () => {`,
    );
    expect(result.newCode).toContain(`  project(sel, sel2)`);
  });

  it('emits a user-edited argument list verbatim', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      rawArgs: `e.endFaces(0), e.sideFaces(1)`,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  project(e.endFaces(0), e.sideFaces(1))`);
  });

  it('hoists a select() from a user-edited argument list too', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      producers: [
        { line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: false },
      ],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` }],
      rawArgs: `select(face().cylindrical())`,
      imports: ['select', 'face'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const sel = select(face().cylindrical())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(sel)`);
  });

  it('picks a collision-free name when sel is already taken', async () => {
    const code = [
      `import { sketch, ellipse, extrude, circle, project } from 'fluidcad/core'`,
      ``,
      `const sel = 5`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => {`,
      `  circle(4)`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, projectSpec({
      project: { sketch: { line: 6, column: 0 } },
      producers: [
        { line: 5, column: 0, featureType: 'extrude', nameHint: 'e', bind: false },
      ],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` }],
      imports: ['select', 'face'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const sel2 = select(face().planar())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(sel2)`);
  });

  it('refuses a source built after the sketch it would project into', async () => {
    const code = [
      `import { sketch, ellipse, extrude, circle, project } from 'fluidcad/core'`,
      ``,
      `sketch('xz', () => {`,
      `  circle(4)`,
      `})`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, projectSpec({
      project: { sketch: { line: 3, column: 0 } },
      producers: [{ line: 7, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('built after this sketch');
    expect(result.newCode).toBe(code);
  });

  it('refuses a source declared in a different part() scope than the sketch', async () => {
    // The producer precedes the sketch in source order, but its variable
    // lives in another part()'s callback — binding it would write an
    // undefined identifier into the second part.
    const code = [
      `import { sketch, ellipse, extrude, circle, project, part } from 'fluidcad/core'`,
      ``,
      `export const part1 = part('Part 1', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `})`,
      `export const part2 = part('Part 2', () => {`,
      `  sketch('xz', () => {`,
      `    circle(4)`,
      `  })`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, projectSpec({
      project: { sketch: { line: 8, column: 2 } },
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('different scope');
    expect(result.newCode).toBe(code);
  });

  it('refuses when the target line is not a sketch call', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({
      project: { sketch: { line: 4, column: 0 } },
    }));
    expect(result.error).toContain('no sketch() call found at line 4');
    expect(result.newCode).toBe(`${base}\n`);
  });

  it('refuses a spec with no sketch target', async () => {
    const result = await applyFeatureEdit(`${base}\n`, projectSpec({ project: undefined }));
    expect(result.error).toBe('malformed project edit spec');
  });
});

describe('parseFeatureStatement — offset', () => {
  const base = [
    `import { sketch, ellipse, offset } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => {`,
    `  const r = ellipse(100, 50)`,
  ].join('\n');
  /** `statement` lands on line 5, inside the sketch body. */
  const codeWith = (statement: string) => `${base}\n  ${statement}\n})\n`;

  it('reads the distance and the target list', async () => {
    const result = await parseFeatureStatement(codeWith(`offset(4, r.edge('top'))`), 5);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'offset',
        value: 4,
        argsText: `r.edge('top')`,
        close: false,
      },
      statement: `offset(4, r.edge('top'))`,
    });
  });

  it('refuses the removed removeOriginal argument', async () => {
    const result = await parseFeatureStatement(codeWith(`offset(-2, true, r.edge('top'))`), 5);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no longer takes a removeOriginal flag'),
    });
  });

  it('reads the .close() chain', async () => {
    const result = await parseFeatureStatement(codeWith(`offset(3, r).close()`), 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'offset', value: 3, argsText: 'r', close: true },
      statement: 'offset(3, r).close()',
    });
  });

  it('reads a variable distance', async () => {
    const code = [
      `import { sketch, ellipse, offset } from 'fluidcad/core'`,
      `const gap = 3`,
      `sketch('xy', () => {`,
      `  const r = ellipse(100, 50)`,
      `  offset(gap, r)`,
      `})`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'offset', value: 'gap', argsText: 'r' } });
  });

  it('reads an omitted distance as the kernel default, targets and all', async () => {
    const whole = await parseFeatureStatement(codeWith('offset()'), 5);
    expect(whole).toMatchObject({
      ok: true,
      parsed: { feature: 'offset', value: 1, argsText: '', close: false },
    });

    // A non-numeric first argument is a target, not the distance.
    const targeted = await parseFeatureStatement(codeWith(`offset(r.edge('top'))`), 5);
    expect(targeted).toMatchObject({
      ok: true,
      parsed: { feature: 'offset', value: 1, argsText: `r.edge('top')` },
    });
  });

  it('refuses a .close() chain with arguments', async () => {
    const result = await parseFeatureStatement(codeWith('offset(3, r).close(true)'), 5);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('.close()');
    }
  });
});

describe('applyFeatureEdit (offset in-place statement edit)', () => {
  const base = [
    `import { sketch, ellipse, offset } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => {`,
    `  const r = ellipse(100, 50)`,
  ].join('\n');
  const codeWith = (statement: string) => `${base}\n  ${statement}\n})\n`;
  const offsetSpec = (
    offset: { close: boolean },
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ) => editSpec('offset', { line: 5, column: 2 }, { value: 4, offset, ...overrides });

  it('replaces the distance and keeps the targets verbatim', async () => {
    const result = await applyFeatureEdit(
      codeWith(`offset(2, r.edge('top'))`),
      offsetSpec({ close: false }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  offset(4, r.edge('top'))\n`);
  });

  it('adds the .close() chain', async () => {
    const closed = await applyFeatureEdit(
      codeWith(`offset(2, r.edge('top'))`),
      offsetSpec({ close: true }),
    );
    expect(closed.error).toBeUndefined();
    expect(closed.newCode).toContain(`  offset(4, r.edge('top')).close()\n`);
  });

  it('clears the close option when the dialog turns it off', async () => {
    const unclosed = await applyFeatureEdit(
      codeWith(`offset(2, r).close()`),
      offsetSpec({ close: false }),
    );
    expect(unclosed.error).toBeUndefined();
    expect(unclosed.newCode).toContain(`  offset(4, r)\n`);
    expect(unclosed.newCode).not.toContain('.close()');
  });

  it('keeps the statement options when the spec carries none', async () => {
    const result = await applyFeatureEdit(
      codeWith(`offset(2, r.edge('top')).close()`),
      editSpec('offset', { line: 5, column: 2 }, { value: 6 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  offset(6, r.edge('top')).close()\n`);
  });

  it('refuses to edit a statement still carrying the removed removeOriginal flag', async () => {
    const code = codeWith(`offset(2, true, r.edge('top'))`);
    const result = await applyFeatureEdit(code, offsetSpec({ close: false }));
    expect(result.error).toContain('no longer takes a removeOriginal flag');
    expect(result.newCode).toBe(code);
  });

  it('renders re-picked targets over the statement’s own', async () => {
    const result = await applyFeatureEdit(
      codeWith(`offset(2, r.edge('top'))`),
      offsetSpec({ close: true }, {
        producers: [{ line: 4, column: 2, featureType: 'ellipse', nameHint: 'r', bind: true }],
        parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: `'left'` }],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  offset(4, r.edge('left')).close()\n`);
  });

  it('writes the whole-sketch form when the statement has no targets', async () => {
    const result = await applyFeatureEdit(
      codeWith('offset(2)'),
      offsetSpec({ close: false }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  offset(4)\n`);
  });
});

describe('applyFeatureEdit (2D fillet in-place statement edit)', () => {
  // The 2D fillet reuses the shared value+selector tail of the edit
  // transform; the 2D-specific part is the producers living inside the
  // sketch body — the same-scope rule the offset edit exercises.
  const base = [
    `import { sketch, ellipse, fillet } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => {`,
    `  const r = ellipse(100, 50)`,
  ].join('\n');
  const codeWith = (statement: string) => `${base}\n  ${statement}\n})\n`;

  it('replaces the radius and keeps the targets verbatim', async () => {
    const result = await applyFeatureEdit(
      codeWith(`fillet(2, r.edge('top'), r.edge('left'))`),
      editSpec('fillet', { line: 5, column: 2 }, { value: 4 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(4, r.edge('top'), r.edge('left'))\n`);
  });

  it('renders re-picked targets from a producer inside the sketch body', async () => {
    const result = await applyFeatureEdit(
      codeWith(`fillet(2, r.edge('top'))`),
      editSpec('fillet', { line: 5, column: 2 }, {
        value: 4,
        producers: [{ line: 4, column: 2, featureType: 'ellipse', nameHint: 'r', bind: true }],
        parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: `'left'` }],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(4, r.edge('left'))\n`);
  });

  it('honors a user-edited raw argument list', async () => {
    const result = await applyFeatureEdit(
      codeWith(`fillet(2, r.edge('top'))`),
      editSpec('fillet', { line: 5, column: 2 }, { value: 4, rawArgs: `r.edge('bottom')` }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(4, r.edge('bottom'))\n`);
  });

  it('keeps the target-less (last selection) form', async () => {
    const result = await applyFeatureEdit(
      codeWith(`fillet(2)`),
      editSpec('fillet', { line: 5, column: 2 }, { value: 4 }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(4)\n`);
  });
});

describe('parseFeatureStatement — project', () => {
  it('reads the source arguments verbatim', async () => {
    const code = [
      `import { sketch, extrude, project } from 'fluidcad/core'`,
      ``,
      `const e = extrude(30)`,
      `sketch('xz', () => {`,
      `  project(e.sideFaces(0), select(face().planar()))`,
      `})`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: { feature: 'project', argsText: `e.sideFaces(0), select(face().planar())` },
      statement: `project(e.sideFaces(0), select(face().planar()))`,
    });
  });
});

describe('applyFeatureEdit (project in-place statement edit)', () => {
  const codeWith = (statement: string) => [
    `import { sketch, ellipse, extrude, project } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `const e = extrude(30)`,
    `sketch('xz', () => {`,
    `  ${statement}`,
    `})`,
    ``,
  ].join('\n');

  it('replaces the source list from an edited argument list', async () => {
    const result = await applyFeatureEdit(
      codeWith(`project(e.sideFaces(0))`),
      editSpec('project', { line: 6, column: 2 }, { rawArgs: 'e.sideFaces(1)' }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  project(e.sideFaces(1))\n`);
  });

  it('renders re-picked sources from a producer in the enclosing scope', async () => {
    // The producer (the extruded solid) lives OUTSIDE the sketch body the
    // edited statement sits in — the relaxed enclosing-scope rule for project.
    const result = await applyFeatureEdit(
      codeWith(`project(e.sideFaces(0))`),
      editSpec('project', { line: 6, column: 2 }, {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: '0' }],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  project(e.endFaces(0))\n`);
  });

  it('binds an unbound source statement in the enclosing scope', async () => {
    const code = [
      `import { sketch, ellipse, extrude, project } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `sketch('xz', () => {`,
      `  project('placeholder')`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('project', { line: 6, column: 2 }, {
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const e = extrude(30)`);
    expect(result.newCode).toContain(`  project(e.endFaces())\n`);
  });

  it('hoists a select() in an edited argument list out of the sketch body', async () => {
    const result = await applyFeatureEdit(
      codeWith(`project(e.sideFaces(0))`),
      editSpec('project', { line: 6, column: 2 }, { rawArgs: 'select(face().cylindrical())' }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const sel = select(face().cylindrical())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(sel)\n`);
  });

  it('hoists a producer-less select() part out of the sketch body', async () => {
    const result = await applyFeatureEdit(
      codeWith(`project(e.sideFaces(0))`),
      editSpec('project', { line: 6, column: 2 }, {
        producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: false }],
        parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: `face().planar()` }],
        imports: ['select', 'face'],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const sel = select(face().planar())\nsketch('xz', () => {`);
    expect(result.newCode).toContain(`  project(sel)\n`);
  });

  it('refuses when the statement at the line is not a project', async () => {
    const code = codeWith(`project(e.sideFaces(0))`);
    const result = await applyFeatureEdit(code, editSpec('project', { line: 4, column: 0 }, {
      rawArgs: 'e.sideFaces(1)',
    }));
    expect(result.error).toContain('extrude');
    expect(result.newCode).toBe(code);
  });
});

describe('parseOffsetTargetDescriptors (offset edit seeding)', () => {
  const codeWith = (statement: string) => [
    `import { sketch, ellipse, circle, offset, edge } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => {`,
    `  const r = ellipse(100, 50)`,
    `  const c = circle(10)`,
    `  ${statement}`,
    `})`,
    ``,
  ].join('\n');

  it('parses accessor, owner and filter targets', async () => {
    const result = await parseOffsetTargetDescriptors(
      codeWith(`offset(2, r.edge('top'), c, edge().arc(4))`), 6,
    );
    expect(result).toEqual({
      ok: true,
      descriptors: [
        { kind: 'accessor', line: 4, args: ['top'] },
        { kind: 'owner', line: 5 },
        { kind: 'filter', calls: [{ name: 'arc', dim: 4 }] },
      ],
      feature: 'offset',
    });
  });

  it('skips the removeOriginal flag slot and parses index accessors', async () => {
    const result = await parseOffsetTargetDescriptors(
      codeWith(`offset(2, true, r.edge('side', 1), r.edge(3))`), 6,
    );
    expect(result).toEqual({
      ok: true,
      descriptors: [
        { kind: 'accessor', line: 4, args: ['side', 1] },
        { kind: 'accessor', line: 4, args: [3] },
      ],
      feature: 'offset',
    });
  });

  it('resolves a whole-sketch offset to no descriptors', async () => {
    const result = await parseOffsetTargetDescriptors(codeWith(`offset(2)`), 6);
    expect(result).toEqual({ ok: true, descriptors: [], feature: 'offset' });
  });

  it('refuses target forms it cannot resolve', async () => {
    const result = await parseOffsetTargetDescriptors(
      codeWith(`offset(2, pickTargets())`), 6,
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('pickTargets') });
  });

  it('parses a 2D fillet statement’s targets, skipping the radius slot', async () => {
    const result = await parseOffsetTargetDescriptors(
      codeWith(`fillet(2, r.edge('top'), c, edge().arc(4))`), 6,
    );
    expect(result).toEqual({
      ok: true,
      descriptors: [
        { kind: 'accessor', line: 4, args: ['top'] },
        { kind: 'owner', line: 5 },
        { kind: 'filter', calls: [{ name: 'arc', dim: 4 }] },
      ],
      feature: 'fillet',
    });
  });

  it('resolves a target-less fillet to no descriptors', async () => {
    const result = await parseOffsetTargetDescriptors(codeWith(`fillet(2)`), 6);
    expect(result).toEqual({ ok: true, descriptors: [], feature: 'fillet' });
  });

  it("parses a text statement's path argument alone", async () => {
    const result = await parseOffsetTargetDescriptors(codeWith(`text("Hi", c)`), 6);
    expect(result).toEqual({
      ok: true,
      descriptors: [{ kind: 'owner', line: 5 }],
      feature: 'text',
    });
  });

  it('resolves a plain anchored text to no descriptors', async () => {
    const result = await parseOffsetTargetDescriptors(codeWith(`text("Hi").size(5)`), 6);
    expect(result).toEqual({ ok: true, descriptors: [], feature: 'text' });
  });
});

describe('rib statement templates', () => {
  function ribSpec(
    rib: Partial<NonNullable<ApplyFeatureEditSpec['rib']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'rib',
      filePath: '/ws/model.fluid.js',
      rib: {
        op: 'add', thickness: 5, parallel: false, extend: false, draft: null,
        spine: 'implicit', scope: [], ...rib,
      },
      producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  const ribBase = [
    `import { sketch, ellipse, extrude, line } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('front', () => { line([0, 0], [45, 20]) })`,
    ``,
  ].join('\n');

  it('appends an implicit-spine rib at end of scope and imports rib', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const sketchRow = lines.findIndex(l => l.startsWith(`sketch('front'`));
    expect(lines[sketchRow + 1]).toBe(`rib(5)`);
    expect(result.newCode).toMatch(/import \{.*\brib\b.*\} from 'fluidcad\/core'/);
  });

  it('chains .parallel(), .extend(), .draft() and .new() in canonical order', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec({
      op: 'new', parallel: true, extend: true, draft: -3,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5).parallel().extend().draft(-3).new()`);
  });

  it('renders the remove op as a .remove() chain', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec({ op: 'remove', thickness: 4 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(4).remove()`);
  });

  it('binds a bound-spine sketch and inserts directly after it', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec(
      { spine: 'bound' },
      { producers: [{ line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true }] },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const boundRow = lines.findIndex(l => l === `const s = sketch('front', () => { line([0, 0], [45, 20]) })`);
    expect(boundRow).toBeGreaterThan(-1);
    expect(lines[boundRow + 1]).toBe(`rib(5, s)`);
  });

  it('binds scope solids and renders the .scope() chain', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec(
      { spine: 'bound', scope: [1] },
      {
        producers: [
          { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
          { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        ],
      },
    ));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    expect(lines).toContain(`const f = extrude(30)`);
    const boundRow = lines.findIndex(l => l === `const s = sketch('front', () => { line([0, 0], [45, 20]) })`);
    // Inserted after the LATEST referenced statement (the spine here).
    expect(lines[boundRow + 1]).toBe(`rib(5, s).scope(f)`);
  });

  it('refuses a scope index that is not a feature producer', async () => {
    const result = await applyFeatureEdit(ribBase, ribSpec({ scope: [0] }));
    expect(result.error).toContain('malformed rib edit spec');
    expect(result.newCode).toBe(ribBase);
  });
});

describe('parseFeatureStatement — rib', () => {
  const ribEditBase = [
    `import { sketch, ellipse, extrude, rib, line } from 'fluidcad/core'`,
    ``,
    `const body = extrude(30)`,
    `const s = sketch('front', () => { line([0, 0], [45, 20]) })`,
  ].join('\n');

  it('reads a plain rib', async () => {
    const code = `${ribEditBase}\nrib(6)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'rib', op: 'add', thickness: 6, parallel: false, extend: false,
        draft: null, spineText: null, scopeTexts: [], scopeRefs: [],
      },
      statement: 'rib(6)',
    });
  });

  it('reads a fully chained rib with a bound spine and scope refs', async () => {
    const code = `${ribEditBase}\nrib(-5, s).parallel().extend().draft(2).new().scope(body)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: {
        feature: 'rib', op: 'new', thickness: -5, parallel: true, extend: true,
        draft: 2, spineText: 's', scopeTexts: ['body'],
      },
      statement: 'rib(-5, s).parallel().extend().draft(2).new().scope(body)',
    });
    if (result.ok === true && result.parsed.feature === 'rib') {
      expect(result.parsed.scopeRefs).toHaveLength(1);
      expect(result.parsed.scopeRefs[0]?.line).toBe(3);
    }
  });

  it('reads a remove rib', async () => {
    const code = `${ribEditBase}\nrib(4).remove()\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: true, parsed: { feature: 'rib', op: 'remove', thickness: 4 } });
  });

  it('refuses a non-numeric thickness', async () => {
    const code = `${ribEditBase}\nrib(t)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('thickness');
    }
  });

  it('refuses a three-argument rib', async () => {
    const code = `${ribEditBase}\nrib(5, s, extra)\n`;
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('applyFeatureEdit (rib in-place statement edit)', () => {
  const ribEditBase = [
    `import { sketch, ellipse, extrude, rib, line } from 'fluidcad/core'`,
    ``,
    `const body = extrude(30)`,
    `const tower = extrude(50).new()`,
    `const s = sketch('front', () => { line([0, 0], [45, 20]) })`,
  ].join('\n');

  function ribEditOptions(
    overrides: Partial<NonNullable<FeatureStatementEditTarget['rib']>> = {},
  ): NonNullable<FeatureStatementEditTarget['rib']> {
    return {
      op: 'add', thickness: 5, parallel: false, extend: false, draft: null, ...overrides,
    };
  }

  it('replaces the thickness in place', async () => {
    const code = `${ribEditBase}\nrib(5, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({ thickness: 8 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`${ribEditBase}\nrib(8, s)\n`);
  });

  it('adds and drops chains in place', async () => {
    const code = `${ribEditBase}\nrib(5, s).parallel()\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({ extend: true, draft: 2, op: 'new' }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5, s).extend().draft(2).new()\n`);
  });

  it('keeps the scope chain verbatim when the edit omits it', async () => {
    const code = `${ribEditBase}\nrib(5, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({ thickness: 7 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(7, s).scope(body)\n`);
  });

  it('drops the scope chain on an empty replacement list', async () => {
    const code = `${ribEditBase}\nrib(5, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({ scope: [] }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5, s)\n`);
    expect(result.newCode).not.toContain(`.scope(`);
  });

  it('mixes kept and re-picked scope targets', async () => {
    const code = `${ribEditBase}\nrib(5, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({
        scope: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', producer: 0 },
        ],
      }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5, s).scope(body, tower)\n`);
  });

  it('re-sources the spine to a picked sketch', async () => {
    const code = `${ribEditBase}\nconst s2 = sketch('front', () => { line([0, 0], [30, 10]) })\nrib(5, s)\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 7, column: 0,
      rib: ribEditOptions({ spine: { kind: 'sketch', producer: 0 } }),
    }, {
      producers: [{ line: 6, column: 0, featureType: 'sketch', nameHint: 's', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5, s2)\n`);
  });

  it('re-picks a scope solid held by an assignment statement, reusing its variable', async () => {
    const code = [
      `import { sketch, ellipse, extrude, shell, fillet, rib, line } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const box = extrude(30)`,
      `let s`,
      `s = shell(-4, box.endFaces())`,
      `s = fillet(2, s.internalEdges())`,
      `sketch('front', () => { line([0, 0], [-45, 20]) })`,
      `rib(5).scope(s)`,
      '',
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 9, column: 0,
      rib: ribEditOptions({ scope: [{ kind: 'feature', producer: 0 }] }),
    }, {
      producers: [{ line: 7, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(5).scope(s)\n`);
    expect(result.newCode).toContain(`\ns = fillet(2, s.internalEdges())\n`);
    expect(result.newCode).not.toContain(`const f = `);
  });

  it('preserves an unrecognized suffix chain', async () => {
    const code = `${ribEditBase}\nrib(5, s).color('red')\n`;
    const result = await applyFeatureEdit(code, editSpec('rib', {
      line: 6, column: 0,
      rib: ribEditOptions({ thickness: 9 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rib(9, s).color('red')\n`);
  });
});

describe('.scope() chains — extrude, sweep, loft, revolve', () => {
  // A solid to scope to (line 3) ahead of the inputs each feature consumes.
  const scopedCreateBase = [
    `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
    ``,
    `const base = extrude(30)`,
    `sketch('xy', () => { ellipse(100, 50) })`,
    ``,
  ].join('\n');

  function scopedExtrudeSpec(
    extrude: Partial<NonNullable<ApplyFeatureEditSpec['extrude']>> = {},
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'extrude',
      filePath: '/ws/model.fluid.js',
      extrude: {
        op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, endOffset: null,
        drill: true, thin: null, profile: 'implicit', scope: [1], ...extrude,
      },
      producers: [
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        { line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('extrude reuses a bound scope solid and chains .scope() last', async () => {
    const result = await applyFeatureEdit(scopedCreateBase, scopedExtrudeSpec({ thin: [2] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(25).thin(2).scope(base)`);
  });

  it('extrude renders a scoped cut', async () => {
    const result = await applyFeatureEdit(scopedCreateBase, scopedExtrudeSpec({ op: 'remove', distance: 7 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`cut(7).scope(base)`);
  });

  it('extrude binds an unbound scope solid to a variable', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `extrude(30)`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, scopedExtrudeSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = extrude(30)`);
    expect(result.newCode).toContain(`extrude(25).scope(f)`);
  });

  it('extrude refuses a scope index pointing at an identity-typed producer', async () => {
    const result = await applyFeatureEdit(scopedCreateBase, scopedExtrudeSpec({ scope: [0] }));
    expect(result.error).toContain('malformed extrude edit spec');
    expect(result.newCode).toBe(scopedCreateBase);
  });

  it('sweep chains .scope() after the op chains', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `const base = extrude(30)`,
      `sketch('xz', () => { circle(5) })`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'sweep',
      filePath: '/ws/model.fluid.js',
      sweep: {
        op: 'remove', thin: null, profile: 'implicit',
        path: { kind: 'sketch', producer: 0 },
        scope: [2],
      },
      producers: [
        { line: 4, column: 0, featureType: 'sketch', nameHint: 'p', bind: true },
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        { line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(p).remove().scope(base)`);
  });

  it('loft chains .scope() after the op chains', async () => {
    const code = [
      `import { sketch, ellipse, circle, extrude } from 'fluidcad/core'`,
      ``,
      `const base = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `sketch('xz', () => { circle(5) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'loft',
      filePath: '/ws/model.fluid.js',
      loft: {
        op: 'add', thin: null,
        profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'sketch', producer: 1 }],
        scope: [2],
      },
      producers: [
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 5, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
        { line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s, s2).scope(base)`);
  });

  it('revolve chains .scope() on a standard axis', async () => {
    const code = [
      `import { sketch, circle, extrude } from 'fluidcad/core'`,
      ``,
      `const base = extrude(30)`,
      `sketch('xz', () => { circle([80, 0], 40) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      feature: 'revolve',
      filePath: '/ws/model.fluid.js',
      revolve: {
        op: 'add', angle: 360, symmetric: false, thin: null, profile: 'implicit',
        axis: { kind: 'standard', axis: 'z' },
        scope: [1],
      },
      producers: [
        { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
        { line: 3, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
      parts: [],
      imports: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`revolve('z').scope(base)`);
  });
});

describe('parseFeatureStatement — .scope() chains', () => {
  const scopeParseBase = [
    `import { sketch, ellipse, extrude, cut, sweep, loft, revolve, circle } from 'fluidcad/core'`,
    ``,
    `const body = extrude(30)`,
    `const tower = extrude(50).new()`,
    `const s = sketch('front', () => { circle(20) })`,
  ].join('\n');

  it('reads an extrude scope chain with refs', async () => {
    const code = `${scopeParseBase}\ncut(10).scope(body, tower)\n`;
    const result = await parseFeatureStatement(code, 6);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'extrude', op: 'remove', distance: 10, scopeTexts: ['body', 'tower'] },
    });
    if (result.ok === true && result.parsed.feature === 'extrude') {
      expect(result.parsed.scopeRefs.map(r => r?.line)).toEqual([3, 4]);
    }
  });

  it('reads a sweep scope chain', async () => {
    const code = `${scopeParseBase}\nconst p = sketch('xz', () => { circle(5) })\nsweep(p, s).thin(2).scope(body)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'sweep', op: 'add', thin: [2], pathText: 'p', scopeTexts: ['body'] },
    });
  });

  it('reads a loft scope chain', async () => {
    const code = `${scopeParseBase}\nconst s2 = sketch('back', () => { circle(10) })\nloft(s, s2).remove().scope(body)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'loft', op: 'remove', profileTexts: ['s', 's2'], scopeTexts: ['body'] },
    });
  });

  it('reads a revolve scope chain', async () => {
    const code = `${scopeParseBase}\nrevolve('z', 90, s).scope(body)\n`;
    const result = await parseFeatureStatement(code, 6);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'revolve', op: 'add', angle: 90, axisText: `'z'`, scopeTexts: ['body'] },
    });
  });
});

describe('applyFeatureEdit (.scope() in-place statement edits)', () => {
  const scopeEditBase = [
    `import { sketch, ellipse, extrude, cut, sweep, loft, revolve, circle } from 'fluidcad/core'`,
    ``,
    `const body = extrude(30)`,
    `const tower = extrude(50).new()`,
    `const s = sketch('front', () => { circle(20) })`,
  ].join('\n');

  it('extrude mixes kept and re-picked scope targets', async () => {
    const code = `${scopeEditBase}\nextrude(25, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 6, column: 0,
      extrude: extrudeEditOptions({
        scope: [
          { kind: 'verbatim', sourceIndex: 0 },
          { kind: 'feature', producer: 0 },
        ],
      }),
    }, {
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(25, s).scope(body, tower)\n`);
  });

  it('extrude keeps the scope chain verbatim when the edit omits it', async () => {
    const code = `${scopeEditBase}\nextrude(25, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 6, column: 0,
      extrude: extrudeEditOptions({ distance: 40 }),
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(40, s).scope(body)\n`);
  });

  it('revolve drops the scope chain on an empty replacement list', async () => {
    const code = `${scopeEditBase}\nrevolve('z', 90, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('revolve', {
      line: 6, column: 0,
      revolve: { op: 'add', angle: 90, symmetric: false, thin: null, scope: [] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`revolve('z', 90, s)\n`);
    expect(result.newCode).not.toContain(`.scope(`);
  });

  it('sweep keeps the scope chain across an option edit', async () => {
    const code = `${scopeEditBase}\nconst p = sketch('xz', () => { circle(5) })\nsweep(p, s).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('sweep', {
      line: 7, column: 0,
      sweep: { op: 'add', thin: [2] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(p, s).thin(2).scope(body)\n`);
  });

  it('loft rewrites the op ahead of a kept scope chain', async () => {
    const code = `${scopeEditBase}\nconst s2 = sketch('back', () => { circle(10) })\nloft(s, s2).scope(body)\n`;
    const result = await applyFeatureEdit(code, editSpec('loft', {
      line: 7, column: 0,
      loft: { op: 'remove', thin: null },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`loft(s, s2).remove().scope(body)\n`);
  });
});

describe('mirror statement templates', () => {
  const base = [
    `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `cut(5)`,
  ].join('\n');

  function mirrorSpec(
    mirror: NonNullable<ApplyFeatureEditSpec['mirror']>,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'mirror',
      mirror,
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('binds two bare targets and appends a mirror across a standard plane', async () => {
    const result = await applyFeatureEdit(`${base}\n`, mirrorSpec({
      plane: { kind: 'standard', plane: 'yz' },
      op: 'add',
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { mirror, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `mirror('yz', f, f2)`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const target binding', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, mirrorSpec({
      plane: { kind: 'standard', plane: 'yz' },
      op: 'add',
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('yz', e)`);
    expect(result.newCode).not.toContain('const f =');
  });

  it('renders the remove and new operation chains', async () => {
    const removed = await applyFeatureEdit(`${base}\n`, mirrorSpec({
      plane: { kind: 'standard', plane: 'xy' },
      op: 'remove',
      targets: [{ producer: 0 }],
    }));
    expect(removed.error).toBeUndefined();
    expect(removed.newCode).toContain(`mirror('xy', f).remove()`);

    const kept = await applyFeatureEdit(`${base}\n`, mirrorSpec({
      plane: { kind: 'standard', plane: 'xy' },
      op: 'new',
      targets: [{ producer: 0 }],
    }));
    expect(kept.error).toBeUndefined();
    expect(kept.newCode).toContain(`mirror('xy', f).new()`);
  });

  it('renders an existing plane feature as its bound variable', async () => {
    const code = [
      `import { sketch, ellipse, extrude, plane } from 'fluidcad/core'`,
      ``,
      `const p = plane('yz', 40)`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, mirrorSpec({
      plane: { kind: 'plane', producer: 1 },
      op: 'add',
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 3, column: 10, featureType: 'plane', nameHint: 'p', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror(p, e)`);
  });

  it('renders a mirror across a picked face lifted into plane(<selector>)', async () => {
    const result = await applyFeatureEdit(`${base}\n`, mirrorSpec({
      plane: { kind: 'selector', part: 0 },
      op: 'add',
      targets: [{ producer: 0 }],
    }, {
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      imports: ['plane'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror(plane(f.endFaces(0)), f)`);
    expect(result.newCode).toMatch(/import \{[^}]*\bmirror\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode).toMatch(/import \{[^}]*\bplane\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('refuses a duplicate target producer', async () => {
    const result = await applyFeatureEdit(`${base}\n`, mirrorSpec({
      plane: { kind: 'standard', plane: 'yz' },
      op: 'add',
      targets: [{ producer: 0 }, { producer: 0 }],
    }));
    expect(result.error).toContain('malformed mirror edit spec');
  });
});

const mirrorEditBase = [
  `import { sketch, ellipse, extrude, cut, mirror } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — mirror', () => {
  it('reads the plane and identifier targets with their refs', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'mirror', op: 'add', planeText: `'yz'`, targetTexts: ['e', 'c'],
        // The bound calls' own positions — the timeline rows' locations.
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
      statement: `mirror('yz', e, c)`,
    });
  });

  it('reads the operation chains as the op', async () => {
    const removed = await parseFeatureStatement(`${mirrorEditBase}\nmirror('yz', e).remove()\n`, 7);
    expect(removed).toMatchObject({ ok: true, parsed: { feature: 'mirror', op: 'remove' } });
    const kept = await parseFeatureStatement(`${mirrorEditBase}\nmirror('yz', e).new()\n`, 7);
    expect(kept).toMatchObject({ ok: true, parsed: { feature: 'mirror', op: 'new' } });
  });

  it('reads an implicit mirror with no targets', async () => {
    const result = await parseFeatureStatement(`${mirrorEditBase}\nmirror('xy')\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'mirror', op: 'add', planeText: `'xy'`, targetTexts: [] },
    });
  });

  it('keeps an unrecognized chain suffix out of the editable range', async () => {
    const result = await parseFeatureStatement(`${mirrorEditBase}\nmirror('yz', e).name('half')\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'mirror', op: 'add' },
      statement: `mirror('yz', e)`,
    });
  });

  it('refuses a mirror with no arguments', async () => {
    const result = await parseFeatureStatement(`${mirrorEditBase}\nmirror()\n`, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('fewer arguments');
    }
  });

  it('refuses a statement chaining two operations', async () => {
    const result = await parseFeatureStatement(`${mirrorEditBase}\nmirror('yz', e).remove().new()\n`, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('more than one operation');
    }
  });
});

describe('applyFeatureEdit (mirror in-place statement edit)', () => {
  it('switches the op keeping the plane and targets verbatim', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'keep' }, op: 'new' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('yz', e).new()\n`);
  });

  it('drops the operation chain switching back to add', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e).remove()\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'keep' }, op: 'add' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('yz', e)\n`);
    expect(result.newCode).not.toContain('.remove()');
  });

  it('replaces the target list, mixing kept and re-picked features', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: {
        plane: { kind: 'keep' },
        op: 'add',
        targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
      },
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('yz', e, c)\n`);
  });

  it('re-sources the plane with a standard origin plane', async () => {
    const code = `${mirrorEditBase}\nmirror(plane(e.endFaces(0)), e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'standard', plane: 'xz' }, op: 'add' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('xz', e)\n`);
  });

  it('renders a re-picked selector plane from its part', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'selector', part: 0 }, op: 'add' },
    }, {
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [1], filterArgs: null }],
      imports: ['plane'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror(plane(e.endFaces(1)), e)\n`);
    expect(result.newCode).toMatch(/import \{[^}]*\bplane\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('keeps an implicit-target mirror implicit when no target list rides the spec', async () => {
    const code = `${mirrorEditBase}\nmirror('xy')\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'standard', plane: 'yz' }, op: 'add' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('yz')\n`);
  });

  it('refuses an empty replacement target list', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'keep' }, op: 'add', targets: [] },
    }));
    expect(result.error).toContain('at least one target');
    expect(result.newCode).toBe(code);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e)\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      expectedStatement: `mirror('yz', c)`,
      mirror: { plane: { kind: 'keep' }, op: 'add' },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });

  it('preserves an unrecognized chain suffix through an edit', async () => {
    const code = `${mirrorEditBase}\nmirror('yz', e).name('half')\n`;
    const result = await applyFeatureEdit(code, editSpec('mirror', {
      line: 7, column: 0,
      mirror: { plane: { kind: 'standard', plane: 'xy' }, op: 'add' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror('xy', e).name('half')\n`);
  });
});

describe('rotate statement templates', () => {
  const base = [
    `import { sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
    ``,
    `sketch('xy', () => { ellipse(100, 50) })`,
    `extrude(30)`,
    `sketch('xy', () => { ellipse(10, 10) })`,
    `cut(5)`,
  ].join('\n');

  function rotateSpec(
    rotate: NonNullable<ApplyFeatureEditSpec['rotate']>,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec {
    return {
      feature: 'rotate',
      rotate,
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
      ...overrides,
    };
  }

  it('binds two bare targets and appends a rotate around a standard axis', async () => {
    const result = await applyFeatureEdit(`${base}\n`, rotateSpec({
      axis: { kind: 'standard', axis: 'z' },
      angle: 45,
      copy: false,
      targets: [{ producer: 0 }, { producer: 1 }],
    }, {
      producers: [
        { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 6, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { rotate, sketch, ellipse, extrude, cut } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const f = extrude(30)`,
      `sketch('xy', () => { ellipse(10, 10) })`,
      `const f2 = cut(5)`,
      `rotate('z', 45, f, f2)`,
      ``,
    ].join('\n'));
  });

  it('renders the copy flag and reuses an existing const binding', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, rotateSpec({
      axis: { kind: 'standard', axis: 'x' },
      angle: 30,
      copy: true,
      targets: [{ producer: 0 }],
    }, {
      producers: [{ line: 4, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('x', 30, true, e)`);
    expect(result.newCode).not.toContain('const f =');
  });

  it('renders an existing axis feature as its bound variable', async () => {
    const code = [
      `import { sketch, ellipse, extrude, axis } from 'fluidcad/core'`,
      ``,
      `const a = axis([0, 0, 0], [0, 0, 1])`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, rotateSpec({
      axis: { kind: 'axis', producer: 1 },
      angle: 45,
      copy: false,
      targets: [{ producer: 0 }],
    }, {
      producers: [
        { line: 5, column: 10, featureType: 'feature', nameHint: 'f', bind: true },
        { line: 3, column: 10, featureType: 'axis', nameHint: 'a', bind: true },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate(a, 45, e)`);
  });

  it('renders a rotate around a picked edge lifted into axis(<selector>)', async () => {
    const result = await applyFeatureEdit(`${base}\n`, rotateSpec({
      axis: { kind: 'selector', part: 0 },
      angle: 90,
      copy: false,
      targets: [{ producer: 0 }],
    }, {
      parts: [{ producer: 0, accessor: 'endEdges', indices: [0], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate(axis(f.endEdges(0)), 90, f)`);
    expect(result.newCode).toMatch(/import \{[^}]*\brotate\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('refuses a duplicate target producer and a zero angle', async () => {
    const duplicate = await applyFeatureEdit(`${base}\n`, rotateSpec({
      axis: { kind: 'standard', axis: 'z' },
      angle: 45,
      copy: false,
      targets: [{ producer: 0 }, { producer: 0 }],
    }));
    expect(duplicate.error).toContain('malformed rotate edit spec');

    const zero = await applyFeatureEdit(`${base}\n`, rotateSpec({
      axis: { kind: 'standard', axis: 'z' },
      angle: 0,
      copy: false,
      targets: [{ producer: 0 }],
    }));
    expect(zero.error).toContain('malformed rotate edit spec');
  });
});

const rotateEditBase = [
  `import { sketch, ellipse, extrude, cut, rotate } from 'fluidcad/core'`,
  ``,
  `sketch('xy', () => { ellipse(100, 50) })`,
  `const e = extrude(30)`,
  `sketch('xy', () => { ellipse(10, 10) })`,
  `const c = cut(5)`,
].join('\n');

describe('parseFeatureStatement — rotate', () => {
  it('reads the axis, angle and identifier targets with their refs', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e, c)\n`;
    const result = await parseFeatureStatement(code, 7);
    expect(result).toEqual({
      ok: true,
      parsed: {
        feature: 'rotate', axisText: `'z'`, angle: 45, copy: false, targetTexts: ['e', 'c'],
        // The bound calls' own positions — the timeline rows' locations.
        targetRefs: [{ line: 4, column: 10 }, { line: 6, column: 10 }],
      },
      statement: `rotate('z', 45, e, c)`,
    });
  });

  it('reads the copy flag off the boolean third argument', async () => {
    const result = await parseFeatureStatement(`${rotateEditBase}\nrotate('z', 45, true, e)\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'rotate', copy: true, targetTexts: ['e'] },
    });
  });

  it('reads an implicit rotate with no targets', async () => {
    const result = await parseFeatureStatement(`${rotateEditBase}\nrotate('x', 30)\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'rotate', axisText: `'x'`, angle: 30, copy: false, targetTexts: [] },
    });
  });

  it('reads a variable angle as its expression text', async () => {
    const code = [
      `import { sketch, ellipse, extrude, rotate } from 'fluidcad/core'`,
      `const ang = 30`,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `rotate('z', ang, e)`,
      ``,
    ].join('\n');
    const result = await parseFeatureStatement(code, 5);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'rotate', angle: 'ang', targetTexts: ['e'] },
    });
  });

  it('keeps an unrecognized chain suffix out of the editable range', async () => {
    const result = await parseFeatureStatement(`${rotateEditBase}\nrotate('z', 45, e).name('turned')\n`, 7);
    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'rotate', axisText: `'z'` },
      statement: `rotate('z', 45, e)`,
    });
  });

  it('refuses a rotate with no arguments', async () => {
    const result = await parseFeatureStatement(`${rotateEditBase}\nrotate()\n`, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('fewer arguments');
    }
  });

  it('refuses the in-sketch angle-first form', async () => {
    const result = await parseFeatureStatement(`${rotateEditBase}\nrotate(45, e)\n`, 7);
    expect(result).toMatchObject({ ok: false });
    if (result.ok === false) {
      expect(result.reason).toContain('in-sketch rotate');
    }
  });
});

describe('applyFeatureEdit (rotate in-place statement edit)', () => {
  it('rewrites the angle and copy flag keeping the axis and targets verbatim', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'keep' }, angle: 90, copy: true },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('z', 90, true, e)\n`);
  });

  it('drops the copy flag switching back to move', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, true, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'keep' }, angle: 45, copy: false },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('z', 45, e)\n`);
    expect(result.newCode).not.toContain('true');
  });

  it('replaces the target list, mixing kept and re-picked features', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: {
        axis: { kind: 'keep' },
        angle: 45,
        copy: false,
        targets: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'feature', producer: 0 }],
      },
    }, {
      producers: [{ line: 6, column: 10, featureType: 'feature', nameHint: 'f', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('z', 45, e, c)\n`);
  });

  it('re-sources the axis with a standard world axis', async () => {
    const code = `${rotateEditBase}\nrotate(axis(e.endEdges(0)), 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'standard', axis: 'x' }, angle: 45, copy: false },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('x', 45, e)\n`);
  });

  it('renders a re-picked selector axis from its part', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'selector', part: 0 }, angle: 45, copy: false },
    }, {
      producers: [{ line: 4, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endEdges', indices: [1], filterArgs: null }],
      imports: ['axis'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate(axis(e.endEdges(1)), 45, e)\n`);
    expect(result.newCode).toMatch(/import \{[^}]*\baxis\b[^}]*\} from 'fluidcad\/core'/);
  });

  it('keeps an implicit-target rotate implicit when no target list rides the spec', async () => {
    const code = `${rotateEditBase}\nrotate('x', 30)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'standard', axis: 'y' }, angle: 60, copy: false },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('y', 60)\n`);
  });

  it('refuses an empty replacement target list', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'keep' }, angle: 45, copy: false, targets: [] },
    }));
    expect(result.error).toContain('at least one target');
    expect(result.newCode).toBe(code);
  });

  it('refuses a stale expectedStatement', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e)\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      expectedStatement: `rotate('z', 45, c)`,
      rotate: { axis: { kind: 'keep' }, angle: 90, copy: false },
    }));
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(code);
  });

  it('preserves an unrecognized chain suffix through an edit', async () => {
    const code = `${rotateEditBase}\nrotate('z', 45, e).name('turned')\n`;
    const result = await applyFeatureEdit(code, editSpec('rotate', {
      line: 7, column: 0,
      rotate: { axis: { kind: 'keep' }, angle: 60, copy: false },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`rotate('z', 60, e).name('turned')\n`);
  });
});

describe('new part statement', () => {
  const newPartSpec = (name?: string) => spec({
    feature: 'sketch', value: undefined, producers: [], parts: [],
    newPart: name !== undefined ? { name } : {},
  });

  it('appends an exported part() after the last statement and allocates Part 1', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, newPartSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      `export const part1 = part('Part 1', () => {`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('allocates the first free Part N past existing part names', async () => {
    const code = [
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `part('Part 1', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `})`,
      `part('Part 3', () => {})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, newPartSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`part('Part 3', () => {})\nexport const part2 = part('Part 2', () => {`);
  });

  it('uses the provided name verbatim and derives the export identifier', async () => {
    const result = await applyFeatureEdit('', newPartSpec('Box Body'));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { part } from 'fluidcad/core';`,
      `export const boxBody = part('Box Body', () => {`,
      ``,
      `});`,
      ``,
    ].join('\n'));
  });

  it('suffixes the export identifier past a taken word', async () => {
    const code = [
      `import { part, sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `const bracket = 5`,
      `part('Other', () => { sketch('xy', () => { ellipse(bracket, 4) }) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, newPartSpec('Bracket'));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`export const bracket2 = part('Bracket', () => {`);
  });

  it('refuses a name that cannot sit in a single-quoted literal', async () => {
    const result = await applyFeatureEdit('', newPartSpec("it's"));
    expect(result.error).toContain('part names');
    expect(result.newCode).toBe('');
  });

  it('lands before an active breakpoint', async () => {
    const code = [
      `import { sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `extrude(30)`,
      `breakpoint()`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, newPartSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`export const part1 = part('Part 1', () => {\n\n})\nbreakpoint()`);
  });
});

describe('active part insertion', () => {
  const partSketchSpec = (line: number) => spec({
    feature: 'sketch', value: undefined, producers: [], parts: [],
    sketchPlane: 'xy', activePart: { line, column: 0 },
  });

  it('lands the pick-less sketch at the end of the part body', async () => {
    const code = [
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, partSketchSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `  sketch('xy', () => {`,
      ``,
      `  })`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('opens a single-line empty part body across lines', async () => {
    const code = [
      `import { part, sketch } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, partSketchSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { part, sketch } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {`,
      `  sketch('xy', () => {`,
      ``,
      `  })`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('fills the exported multi-line empty body the Part tool just wrote', async () => {
    const code = [
      `import { part, sketch } from 'fluidcad/core'`,
      ``,
      `export const part1 = part('Part 1', () => {`,
      ``,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, partSketchSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { part, sketch } from 'fluidcad/core'`,
      ``,
      `export const part1 = part('Part 1', () => {`,
      `  sketch('xy', () => {`,
      ``,
      `  })`,
      ``,
      `})`,
      ``,
    ].join('\n'));
  });

  it('lands before a breakpoint inside the part body', async () => {
    const code = [
      `import { part, sketch, ellipse, extrude, breakpoint } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `  breakpoint()`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, partSketchSpec(3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  extrude(30)`,
      `  sketch('xy', () => {`,
      ``,
      `  })`,
      `  breakpoint()`,
    ].join('\n'));
  });

  it('lands a standard-base plane inside the part body', async () => {
    const code = [
      `import { part, sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `part('Body', () => {`,
      `  sketch('xy', () => { ellipse(100, 50) })`,
      `  extrude(30)`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, spec({
      feature: 'plane',
      value: undefined,
      producers: [],
      parts: [],
      plane: {
        type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'standard', plane: 'xy' }],
      },
      activePart: { line: 3, column: 0 },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  extrude(30)\n  plane('xy', 10)\n})`);
    expect(result.newCode).toContain(`import { plane,`);
  });

  it('refuses when the active-part line does not hold a part() call', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, partSketchSpec(4));
    expect(result.error).toContain('no part() call found at line 4');
    expect(result.newCode).toBe(code);
  });
});
