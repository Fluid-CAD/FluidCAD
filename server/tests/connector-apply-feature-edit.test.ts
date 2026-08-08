import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  type ApplyFeatureEditSpec,
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

    const result = await applyFeatureEdit(code, connectorSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('mountTop', e.endFaces(0))`));
    const returnRow = lines.findIndex(l => l.trim() === 'return { thickness: 30 }');
    expect(connectorRow).toBeGreaterThan(-1);
    expect(connectorRow).toBeLessThan(returnRow);
    expect(lines[connectorRow].startsWith('    ')).toBe(true);
    expect(result.newCode).toContain(`import {connector, sketch, rect, extrude, part } from 'fluidcad/core'`);
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

    const result = await applyFeatureEdit(code, connectorSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const connectorRow = lines.findIndex(l => l.includes(`connector('mountTop', e.endFaces(0))`));
    expect(connectorRow).toBeGreaterThan(-1);
    expect(lines[connectorRow - 1].includes('const e = extrude(30)')).toBe(true);
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
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function xPlate() {`,
      `  return part('X Plate', () => {`,
      `    const holes = () => {`,
      `      sketch('xy', () => { rect(10, 10) })`,
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
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
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

  it('renders the anchor suffix on the source expression', async () => {
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      connector: { name: 'mountTop', part: { line: 4, column: 9 }, anchor: { kind: 'center' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`connector('mountTop', e.endFaces(0).center())`);
  });

  it('renders the rotate/offset chain after the call', async () => {
    const result = await applyFeatureEdit(PART_CODE, connectorSpec({
      connector: {
        name: 'mountTop',
        part: { line: 4, column: 9 },
        anchor: { kind: 'offset', mode: 'relative', value: 0.3 },
        rotate: { axis: 'z', angle: 90 },
        offset: [0, 0, 5],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `connector('mountTop', e.endFaces(0).offset('relative', 0.3)).rotate('z', 90).offset(0, 0, 5)`,
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
