import { describe, it, expect } from 'vitest';
import { applySolvedEmission } from '../src/sketch-solved-edit.ts';

// Anchor-point constraint targets (sketch-rewrite P8): text anchors and
// bezier control points address their owning statement and render the
// featureType-derived accessor — `t.anchor()`, `bz.point(i)` — hoisting
// unbound statements like any entity statement. The ellipse is an entity
// statement of its own: its center is the `center` role, its bare name a
// horizontal/vertical/concentric/tangent target.

describe('applySolvedEmission — anchor-point targets', () => {
  it('hoists an unbound ellipse and renders its center role and bare name', async () => {
    const code = [
      `import { sketch, line, ellipse } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  ellipse([20, 10], 30, 15);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'coincident',
        targets: [
          { line: 5, featureType: 'ellipse', role: 'center' },
          { line: 4, role: 'end', featureType: 'line' },
        ],
      }, {
        kind: 'horizontal',
        targets: [{ line: 5, featureType: 'ellipse' }],
      }, {
        kind: 'tangent',
        targets: [{ line: 4, featureType: 'line' }, { line: 5, featureType: 'ellipse' }],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const el1 = ellipse([20, 10], 30, 15);');
    expect(result.newCode).toContain('coincident(el1.center(), a.end());');
    expect(result.newCode).toContain('horizontal(el1);');
    expect(result.newCode).toContain('tangent(a, el1);');
  });

  it('hoists an unbound chained text, renders .anchor(), and places the constraint after the derived-ops-tail statement', async () => {
    const code = [
      `import { sketch, line, text } from "fluidcad/core";`,
      `import { horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  horizontal(a);`,
      `  text('Hi').size(10);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 4,
      geometry: [],
      constraints: [{
        kind: 'coincident',
        targets: [
          { line: 7, featureType: 'text' },
          { line: 5, role: 'end', featureType: 'line' },
        ],
      }],
    });
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const textIdx = lines.findIndex(l => l.includes(`const t1 = text('Hi').size(10);`));
    const coincIdx = lines.findIndex(l => l.includes('coincident(t1.anchor(), a.end());'));
    // text() sits in the derived-ops tail — the constraint referencing its
    // binding must land after it, not in the normal constraints region.
    expect(textIdx).toBeGreaterThan(0);
    expect(coincIdx).toBeGreaterThan(textIdx);
  });

  it('renders bezier control points as .point(i) on a bound statement', async () => {
    const code = [
      `import { sketch, line, bezier } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  const b = bezier([0, 0], [50, 50], [100, 0]);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'coincident',
        targets: [
          { line: 5, featureType: 'bezier', pointIndex: 1 },
          { line: 4, role: 'end', featureType: 'line' },
        ],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('coincident(b.point(1), a.end());');
  });

  it('emits a bezier and binds its control points by newIndex — the Mirror tool\'s reflected curve', async () => {
    const code = [
      `import { sketch, line, bezier } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  bezier([0, 0], [50, 50], a.end());`,
      `});`,
    ].join('\n');
    const image = (pointIndex: number) => ({ newIndex: 0, featureType: 'bezier' as const, pointIndex });
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [{ kind: 'bezier', text: 'bezier([0, 0], [-50, 50], [-100, 0])' }],
      constraints: [
        { kind: 'symmetric', targets: [{ line: 5, featureType: 'bezier', pointIndex: 0 }, image(0), { datum: 'y-axis' }] },
        { kind: 'symmetric', targets: [{ line: 5, featureType: 'bezier', pointIndex: 1 }, image(1), { datum: 'y-axis' }] },
        { kind: 'symmetric', targets: [{ line: 4, featureType: 'line', role: 'end' }, image(2), { datum: 'y-axis' }] },
      ],
    });
    expect(result.error).toBeUndefined();
    // The source bezier hoists like any entity statement; the new one binds
    // under the bezier name hint; every row names control points.
    expect(result.newCode).toContain('const bz1 = bezier([0, 0], [50, 50], a.end());');
    expect(result.newCode).toContain('const bz2 = bezier([0, 0], [-50, 50], [-100, 0]);');
    expect(result.newCode).toContain('symmetric(bz1.point(0), bz2.point(0), yAxis());');
    expect(result.newCode).toContain('symmetric(bz1.point(1), bz2.point(1), yAxis());');
    expect(result.newCode).toContain('symmetric(a.end(), bz2.point(2), yAxis());');
    const coreImport = result.newCode.split('\n')[0];
    expect(coreImport).toMatch(/^import \{[^}]*\} from "fluidcad\/core";$/);
    expect(coreImport).toMatch(/\bbezier\b/);
    expect(coreImport).toMatch(/\byAxis\b/);
    // The new constraints import shifts the body by a line; the reported
    // geometry line points at the emitted bezier after that shift.
    expect(result.geometryLines).toHaveLength(1);
    expect(result.newCode.split('\n')[result.geometryLines![0] - 1]).toContain('const bz2 = bezier(');
  });

  it('refuses a newIndex target that names an emitted bezier as a whole, or with the wrong featureType', async () => {
    const code = [
      `import { sketch, line } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `});`,
    ].join('\n');
    const geometry = [{ kind: 'bezier' as const, text: 'bezier([0, 0], [-50, 50], [-100, 0])' }];
    const whole = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry,
      constraints: [{ kind: 'symmetric', targets: [{ line: 4, featureType: 'line' }, { newIndex: 0 }, { datum: 'y-axis' }] }],
    });
    expect(whole.error).toMatch(/is a bezier — address one of its control points/);
    const mismatched = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry,
      constraints: [{ kind: 'horizontal', targets: [{ newIndex: 0, featureType: 'line' }] }],
    });
    expect(mismatched.error).toMatch(/newIndex 0 is a bezier statement, not line/);
  });

  it('refuses an anchor target whose statement callee drifted', async () => {
    const code = [
      `import { sketch, circle } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  circle([20, 10], 30);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'text' }],
      }],
    });
    expect(result.error).toMatch(/not a text\(\) statement/);
  });

  it('refuses a role on an anchor target and a pointIndex outside bezier', async () => {
    const code = [
      `import { sketch, text } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  text('Hi');`,
      `});`,
    ].join('\n');
    const withRole = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'text', role: 'center' }],
      }],
    });
    expect(withRole.error).toMatch(/takes no point role/);

    const withIndex = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'text', pointIndex: 0 }],
      }],
    });
    expect(withIndex.error).toMatch(/takes no pointIndex/);
  });

  it('refuses a bezier anchor target without a pointIndex', async () => {
    const code = [
      `import { sketch, bezier } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  bezier([0, 0], [50, 50], [100, 0]);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'bezier' }],
      }],
    });
    expect(result.error).toMatch(/needs a non-negative pointIndex/);
  });

  it('swaps an ellipse orientation: removes horizontal(el1) and adds vertical(el1) in one edit', async () => {
    const code = [
      `import { sketch, ellipse } from "fluidcad/core";`,
      `import { horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const el1 = ellipse([20, 10], 30, 15);`,
      `  horizontal(el1);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 4,
      geometry: [],
      constraints: [{ kind: 'vertical', targets: [{ line: 5, featureType: 'ellipse' }] }],
      removals: [{ line: 6 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('vertical(el1);');
    expect(result.newCode).not.toContain('horizontal(el1)');
    expect(result.newCode.split('\n')[1]).toMatch(/import \{[^}]*\bvertical\b[^}]*\} from "fluidcad\/constraints";/);
  });

  it('rides the loop-collector rail for an ellipse in a for loop', async () => {
    const code = [
      `import { sketch, ellipse } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  for (let i = 0; i < 3; i++) {`,
      `    ellipse([20 * i, 10], 8, 4);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 5, occurrence: 1, featureType: 'ellipse', role: 'center' }],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const ellipses = [];');
    expect(result.newCode).toContain('ellipses.push(ellipse([20 * i, 10], 8, 4))');
    expect(result.newCode).toContain('fix(ellipses[1].center());');
  });
});
