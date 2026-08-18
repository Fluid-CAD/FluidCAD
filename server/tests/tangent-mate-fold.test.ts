import { describe, it, expect } from 'vitest';
import {
  applyFeatureEdit,
  type ApplyFeatureEditSpec,
} from '../src/apply-feature-edit.ts';

// The tangent mate's same-file find-or-create fold (17-mate-tangent §7.2):
// the embedded 'expose' spec lands inside the donor part's body FIRST, the
// mate payload's insert()/mate() line anchors are relocated by call
// ordinals across that intermediate edit, and the mate statement lands in
// one atomic document replacement.

const CODE = [
  `import { sketch, rect, extrude, part, insert, mate } from 'fluidcad/core'`,
  ``,
  `export function cam() {`,
  `  return part('Cam', () => {`,
  `    sketch('xy', () => { rect(100, 50) })`,
  `    const e = extrude(30)`,
  `  })`,
  `}`,
  ``,
  `const cam1 = insert(cam());`,
  `const fol1 = insert(fol());`,
  ``,
].join('\n');

// A known-good expose create-spec (mirrors expose-apply-feature-edit.test.ts):
// publishes the extrude's end face as g1 inside the part body.
const EXPOSE_SPEC: ApplyFeatureEditSpec = {
  feature: 'expose',
  filePath: '/ws/rig.assembly.js',
  expose: { name: 'g1', part: { line: 4, column: 9 } },
  producers: [{ line: 6, column: 4, featureType: 'extrude', nameHint: 'e', bind: true }],
  parts: [{ producer: 0, accessor: 'endFaces', indices: [0], filterArgs: null }],
  imports: [],
};

function mateSpec(assemblyMate: NonNullable<ApplyFeatureEditSpec['assemblyMate']>): ApplyFeatureEditSpec {
  return {
    feature: 'sketch',
    filePath: '/ws/rig.assembly.js',
    producers: [],
    parts: [],
    imports: [],
    assemblyMate,
  };
}

describe('tangent mate — same-file expose fold', () => {
  it('applies the expose first and lands the mate against the RELOCATED insert lines', async () => {
    // instanceLines address the PRE-edit rows (10, 11); the expose adds a
    // row inside the part body above them, so an unrelocated resolve would
    // grab the wrong statements.
    const result = await applyFeatureEdit(CODE, mateSpec({
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 10, exposeName: 'g1' },
        geometryB: { instanceLine: 11, exposeName: 'tip' },
      },
      exposeCreates: [EXPOSE_SPEC],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`expose('g1', e.endFaces(0))`);
    expect(result.newCode).toContain(
      `mate('tangent', cam1.features.g1, fol1.features.tip);`,
    );
    // The expose landed INSIDE the part body, before the mate.
    const lines = result.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes(`expose('g1'`));
    const insertRow = lines.findIndex(l => l.includes('const cam1'));
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(insertRow);
  });

  it('relocates an edited mate statement across the expose edit too', async () => {
    const withMate = `${CODE}mate('tangent', cam1.features.old, fol1.features.tip);\n`;
    const result = await applyFeatureEdit(withMate, mateSpec({
      edit: {
        sourceLine: 12,
        type: 'tangent',
        geometryA: { instanceLine: 10, exposeName: 'g1' },
        geometryB: { instanceLine: 11, exposeName: 'tip' },
        options: { propagate: false },
      },
      exposeCreates: [EXPOSE_SPEC],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `mate('tangent', cam1.features.g1, fol1.features.tip).noPropagate();`,
    );
    expect(result.newCode).not.toContain('features.old');
    expect(result.newCode.match(/mate\(/g)).toHaveLength(1);
  });

  it('refuses non-expose creates', async () => {
    const result = await applyFeatureEdit(CODE, mateSpec({
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 10, exposeName: 'g1' },
        geometryB: { instanceLine: 11, exposeName: 'tip' },
      },
      exposeCreates: [{ ...EXPOSE_SPEC, feature: 'sketch' }],
    }));
    expect(result.error).toMatch(/exposeCreates must be expose specs/);
  });

  it('a failing embedded expose leaves the document untouched', async () => {
    const result = await applyFeatureEdit(CODE, mateSpec({
      create: {
        type: 'tangent',
        geometryA: { instanceLine: 10, exposeName: 'g1' },
        geometryB: { instanceLine: 11, exposeName: 'tip' },
      },
      exposeCreates: [{
        ...EXPOSE_SPEC,
        // A part call site that doesn't exist → the expose transform fails.
        expose: { name: 'g1', part: { line: 2, column: 0 } },
      }],
    }));
    expect(result.error).toBeDefined();
    expect(result.newCode).toBe(CODE);
  });
});
