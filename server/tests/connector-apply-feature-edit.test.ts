import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type FeatureStatementEditTarget,
} from '../src/apply-feature-edit.ts';

function connectorSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'connector',
    filePath: '/ws/x-plate.part.js',
    connector: { name: 'mountTop', part: { line: 4, column: 9 } },
    producers: [{ line: 6, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
    imports: [],
    ...overrides,
  };
}

describe('applyFeatureEdit — connector', () => {
  it('inserts before the trailing return of the part callback body', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { circle([0, 0], 100) })`,
      `    const e = extrude(30)`,
      `    return { thickness: 30 }`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('mountTop', e.endFaces(0))`));
    const returnRow = lines.findIndex(l => l.trim() === 'return { thickness: 30 }');
    expect(connectorRow).toBeGreaterThan(-1);
    expect(connectorRow).toBeLessThan(returnRow);
    expect(lines[connectorRow].startsWith('    ')).toBe(true);
    expect(result.newCode).toContain(`import {connector, sketch, circle, extrude, part } from 'fluidcad/core'`);
  });

  it('appends at the end of a part body with no return', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { circle([0, 0], 100) })`,
      `    const e = extrude(30)`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('mountTop', e.endFaces(0))`));
    expect(connectorRow).toBeGreaterThan(-1);
    expect(lines[connectorRow - 1].includes('const e = extrude(30)')).toBe(true);
  });

  it('renders a global select() part with its imports', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    sketch('xy', () => { circle([0, 0], 100) })`,
      `    extrude(30)`,
      `    return {}`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec({
      connector: { name: 'hole', part: { line: 4, column: 9 } },
      producers: [{ line: 6, column: 4, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: 'edge().circle(5)' }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('hole', select(edge().circle(5)))`));
    const returnRow = lines.findIndex(l => l.trim() === 'return {}');
    expect(connectorRow).toBeGreaterThan(-1);
    expect(connectorRow).toBeLessThan(returnRow);
    expect(result.newCode).toContain(`select`);
    expect(result.newCode).toContain(`from 'fluidcad/filters'`);
    // The bare extrude is anchor-only — it must NOT get a const binding.
    expect(result.newCode).toContain(`\n    extrude(30)`);
    expect(result.newCode).not.toContain('const e = extrude');
  });

  it('lands inside the executed if/else branch, before that branch\'s return', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function getExtrusion(size = '80x160') {`,
      `  return part('extrusion', () => {`,
      `    if (size === '80x80') {`,
      `      sketch('xy', () => { circle([0, 0], 10) })`,
      `      extrude(10)`,
      `      return {}`,
      `    } else {`,
      `      sketch('xy', () => { circle([0, 0], 20) })`,
      `      const e = extrude(30)`,
      `      return {}`,
      `    }`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec({
      producers: [{ line: 11, column: 6, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('mountTop', e.endFaces(0))`));
    expect(connectorRow).toBeGreaterThan(-1);
    // Inside the else branch: directly after `const e = extrude(30)`, before
    // that branch's own return — not after the whole if/else (dead code).
    expect(lines[connectorRow - 1].includes('const e = extrude(30)')).toBe(true);
    expect(lines[connectorRow + 1].trim()).toBe('return {}');
    expect(lines[connectorRow].startsWith('      ')).toBe(true);
  });

  it('falls back to the part body when the anchor sits in a nested helper', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    const holes = () => {`,
      `      sketch('xy', () => { circle([0, 0], 10) })`,
      `      extrude(10)`,
      `    }`,
      `    holes()`,
      `    return {}`,
      `  })`,
      `}`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec({
      connector: { name: 'hole', part: { line: 4, column: 9 } },
      producers: [{ line: 7, column: 6, featureType: 'extrude', nameHint: 'e', bind: false }],
      parts: [{ producer: null, accessor: 'select', indices: null, filterArgs: 'edge().circle(5)' }],
      imports: ['select', 'edge'],
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('hole', select(edge().circle(5)))`));
    expect(connectorRow).toBeGreaterThan(-1);
    // Part-body indent (4 spaces), after holes(), before the body's return —
    // NOT inside the helper's own body.
    expect(lines[connectorRow].startsWith('    connector')).toBe(true);
    expect(lines[connectorRow - 1].trim()).toBe('holes()');
    expect(lines[connectorRow + 1].trim()).toBe('return {}');
  });

  it('refuses when the spec line does not hold a part() call', async () => {
    const code = [
      `import { sketch, circle, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 100) })`,
      `const e = extrude(30)`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec({
      connector: { name: 'mountTop', part: { line: 3, column: 0 } },
      producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    }));
    expect(result.error).toContain('no part() call found');
    expect(result.newCode).toBe(code);
  });

  it('refuses a bound producer declared outside the part body', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { circle([0, 0], 100) })`,
      `const e = extrude(30)`,
      `part('housing', () => {`,
      `  sketch('xy', () => { circle([0, 0], 10) })`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, connectorSpec({
      connector: { name: 'mountTop', part: { line: 5, column: 0 } },
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
      connectorSpec({ connector: undefined }),
      connectorSpec({ connector: { name: 'not an id', part: { line: 2, column: 0 } } }),
      connectorSpec({ connector: { name: '', part: { line: 2, column: 0 } } }),
      connectorSpec({ parts: [] }),
      connectorSpec({ producers: [] }),
    ]) {
      const result = await applyFeatureEdit(code, bad);
      expect(result.error).toBe('malformed connector edit spec');
      expect(result.newCode).toBe(code);
    }
  });

  const PART_CODE = [
    `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
    ``,
    `export function xPlate() {`,
    `  return part('X Plate', () => {`,
    `    sketch('xy', () => { circle([0, 0], 100) })`,
    `    const e = extrude(30)`,
    `    return { thickness: 30 }`,
    `  })`,
    `}`,
    ``,
  ].join('\n');

  it('renders the anchor suffix on the source expression', async () => {
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      connector: { name: 'mountTop', part: { line: 4, column: 9 }, anchor: { kind: 'center' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0).center())`);
  });

  it('renders the offset/rotate chain after the call, offset first', async () => {
    // Offset first so the rotation pivots where the offset put the frame —
    // rotating first would swing the connector around the anchor instead.
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      connector: {
        name: 'mountTop',
        part: { line: 4, column: 9 },
        anchor: { kind: 'offset', mode: 'relative', value: 0.3 },
        rotate: { axis: 'z', angle: 90 },
        offset: [0, 50, 0],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `connector('mountTop', e.endFaces(0).offset('relative', 0.3)).offset(0, 50).rotate('z', 90)`,
    );
  });

  it('renders rotations around the x and y axes', async () => {
    for (const axis of ['x', 'y'] as const) {
      const result = await applyFeatureEdit(PART_CODE, connectorSpec({
        connector: { name: 'mountTop', part: { line: 4, column: 9 }, rotate: { axis, angle: 180 } },
      }));
      expect(result.error).toBeUndefined();
      expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0)).rotate('${axis}', 180)`);
    }
  });

  it('trims trailing zero offsets and skips full-turn rotations', async () => {
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      connector: { name: 'mountTop', part: { line: 4, column: 9 }, rotate: { axis: 'x', angle: 360 }, offset: [5, 0, 0] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0)).offset(5)`);
    expect(result.newCode).not.toContain(`.rotate(`);
  });

  it('does not re-append the anchor to a raw selector override', async () => {
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      rawArgs: `e.endFaces().center()`,
      connector: { name: 'mountTop', part: { line: 4, column: 9 }, anchor: { kind: 'center' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces().center())`);
    expect(result.newCode).not.toContain(`.center().center()`);
  });

  it('refuses malformed anchors and adjustments', async () => {
    const code = [
      `import { part } from 'fluidcad/core'`,
      `part('housing', () => {})`,
      ``,
    ].join('\n');

    for (const bad of [
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, anchor: { kind: 'middle' } as any } }),
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, anchor: { kind: 'offset', mode: 'sideways', value: 1 } as any } }),
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, anchor: { kind: 'offset', mode: 'relative', value: Number.NaN } as any } }),
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, rotate: { axis: 'z', angle: Number.POSITIVE_INFINITY } } }),
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, rotate: { axis: 'w', angle: 90 } as any } }),
      connectorSpec({ connector: { name: 'c', part: { line: 2, column: 0 }, offset: [1, 2] as any } }),
    ]) {
      const result = await applyFeatureEdit(code, bad);
      expect(result.error).toBe('malformed connector edit spec');
      expect(result.newCode).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// In-place edits (timeline double-click → the dialog re-opened over the
// statement). The source expression is kept verbatim unless a re-pick
// replaced it; name and both adjustments are always explicit, so a cleared
// field drops its chain.
// ---------------------------------------------------------------------------

/** A part whose connector statement sits at line 7. */
const EDIT_CODE = [
  `import { sketch, circle, extrude, part, connector } from 'fluidcad/core'`,
  ``,
  `export function xPlate() {`,
  `  return part('X Plate', () => {`,
  `    sketch('xy', () => { circle([0, 0], 100) })`,
  `    const e = extrude(30)`,
  `    connector('mountTop', e.endFaces(0).center()).offset(0, 0, 5).rotate('z', 90)`,
  `    return { thickness: 30 }`,
  `  })`,
  `}`,
  ``,
].join('\n');

const CONNECTOR_LINE = 7;

function connectorEditSpec(
  connector: NonNullable<FeatureStatementEditTarget['connector']>,
  overrides: Partial<ApplyFeatureEditSpec> = {},
): ApplyFeatureEditSpec {
  return {
    feature: 'connector',
    filePath: '/ws/x-plate.part.js',
    producers: [],
    parts: [],
    imports: [],
    edit: { line: CONNECTOR_LINE, column: 4, connector },
    ...overrides,
  };
}

describe('parseFeatureStatement — connector', () => {
  it('reads the name, the source expression and both adjustments', async () => {
    const result = await parseFeatureStatement(EDIT_CODE, CONNECTOR_LINE);
    expect(result.ok).toBe(true);
    if (result.ok === false) {
      return;
    }
    expect(result.parsed).toEqual({
      feature: 'connector',
      name: 'mountTop',
      // The anchor suffix belongs to the source expression, not the chain.
      argsText: 'e.endFaces(0).center()',
      rotate: { axis: 'z', angle: 90 },
      offset: [0, 0, 5],
    });
    expect(result.statement).toBe(
      `connector('mountTop', e.endFaces(0).center()).offset(0, 0, 5).rotate('z', 90)`,
    );
  });

  it('reads a bare connector as no adjustments, and fills a short offset with zeros', async () => {
    const bare = EDIT_CODE.replace(
      `connector('mountTop', e.endFaces(0).center()).offset(0, 0, 5).rotate('z', 90)`,
      `connector('mountTop', e.endFaces(0))`,
    );
    const result = await parseFeatureStatement(bare, CONNECTOR_LINE);
    expect(result.ok === true && result.parsed).toMatchObject({
      feature: 'connector', name: 'mountTop', argsText: 'e.endFaces(0)', rotate: null, offset: null,
    });

    const short = EDIT_CODE.replace(`.offset(0, 0, 5).rotate('z', 90)`, `.offset(4)`);
    const shortResult = await parseFeatureStatement(short, CONNECTOR_LINE);
    // `offset(x, y = 0, z = 0)` — the omitted components read as 0.
    expect(shortResult.ok === true && shortResult.parsed).toMatchObject({ offset: [4, 0, 0], rotate: null });
  });

  it('reads a negative offset and an unrecognized trailing chain', async () => {
    const code = EDIT_CODE.replace(
      `.offset(0, 0, 5).rotate('z', 90)`,
      `.offset(-2.5, 0, 0).name('top')`,
    );
    const result = await parseFeatureStatement(code, CONNECTOR_LINE);
    expect(result.ok === true && result.parsed).toMatchObject({ offset: [-2.5, 0, 0] });
    // The statement span stops at the last recognized member — `.name('top')`
    // survives an edit untouched.
    expect(result.ok === true && result.statement).toBe(
      `connector('mountTop', e.endFaces(0).center()).offset(-2.5, 0, 0)`,
    );
  });

  it('refuses statements the dialog cannot represent', async () => {
    const cases: [string, string][] = [
      // A rotate-first chain only folds into the dialog's offset-first order
      // when the turn is a right angle — 45° would leave trig decimals.
      [`.rotate('z', 45).offset(5, 0, 0)`, 'rotates before it offsets'],
      [`.rotate('z', turn)`, 'not a plain'],
      [`.offset(gap, 0, 0)`, 'not plain numbers'],
      [`.rotate('z')`, 'not a plain'],
    ];
    for (const [chain, reason] of cases) {
      const code = EDIT_CODE.replace(`.offset(0, 0, 5).rotate('z', 90)`, chain);
      const result = await parseFeatureStatement(code, CONNECTOR_LINE);
      expect(result.ok, chain).toBe(false);
      expect(result.ok === false && result.reason, chain).toContain(reason);
    }
  });

  it('folds a legacy rotate-first chain into offset-first components', async () => {
    // An earlier dialog wrote `.rotate().offset()`, whose offset walks the
    // ROTATED axes. Folding turns those components into the offset-first
    // order the dialog now holds — the identical built frame, so opening the
    // dialog never moves the connector.
    const cases: [string, [number, number, number]][] = [
      [`.rotate('z', 90).offset(5, 0, 0)`, [0, 5, 0]],
      [`.rotate('z', 180).offset(0, 50, 0)`, [0, -50, 0]],
      [`.rotate('x', 270).offset(1, 2, 3)`, [1, 3, -2]],
      [`.rotate('y', -90).offset(1, 2, 3)`, [-3, 2, 1]],
      // An offset along the rotation axis is left alone by the fold.
      [`.rotate('z', 90).offset(0, 0, 5)`, [0, 0, 5]],
    ];
    for (const [chain, offset] of cases) {
      const code = EDIT_CODE.replace(`.offset(0, 0, 5).rotate('z', 90)`, chain);
      const result = await parseFeatureStatement(code, CONNECTOR_LINE);
      expect(result.ok, chain).toBe(true);
      expect(result.ok === true && result.parsed, chain).toMatchObject({ offset });
    }
  });

  it('re-applies a folded legacy statement without moving the connector', async () => {
    const legacy = EDIT_CODE.replace(
      `.offset(0, 0, 5).rotate('z', 90)`,
      `.rotate('z', 180).offset(0, 50, 0)`,
    );
    const parsed = await parseFeatureStatement(legacy, CONNECTOR_LINE);
    expect(parsed.ok === true && parsed.parsed).toMatchObject({
      rotate: { axis: 'z', angle: 180 }, offset: [0, -50, 0],
    });
    // The dialog seeds from the folded values; an untouched apply re-emits
    // them offset-first — a normalized statement that builds the same frame.
    const result = await applyFeatureEdit(legacy, connectorEditSpec({
      name: 'mountTop', rotate: { axis: 'z', angle: 180 }, offset: [0, -50, 0],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `connector('mountTop', e.endFaces(0).center()).offset(0, -50).rotate('z', 180)`,
    );
  });

  it('refuses a computed name and a wrong argument count', async () => {
    for (const call of [
      `connector(label, e.endFaces(0))`,
      `connector('mountTop')`,
      `connector('mountTop', e.endFaces(0), 'extra')`,
    ]) {
      const code = EDIT_CODE.replace(
        `connector('mountTop', e.endFaces(0).center()).offset(0, 0, 5).rotate('z', 90)`,
        call,
      );
      const result = await parseFeatureStatement(code, CONNECTOR_LINE);
      expect(result.ok, call).toBe(false);
    }
  });
});

describe('applyFeatureEdit — connector edit', () => {
  it('renames while keeping the source expression and both chains', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec({
      name: 'mountLeft', rotate: { axis: 'z', angle: 90 }, offset: [0, 0, 5],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `connector('mountLeft', e.endFaces(0).center()).offset(0, 0, 5).rotate('z', 90)`,
    );
    // Nothing else moved: the part body and its return are untouched.
    expect(result.newCode).toContain(`    const e = extrude(30)`);
    expect(result.newCode).toContain(`    return { thickness: 30 }`);
  });

  it('drops a cleared rotation and offset instead of keeping the statement\'s', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec({
      name: 'mountTop', rotate: null, offset: null,
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0).center())\n`);
    expect(result.newCode).not.toContain('.rotate(');
    expect(result.newCode).not.toContain('.offset(');
  });

  it('rewrites the adjustments, trimming trailing zeros and full turns', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec({
      name: 'mountTop', rotate: { axis: 'x', angle: 360 }, offset: [3, 0, 0],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0).center()).offset(3)`);
    expect(result.newCode).not.toContain('.rotate(');
  });

  it('appends the anchor to a re-picked source', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec(
      { name: 'mountTop', rotate: null, offset: null, anchor: { kind: 'center' } },
      {
        producers: [{ line: 6, column: 4, featureType: 'extrude', nameHint: 'e', bind: true }],
        // Selector parts render the bare accessor — the suffix is the
        // transform's to add, exactly as on the create path.
        parts: [{ producer: 0, accessor: 'sideFaces', indices: [2], filterArgs: null }],
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.sideFaces(2).center())`);
    expect(result.newCode).not.toContain('e.endFaces(0)');
  });

  it('does not re-append the anchor to an edited expression row', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec(
      { name: 'mountTop', rotate: null, offset: null, anchor: { kind: 'start' } },
      {
        producers: [{ line: 6, column: 4, featureType: 'extrude', nameHint: 'e', bind: true }],
        parts: [{ producer: 0, accessor: 'sideEdges', indices: [1], filterArgs: null }],
        // The row's text is the whole source expression, anchor included.
        rawArgs: 'e.sideEdges(1).start()',
      },
    ));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.sideEdges(1).start())`);
    expect(result.newCode).not.toContain('.start().start()');
  });

  it('keeps the statement\'s own anchor when only the fields change', async () => {
    // No parts, no raw args: the source text stands, suffix included — an
    // anchor riding the payload must not double it up.
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec({
      name: 'mountTop', rotate: null, offset: [1, 0, 0], anchor: { kind: 'center' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0).center()).offset(1)`);
    expect(result.newCode).not.toContain('.center().center()');
  });

  it('refuses a source bound after the edited statement', async () => {
    // A connector cannot attach to geometry built after it — the rewritten
    // statement still executes where it already sits.
    const code = EDIT_CODE.replace(
      `    return { thickness: 30 }`,
      `    const f = extrude(5)\n    return { thickness: 30 }`,
    );
    const result = await applyFeatureEdit(code, connectorEditSpec(
      { name: 'mountTop', rotate: null, offset: null },
      {
        producers: [{ line: 8, column: 4, featureType: 'extrude', nameHint: 'f', bind: true }],
        parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      },
    ));
    expect(result.error).toContain('does not precede the edited statement');
    expect(result.newCode).toBe(code);
  });

  it('refuses when the statement drifted since the dialog opened', async () => {
    const spec = connectorEditSpec({ name: 'mountTop', rotate: null, offset: null });
    spec.edit!.expectedStatement = `connector('mountTop', e.endFaces(0).center())`;
    const result = await applyFeatureEdit(EDIT_CODE, spec);
    expect(result.error).toContain('changed since the dialog opened');
    expect(result.newCode).toBe(EDIT_CODE);
  });

  it('refuses when the line holds a different feature', async () => {
    const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec(
      { name: 'mountTop', rotate: null, offset: null },
      { edit: { line: 6, column: 4, connector: { name: 'mountTop', rotate: null, offset: null } } },
    ));
    expect(result.error).toContain('is a extrude, expected a connector');
    expect(result.newCode).toBe(EDIT_CODE);
  });

  it('refuses a malformed edit payload', async () => {
    for (const bad of [
      undefined,
      { name: 'not an id', rotate: null, offset: null },
      { name: 'c', rotate: { axis: 'w', angle: 90 }, offset: null },
      { name: 'c', rotate: { axis: 'z', angle: Number.NaN }, offset: null },
      { name: 'c', rotate: null, offset: [1, 2] },
    ] as any[]) {
      const result = await applyFeatureEdit(EDIT_CODE, connectorEditSpec(bad));
      expect(result.error).toBe('malformed connector edit spec');
      expect(result.newCode).toBe(EDIT_CODE);
    }
  });
});
