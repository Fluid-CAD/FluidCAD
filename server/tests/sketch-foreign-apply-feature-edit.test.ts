import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  resolvePartBindingIdent,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit.ts';

/** Donor bound at line 3, consumer at line 9; the exposure already exists. */
const TWO_PART_CODE = [
  `import { sketch, circle, extrude, part, expose } from 'fluidcad/core'`,
  ``,
  `export const p1 = part('Donor', () => {`,
  `  sketch('xy', () => { circle([0, 0], 100) })`,
  `  const e = extrude(30)`,
  `  expose('endFace', e.endFaces(0))`,
  `})`,
  ``,
  `export const p2 = part('Consumer', () => {`,
  `  sketch('xy', () => { circle([0, 0], 10) })`,
  `  extrude(5)`,
  `})`,
  ``,
].join('\n');

function foreignSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'sketch',
    filePath: '/ws/model.fluid.js',
    producers: [],
    parts: [],
    imports: [],
    activePart: { line: 9, column: 18 },
    sketchForeign: { exposeName: 'endFace', donor: { line: 3, column: 18 } },
    ...overrides,
  };
}

describe('applyFeatureEdit — foreign sketch (same file)', () => {
  it('lands sketch(p1.features.<name>, …) inside the ACTIVE part body', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, foreignSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const sketchRow = lines.findIndex(l => l.includes(`sketch(p1.features.endFace, () => {`));
    const consumerRow = lines.findIndex(l => l.includes(`part('Consumer'`));
    expect(sketchRow).toBeGreaterThan(consumerRow);
    // Directly after the consumer's own extrude — inside its body, not the donor's.
    expect(lines[sketchRow - 1].trim()).toBe('extrude(5)');
    expect(lines[sketchRow].startsWith('  ')).toBe(true);
  });

  it('creates the exposure first and relocates the shifted consumer part', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export const p1 = part('Donor', () => {`,
      `  sketch('xy', () => { circle([0, 0], 100) })`,
      `  const e = extrude(30)`,
      `})`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  sketch('xy', () => { circle([0, 0], 10) })`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');
    const create: ApplyFeatureEditSpec = {
      feature: 'expose',
      filePath: '/ws/model.fluid.js',
      expose: { name: 'g1', part: { line: 3, column: 18 } },
      producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      imports: [],
    };

    const result = await applyFeatureEdit(code, foreignSpec({
      activePart: { line: 8, column: 18 },
      sketchForeign: { exposeName: 'g1', donor: { line: 3, column: 18 }, create },
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('g1', e.endFaces(0))`));
    const consumerRow = lines.findIndex(l => l.includes(`part('Consumer'`));
    const sketchRow = lines.findIndex(l => l.includes(`sketch(p1.features.g1, () => {`));
    // The exposure lands in the donor (above), the sketch in the consumer —
    // whose part() call shifted down one line during the exposure edit.
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(consumerRow);
    expect(sketchRow).toBeGreaterThan(consumerRow);
    expect(lines[sketchRow - 1].trim()).toBe('extrude(5)');
    // Both statements' imports are present.
    expect(lines[0]).toContain('expose');
    expect(lines[0]).toContain('sketch');
  });

  it('refuses a donor part that is not bound to a const', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export function makeDonor() {`,
      `  return part('Donor', () => {`,
      `    sketch('xy', () => { circle([0, 0], 100) })`,
      `    const e = extrude(30)`,
      `  })`,
      `}`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, foreignSpec({
      activePart: { line: 10, column: 18 },
      sketchForeign: { exposeName: 'g1', donor: { line: 4, column: 9 } },
    }));
    expect(result.error).toContain('not bound to a const');
    expect(result.newCode).toBe(code);
  });

  it('refuses a donor bound inside a nested scope', async () => {
    const code = [
      `import { part, extrude, sketch, circle } from 'fluidcad/core'`,
      ``,
      `function setup() {`,
      `  const p1 = part('Donor', () => {})`,
      `}`,
      `setup()`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, foreignSpec({
      activePart: { line: 8, column: 18 },
      sketchForeign: { exposeName: 'g1', donor: { line: 4, column: 13 } },
    }));
    expect(result.error).toContain('nested scope');
    expect(result.newCode).toBe(code);
  });

  it('refuses malformed specs', async () => {
    for (const bad of [
      // No addressing mode at all.
      foreignSpec({ sketchForeign: { exposeName: 'g1' } }),
      // Both addressing modes.
      foreignSpec({ sketchForeign: { exposeName: 'g1', donor: { line: 3, column: 0 }, ident: 'p1' } }),
      // Bad name.
      foreignSpec({ sketchForeign: { exposeName: 'not an id', donor: { line: 3, column: 0 } } }),
      // No active part.
      foreignSpec({ activePart: undefined }),
      // A cross-file spec cannot carry a create stage.
      foreignSpec({ sketchForeign: { exposeName: 'g1', ident: 'p1', importFrom: './d.fluid.js', create: foreignSpec() } }),
      // importFrom is cross-file-only.
      foreignSpec({ sketchForeign: { exposeName: 'g1', donor: { line: 3, column: 0 }, importFrom: './d.fluid.js' } }),
    ]) {
      const result = await applyFeatureEdit(TWO_PART_CODE, bad);
      expect(result.error).toBe('malformed foreign sketch spec');
      expect(result.newCode).toBe(TWO_PART_CODE);
    }
  });
});

describe('applyFeatureEdit — foreign sketch (cross file)', () => {
  it('renders the export identifier and adds its relative import', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  sketch('xy', () => { circle([0, 0], 10) })`,
      `  extrude(5)`,
      `})`,
      ``,
    ].join('\n');

    const result = await applyFeatureEdit(code, foreignSpec({
      activePart: { line: 3, column: 18 },
      sketchForeign: { exposeName: 'profile', ident: 'donor', importFrom: './donor.fluid.js' },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch(donor.features.profile, () => {`);
    expect(result.newCode).toContain(`import { donor } from './donor.fluid.js';`);
  });
});

describe('resolvePartBindingIdent', () => {
  it('resolves an exported const binding', async () => {
    const result = await resolvePartBindingIdent(TWO_PART_CODE, 3);
    expect(result).toEqual({ ident: 'p1', exported: true });
  });

  it('resolves a non-exported module-level const as unexported', async () => {
    const code = [
      `import { part } from 'fluidcad/core'`,
      `const local = part('Donor', () => {})`,
      ``,
    ].join('\n');
    const result = await resolvePartBindingIdent(code, 2);
    expect(result).toEqual({ ident: 'local', exported: false });
  });

  it('refuses a wrapped binding — the const holds the wrapper, not the part', async () => {
    const code = [
      `import { part } from 'fluidcad/core'`,
      `const wrapped = register(part('Donor', () => {}))`,
      ``,
    ].join('\n');
    const result = await resolvePartBindingIdent(code, 2);
    // The largest call on the row is register(...), whose chain does not
    // root at part() — refused before the binding is even considered.
    expect('error' in result && result.error).toContain('no part() call found');
  });

  it('resolves a chained definition binding to its root part call', async () => {
    const code = [
      `import { part } from 'fluidcad/core'`,
      `export const named = part('Donor', () => {}).name('Renamed')`,
      ``,
    ].join('\n');
    const result = await resolvePartBindingIdent(code, 2);
    expect(result).toEqual({ ident: 'named', exported: true });
  });
});
