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

  it('binds a fillet2d producer for a second fillet over its edges', async () => {
    const code = [
      `import { sketch, rect, fillet, aLine, move } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const r = rect(80, 60)`,
      `  fillet(4, r.edge('top'), r.edge('right'))`,
      `  move([0, 60])`,
      `  aLine(135, 30)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      value: 3,
      producers: [
        { line: 5, column: 0, featureType: 'fillet2d', nameHint: 'f', bind: true },
        { line: 7, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
        { producer: 1, accessor: '', indices: null, filterArgs: null },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = fillet(4, r.edge('top'), r.edge('right'))`);
    expect(result.newCode).toContain(`fillet(3, f.edge('top'), l)`);
  });

  it('binds a trim2d producer for an op over its split segments', async () => {
    const code = [
      `import { sketch, rect, circle, trim, edge, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const r = rect(80, 60)`,
      `  circle(20)`,
      `  trim(edge().circle(40))`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, sketchSpec({
      value: 2,
      producers: [
        { line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true },
        { line: 6, column: 0, featureType: 'trim2d', nameHint: 'f', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
        { producer: 1, accessor: 'edge', indices: null, filterArgs: '0' },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const f = trim(edge().circle(40))`);
    expect(result.newCode).toContain(`fillet(2, r.edge('top'), f.edge(0))`);
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

  it("writes the offset toggles as the boolean argument and the .close() chain", async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  rect(80, 60)`,
      `})`,
      ``,
    ].join('\n');
    const spec = (offset: { removeOriginal: boolean; close: boolean }) => sketchSpec({
      feature: 'offset',
      value: 3,
      offset,
      producers: [{ line: 4, column: 0, featureType: 'rect', nameHint: 'r', bind: true }],
      parts: [{ producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" }],
    });

    const removed = await applyFeatureEdit(code, spec({ removeOriginal: true, close: false }));
    expect(removed.error).toBeUndefined();
    expect(removed.newCode).toContain(`  offset(3, true, r.edge('top'))`);

    const closed = await applyFeatureEdit(code, spec({ removeOriginal: false, close: true }));
    expect(closed.error).toBeUndefined();
    expect(closed.newCode).toContain(`  offset(3, r.edge('top')).close()`);
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

describe('applyFeatureEdit — sketch-body tArc to target (2D)', () => {
  const tarcSpec = (overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec => sketchSpec({
    feature: 'tarc',
    value: 12,
    producers: [{ line: 5, column: 0, featureType: 'line', nameHint: 'l', bind: true }],
    parts: [{ producer: 0, accessor: '', indices: null, filterArgs: null }],
    ...overrides,
  });

  it('binds the target statement and appends the tArc at the chain end', async () => {
    const code = [
      `import { sketch, hLine, move, line } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  move([0, 40])`,
      `  hLine(60)`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, tarcSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import {tArc, sketch, hLine, move, line } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  move([0, 40])`,
      `  const l = hLine(60)`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `  tArc(12, l)`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('keeps a negative signed radius', async () => {
    const code = [
      `import { sketch, hLine, line } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      ``,
      `  hLine(60)`,
      `  line([120, 0])`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, tarcSpec({ value: -12 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l = hLine(60)`);
    expect(result.newCode).toContain(`  tArc(-12, l)`);
  });

  it('refuses a zero radius as malformed', async () => {
    const result = await applyFeatureEdit(`sketch('xy', () => {})\n`, tarcSpec({ value: 0 }));
    expect(result.error).toBe('malformed tArc edit spec');
  });
});

describe('applyFeatureEdit — tArc retarget (end-drag edge snap)', () => {
  const retargetSpec = (
    line: number,
    sign: 1 | -1,
    overrides: Partial<ApplyFeatureEditSpec> = {},
  ): ApplyFeatureEditSpec => sketchSpec({
    feature: 'tarc',
    value: undefined,
    producers: [{ line: 4, column: 0, featureType: 'line', nameHint: 'l', bind: true }],
    parts: [{ producer: 0, accessor: '', indices: null, filterArgs: null }],
    tarc: { retarget: { line, sign } },
    ...overrides,
  });

  it('rewrites the endpoint arg to the bound target variable in place', async () => {
    const code = [
      `import { sketch, hLine, move, line, tArc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  hLine(60)`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `  tArc(12, [80, 30])`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, retargetSpec(7, 1));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { sketch, hLine, move, line, tArc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const l = hLine(60)`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `  tArc(12, l)`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('negates an expression radius for a clockwise solve, reusing an existing binding', async () => {
    const code = [
      `import { sketch, line, move, tArc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  const g = line([100, 50]).guide()`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `  tArc(r, [80, -30])`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, retargetSpec(7, -1));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const g = line([100, 50]).guide()`);
    expect(result.newCode).toContain(`  tArc(-r, g)`);
  });

  it('refuses a target declared after the arc (temporal dead zone)', async () => {
    const code = [
      `import { sketch, hLine, move, line, tArc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  move([50, 0])`,
      `  line([120, 0])`,
      `  tArc(12, [80, 30])`,
      `  hLine(60)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, retargetSpec(6, 1, {
      producers: [{ line: 7, column: 0, featureType: 'line', nameHint: 'l', bind: true }],
    }));
    expect(result.error).toContain('declared after this arc');
    expect(result.newCode).toBe(code);
  });

  it('refuses a target from a different sketch', async () => {
    const code = [
      `import { sketch, hLine, move, tArc } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  hLine(60)`,
      `})`,
      `sketch('xz', () => {`,
      `  move([50, 0])`,
      `  tArc(12, [80, 30])`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, retargetSpec(8, 1));
    expect(result.error).toContain('different sketch');
    expect(result.newCode).toBe(code);
  });
});
