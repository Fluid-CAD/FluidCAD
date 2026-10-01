import { describe, it, expect } from 'vitest';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';

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

/** The same two parts before the donor exposes anything. */
const UNEXPOSED_CODE = [
  `import { sketch, circle, extrude, part } from 'fluidcad/core'`,
  ``,
  `export const p1 = part('Donor', () => {`,
  `  sketch('xy', () => { circle([0, 0], 100) })`,
  `  const e = extrude(30)`,
  `})`,
  ``,
  `export const p2 = part('Consumer', () => {`,
  `  sketch('xy', () => { circle([0, 0], 10) })`,
  `  const e2 = extrude(5)`,
  `})`,
  ``,
].join('\n');

/** The donor-side `expose('g1', e.endFaces(0))` create over UNEXPOSED_CODE. */
const EXPOSE_CREATE: ApplyFeatureEditSpec = {
  feature: 'expose',
  filePath: '/ws/model.fluid.js',
  expose: { name: 'g1', part: { line: 3, column: 18 } },
  producers: [{ line: 5, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
  parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
  imports: [],
};

function foreignPlaneSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'plane',
    filePath: '/ws/model.fluid.js',
    producers: [],
    parts: [],
    imports: [],
    activePart: { line: 9, column: 18 },
    plane: {
      type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
      bases: [{ kind: 'foreign', ref: 0 }],
      foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 18 } }],
    },
    ...overrides,
  };
}

describe('applyFeatureEdit — foreign plane (same file)', () => {
  it('lands plane(p1.features.<name>, …) inside the ACTIVE part body', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, foreignPlaneSpec());
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const planeRow = lines.findIndex(l => l.includes(`plane(p1.features.endFace, 10)`));
    const consumerRow = lines.findIndex(l => l.includes(`part('Consumer'`));
    expect(planeRow).toBeGreaterThan(consumerRow);
    // Directly after the consumer's own extrude — inside its body, not the donor's.
    expect(lines[planeRow - 1].trim()).toBe('extrude(5)');
    expect(lines[planeRow].startsWith('  ')).toBe(true);
    expect(lines[0]).toContain('plane');
  });

  it('creates the exposure first and relocates the shifted consumer part', async () => {
    const result = await applyFeatureEdit(UNEXPOSED_CODE, foreignPlaneSpec({
      activePart: { line: 8, column: 18 },
      plane: {
        type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'foreign', ref: 0 }],
        foreign: [{ exposeName: 'g1', donor: { line: 3, column: 18 }, create: EXPOSE_CREATE }],
      },
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('g1', e.endFaces(0))`));
    const consumerRow = lines.findIndex(l => l.includes(`part('Consumer'`));
    const planeRow = lines.findIndex(l => l.includes(`plane(p1.features.g1, 10)`));
    // The exposure lands in the donor (above), the plane in the consumer —
    // whose part() call shifted down one line during the exposure edit.
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(consumerRow);
    expect(planeRow).toBeGreaterThan(consumerRow);
    expect(lines[planeRow - 1].trim()).toBe('const e2 = extrude(5)');
    // Both statements' imports are present.
    expect(lines[0]).toContain('expose');
    expect(lines[0]).toContain('plane');
  });

  it('lands the plane at the file\'s top level, below the donor, without an active part', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, foreignPlaneSpec({ activePart: undefined }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const planeRow = lines.findIndex(l => l.startsWith(`plane(p1.features.endFace, 10)`));
    // Unindented, right after the last part's closing brace.
    expect(planeRow).toBeGreaterThan(lines.findIndex(l => l.includes(`part('Consumer'`)));
    expect(lines[planeRow - 1]).toBe('})');
  });

  it('mixes the consumer\'s own selector with a foreign base, relocating the local producer', async () => {
    // The own pick binds `e2` in the consumer body; the foreign pick's
    // exposure is created in the donor first, shifting e2's line by one.
    const result = await applyFeatureEdit(UNEXPOSED_CODE, foreignPlaneSpec({
      activePart: { line: 8, column: 18 },
      producers: [{ line: 10, column: 2, featureType: 'extrude', nameHint: 'e', bind: true }],
      parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null }],
      plane: {
        type: 'mid', offset: null, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'selector', part: 0 }, { kind: 'foreign', ref: 0 }],
        foreign: [{ exposeName: 'g1', donor: { line: 3, column: 18 }, create: EXPOSE_CREATE }],
      },
    }));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const planeRow = lines.findIndex(l => l.includes(`plane(plane(e2.endFaces()), plane(p1.features.g1))`));
    expect(planeRow).toBeGreaterThan(lines.findIndex(l => l.includes(`part('Consumer'`)));
    expect(lines[planeRow - 1].trim()).toBe('const e2 = extrude(5)');
  });

  it('renders a foreign edge as the edge plane\'s base', async () => {
    const result = await applyFeatureEdit(TWO_PART_CODE, foreignPlaneSpec({
      plane: {
        type: 'edge', offset: null, rotateX: null, rotateY: null, rotateZ: null, position: 0.5,
        bases: [{ kind: 'foreign', ref: 0 }],
        foreign: [{ exposeName: 'endFace', donor: { line: 3, column: 18 } }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  plane(p1.features.endFace, 0.5)`);
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

    const result = await applyFeatureEdit(code, foreignPlaneSpec({
      activePart: { line: 10, column: 18 },
      plane: {
        type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'foreign', ref: 0 }],
        foreign: [{ exposeName: 'g1', donor: { line: 4, column: 9 } }],
      },
    }));
    expect(result.error).toContain('not bound to a const');
    expect(result.newCode).toBe(code);
  });

  it('refuses malformed references', async () => {
    const withRef = (ref: object) => foreignPlaneSpec({
      plane: {
        type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'foreign', ref: 0 }],
        foreign: [ref as any],
      },
    });
    for (const bad of [
      // No addressing mode at all.
      withRef({ exposeName: 'g1' }),
      // Both addressing modes.
      withRef({ exposeName: 'g1', donor: { line: 3, column: 0 }, ident: 'p1' }),
      // Bad name.
      withRef({ exposeName: 'not an id', donor: { line: 3, column: 0 } }),
      // A half-addressed active part (no active part at all is the top level).
      foreignPlaneSpec({ activePart: { line: 9 } as ApplyFeatureEditSpec['activePart'] }),
    ]) {
      const result = await applyFeatureEdit(TWO_PART_CODE, bad);
      expect(result.error).toBe('malformed foreign plane spec');
      expect(result.newCode).toBe(TWO_PART_CODE);
    }
  });

  it('refuses foreign bases that do not match the references', async () => {
    const plane = (bases: unknown[], foreign: unknown[]) => foreignPlaneSpec({
      plane: {
        type: 'mid', offset: null, rotateX: null, rotateY: null, rotateZ: null,
        bases: bases as any, foreign: foreign as any,
      },
    });
    const ref = { exposeName: 'endFace', donor: { line: 3, column: 18 } };
    for (const bad of [
      // A base past the reference list.
      plane([{ kind: 'standard', plane: 'xy' }, { kind: 'foreign', ref: 1 }], [ref]),
      // One reference read by both bases.
      plane([{ kind: 'foreign', ref: 0 }, { kind: 'foreign', ref: 0 }], [ref]),
      // A reference no base reads.
      plane([{ kind: 'standard', plane: 'xy' }, { kind: 'foreign', ref: 0 }], [ref, ref]),
    ]) {
      const result = await applyFeatureEdit(TWO_PART_CODE, bad);
      expect(result.error).toBe('malformed plane edit spec');
      expect(result.newCode).toBe(TWO_PART_CODE);
    }
  });
});

describe('applyFeatureEdit — foreign plane (cross file)', () => {
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

    const result = await applyFeatureEdit(code, foreignPlaneSpec({
      activePart: { line: 3, column: 18 },
      plane: {
        type: 'offset', offset: 10, rotateX: null, rotateY: null, rotateZ: null,
        bases: [{ kind: 'foreign', ref: 0 }],
        foreign: [{ exposeName: 'profile', ident: 'donor', importFrom: './donor.fluid.js' }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  plane(donor.features.profile, 10)`);
    expect(result.newCode).toContain(`import { donor } from './donor.fluid.js';`);
  });
});
