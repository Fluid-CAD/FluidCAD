import { describe, it, expect } from 'vitest';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

// Stage 3 (plans/sketch-edge-selection): the 2D branch of the pick → code
// pipeline reuses the 3D ApplyFeatureEditSpec — producers are statements
// inside a sketch body, and the transform's shared-scope rule keeps the
// emitted statement in that same body.
function sketchSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 4,
    filePath: '/ws/model.fluid.js',
    producers: [
      { line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
      { line: 6, column: 0, featureType: 'line', nameHint: 'l', bind: true },
    ],
    parts: [
      { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
      { producer: 1, accessor: '', indices: null, filterArgs: null },
    ],
    imports: [],
    ...overrides,
  };
}

describe('applyFeatureEdit — sketch-body fillet (2D)', () => {
  it('binds sketch statements and appends the fillet inside the body', async () => {
    const code = [
      `import { sketch, rect, aLine, move, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `  move([0, 60])`,
      `  aLine(135, 30)`,
      `})`,
      `extrude(10)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import {fillet, sketch, rect, aLine, move, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const r = rect(80, 60)`,
      `  move([0, 60])`,
      `  const l = aLine(135, 30)`,
      `  fillet(4, r.edge('top'), l)`,
      `})`,
      `extrude(10)`,
      ``,
    ].join('\n'));
  });

  it('reuses an existing const binding in the sketch body', async () => {
    const code = [
      `import { sketch, rect, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const base = rect(80, 60)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const base = rect(80, 60)`);
    expect(result.newCode).toContain(`fillet(4, base.edge('top'))`);
  });

  it('renders bare filter parts and imports edge', async () => {
    const code = [
      `import { sketch, hLine, move } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  hLine(30)`,
      `  move([0, 20])`,
      `  hLine(40)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      value: 3,
      producers: [{ line: 4, column: 0, featureType: 'line', nameHint: 'l', bind: false }],
      parts: [{ producer: null, accessor: 'filter', indices: null, filterArgs: 'edge().line(30)' }],
      imports: ['edge'],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(3, edge().line(30))`);
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
    // No variable was bound: the statements stay bare.
    expect(result.newCode).toContain(`  hLine(30)`);
    expect(result.newCode).not.toContain(`const`);
  });

  it('inserts before a trailing return in the sketch body', async () => {
    const code = [
      `import { sketch, rect, slot, extrude } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => {`,
      `  rect(80, 60)`,
      `  const inner = slot(20, 5)`,
      `  return { inner }`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import {fillet, sketch, rect, slot, extrude } from 'fluidcad/core'`,
      ``,
      `const s = sketch('xy', () => {`,
      `  const r = rect(80, 60)`,
      `  const inner = slot(20, 5)`,
      `  fillet(4, r.edge('top'))`,
      `  return { inner }`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('honors a user-edited raw argument list', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
      rawArgs: "r.edge('top'), r.edge('left')",
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(4, r.edge('top'), r.edge('left'))`);
  });

  it('writes an offset statement into the sketch body', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      feature: 'offset',
      value: 3,
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = rect(80, 60)`);
    expect(result.newCode).toContain(`  offset(3, r.edge('top'))`);
    expect(result.newCode).toContain(`import {offset, sketch, rect } from 'fluidcad/core'`);
  });

  it('writes a valueless boolean statement into the sketch body', async () => {
    const code = [
      `import { sketch, rect, circle, move } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `  move([60, 30])`,
      `  circle(40)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      feature: 'subtract',
      value: undefined,
      producers: [
        { line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
        { line: 6, column: 0, featureType: 'circle', nameHint: 'c', bind: true },
      ],
      parts: [
        { producer: 0, accessor: '', indices: null, filterArgs: null },
        { producer: 1, accessor: '', indices: null, filterArgs: null },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = rect(80, 60)`);
    expect(result.newCode).toContain(`const c = circle(40)`);
    expect(result.newCode).toContain(`  subtract(r, c)`);
    expect(result.newCode).toContain(`import {subtract, sketch, rect, circle, move } from 'fluidcad/core'`);
  });

  it('writes a valueless trim statement into the sketch body', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      feature: 'trim',
      value: undefined,
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = rect(80, 60)`);
    expect(result.newCode).toContain(`  trim(r.edge('top'))`);
    expect(result.newCode).toContain(`import {trim, sketch, rect } from 'fluidcad/core'`);
  });

  it('refuses a stale line pointing at a different callee', async () => {
    const code = [
      `import { sketch, rect, circle } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  circle(40)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    }));
    expect(result.error).toContain('expected a rect()-producing call');
    expect(result.newCode).toBe(code);
  });
});
