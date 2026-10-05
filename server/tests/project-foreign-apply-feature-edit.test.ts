import { describe, it, expect } from 'vitest';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';

const FILE = '/ws/model.fluid.js';

/** Donor bound at line 3 (extrude at 5, exposure at 6); consumer at 9 with its sketch at 11. */
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
  `  extrude(5)`,
  `  sketch('xy', () => {`,
  `    circle([0, 0], 10)`,
  `  })`,
  `})`,
  ``,
].join('\n');

/** The same layout with nothing exposed yet: extrude at 5, consumer at 8, its extrude at 9, sketch at 10. */
const UNEXPOSED_CODE = [
  `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
  ``,
  `export const p1 = part('Donor', () => {`,
  `  sketch('xy', () => { circle([0, 0], 100) })`,
  `  extrude(30)`,
  `})`,
  ``,
  `export const p2 = part('Consumer', () => {`,
  `  extrude(5)`,
  `  sketch('xy', () => {`,
  `    circle([0, 0], 10)`,
  `  })`,
  `})`,
  ``,
].join('\n');

function exposeCreate(name: string, partLine: number, producerLine: number, accessor = 'endFaces'): ApplyFeatureEditSpec {
  return {
    feature: 'expose',
    filePath: FILE,
    expose: { name, part: { line: partLine, column: 18 } },
    producers: [{ line: producerLine, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor, indices: [0], filterArgs: null }],
    imports: [],
  };
}

function projectSpec(overrides: Partial<ApplyFeatureEditSpec> & { project: ApplyFeatureEditSpec['project'] }): ApplyFeatureEditSpec {
  return {
    feature: 'project',
    filePath: FILE,
    producers: [],
    parts: [],
    imports: [],
    ...overrides,
  };
}

describe('applyFeatureEdit — foreign project (same file)', () => {
  it('projects a matched exposure into the sketch body with no picks of its own', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, projectSpec({
      project: { sketch: { line: 11, column: 2 }, foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 18 } }] },
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const row = lines.findIndex(l => l.includes('project(p1.features.endFace)'));
    expect(row).toBeGreaterThan(-1);
    // Inside the consumer's sketch body, after its own circle, at the body indent.
    expect(lines[row - 1].trim()).toBe('circle([0, 0], 10)');
    expect(lines[row]).toBe('    project(p1.features.endFace)');
    expect(lines[0]).toContain('project');
    // The donor is untouched.
    expect(result.newCode).toContain(`  expose('endFace', e.endFaces(0))\n})`);
  });

  it('creates the exposure first, then projects it beside a local pick with every site relocated', async () => {
    const result = await applyFeatureEdit(UNEXPOSED_CODE, projectSpec({
      producers: [{ line: 9, column: 2, featureType: 'extrude', nameHint: 'b', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
      project: {
        sketch: { line: 10, column: 2 },
        foreign: [{ exposeName: 'g1', donor: { line: 3, column: 18 }, create: exposeCreate('g1', 3, 5) }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toMatch(/^import \{[^}]*\bexpose\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode).toMatch(/^import \{[^}]*\bproject\b[^}]*\} from 'fluidcad\/core'/);
    expect(result.newCode.split('\n').slice(1)).toEqual([
      ``,
      `export const p1 = part('Donor', () => {`,
      `  sketch('xy', () => { circle([0, 0], 100) })`,
      `  const e = extrude(30)`,
      `  expose('g1', e.endFaces(0))`,
      `})`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  const b = extrude(5)`,
      `  sketch('xy', () => {`,
      `    circle([0, 0], 10)`,
      `    project(b.endFaces(0), p1.features.g1)`,
      `  })`,
      `})`,
      ``,
    ]);
  });

  it('creates several exposures on one donor and references each', async () => {
    const result = await applyFeatureEdit(UNEXPOSED_CODE, projectSpec({
      project: {
        sketch: { line: 10, column: 2 },
        foreign: [
          { exposeName: 'g1', donor: { line: 3, column: 18 }, create: exposeCreate('g1', 3, 5) },
          { exposeName: 'g2', donor: { line: 3, column: 18 }, create: exposeCreate('g2', 3, 5, 'sideFaces') },
        ],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const e = extrude(30)\n  expose('g1', e.endFaces(0))\n  expose('g2', e.sideFaces(0))\n})`);
    expect(result.newCode).toContain(`    project(p1.features.g1, p1.features.g2)\n  })`);
  });

  it('relocates a second donor and its create across the first exposure edit', async () => {
    const code = [
      `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
      ``,
      `export const p1 = part('Donor', () => {`,
      `  sketch('xy', () => { circle([0, 0], 100) })`,
      `  extrude(30)`,
      `})`,
      ``,
      `export const base = part('Base', () => {`,
      `  sketch('xy', () => { circle([0, 0], 40) })`,
      `  extrude(10)`,
      `})`,
      ``,
      `export const p2 = part('Consumer', () => {`,
      `  sketch('xy', () => {`,
      `    circle([0, 0], 10)`,
      `  })`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, projectSpec({
      project: {
        sketch: { line: 14, column: 2 },
        foreign: [
          { exposeName: 'g1', donor: { line: 3, column: 18 }, create: exposeCreate('g1', 3, 5) },
          // Addressed by its pre-edit lines: the first create shifts them down by one.
          { exposeName: 'g1', donor: { line: 8, column: 20 }, create: exposeCreate('g1', 8, 10) },
        ],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const e = extrude(30)\n  expose('g1', e.endFaces(0))\n})`);
    // The second donor's producer takes the next free name in the file.
    expect(result.newCode).toContain(`  const e2 = extrude(10)\n  expose('g1', e2.endFaces(0))\n})`);
    expect(result.newCode).toContain(`    circle([0, 0], 10)\n    project(p1.features.g1, base.features.g1)\n  })`);
  });

  it('keeps a verbatim override while still creating the exposure it names', async () => {
    const result = await applyFeatureEdit(UNEXPOSED_CODE, projectSpec({
      rawArgs: 'p1.features.g1.guide()',
      project: {
        sketch: { line: 10, column: 2 },
        foreign: [{ exposeName: 'g1', donor: { line: 3, column: 18 }, create: exposeCreate('g1', 3, 5) }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  expose('g1', e.endFaces(0))`);
    expect(result.newCode).toContain(`    project(p1.features.g1.guide())`);
  });

  it('follows the sketch statement\'s semicolon style when nothing local is bound', async () => {
    const code = TWO_PART_CODE.replace(`  sketch('xy', () => {\n    circle([0, 0], 10)\n  })`, `  sketch('xy', () => {\n    circle([0, 0], 10);\n  });`);
    const result = await applyFeatureEdit(code, projectSpec({
      project: { sketch: { line: 11, column: 2 }, foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 18 } }] },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    project(p1.features.endFace);\n  });`);
  });

  it('refuses a donor that is not bound to a const, leaving the code untouched', async () => {
    const code = TWO_PART_CODE.replace(`export const p1 = part('Donor'`, `part('Donor'`);
    const result = await applyFeatureEdit(code, projectSpec({
      project: { sketch: { line: 11, column: 2 }, foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 0 } }] },
    }));
    expect(result.error).toContain('not bound to a const');
    expect(result.newCode).toBe(code);
  });

  it('refuses malformed references', async () => {
    const both = await applyFeatureEdit(TWO_PART_CODE, projectSpec({
      project: { sketch: { line: 11, column: 2 }, foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 18 }, ident: 'p1' }] },
    }));
    expect(both.error).toBe('malformed foreign project spec');
    const badCreate = await applyFeatureEdit(TWO_PART_CODE, projectSpec({
      project: {
        sketch: { line: 11, column: 2 },
        foreign: [{ exposeName: 'g1', donor: { line: 3, column: 18 }, create: { ...exposeCreate('g1', 3, 5), feature: 'fillet' } }],
      },
    }));
    expect(badCreate.error).toBe('malformed foreign project spec');
    const badName = await applyFeatureEdit(TWO_PART_CODE, projectSpec({
      project: { sketch: { line: 11, column: 2 }, foreign: [{ exposeName: 'not a name', donor: { line: 3, column: 18 } }] },
    }));
    expect(badName.error).toBe('malformed foreign project spec');
  });
});

describe('applyFeatureEdit — foreign project (cross file)', () => {
  it('references the imported donor and adds the import', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, projectSpec({
      project: {
        sketch: { line: 11, column: 2 },
        foreign: [{ exposeName: 'rim', ident: 'flange', importFrom: './flange.part.js' }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    project(flange.features.rim)`);
    expect(result.newCode).toMatch(/import \{ flange \} from '\.\/flange\.part\.js'/);
  });

  it('renders the local alias when the donor is already imported under another name', async () => {
    const code = TWO_PART_CODE.replace(
      `import { sketch, circle, extrude, part, expose } from 'fluidcad/core'`,
      `import { sketch, circle, extrude, part, expose } from 'fluidcad/core'\nimport { flange as fl } from './flange.part.js'`,
    );
    const result = await applyFeatureEdit(code, projectSpec({
      project: {
        sketch: { line: 12, column: 2 },
        foreign: [{ exposeName: 'rim', ident: 'flange', importFrom: './flange.part.js' }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`    project(fl.features.rim)`);
    expect(result.newCode).not.toMatch(/import \{ flange \}/);
  });
});
