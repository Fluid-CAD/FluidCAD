import { describe, it, expect } from 'vitest';
import { applySolvedEmission } from '../src/sketch-solved-edit.ts';

// Anchor-point constraint targets (sketch-rewrite P8): ellipse centers,
// text anchors and bezier control points address their owning statement
// and render the featureType-derived accessor — `el.center()`,
// `t.anchor()`, `bz.point(i)` — hoisting unbound statements like any
// entity statement.

describe('applySolvedEmission — anchor-point targets', () => {
  it('hoists an unbound ellipse and renders .center()', async () => {
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
          { line: 5, featureType: 'ellipse' },
          { line: 4, role: 'end', featureType: 'line' },
        ],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const el1 = ellipse([20, 10], 30, 15);');
    expect(result.newCode).toContain('coincident(el1.center(), a.end());');
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
        targets: [{ line: 4, featureType: 'ellipse' }],
      }],
    });
    expect(result.error).toMatch(/not a ellipse\(\) statement/);
  });

  it('refuses a role on an anchor target and a pointIndex outside bezier', async () => {
    const code = [
      `import { sketch, ellipse } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  ellipse([20, 10], 30, 15);`,
      `});`,
    ].join('\n');
    const withRole = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'ellipse', role: 'center' }],
      }],
    });
    expect(withRole.error).toMatch(/takes no point role/);

    const withIndex = await applySolvedEmission(code, {
      sketchLine: 3,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 4, featureType: 'ellipse', pointIndex: 0 }],
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
        targets: [{ line: 5, occurrence: 1, featureType: 'ellipse' }],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const ellipses = [];');
    expect(result.newCode).toContain('ellipses.push(ellipse([20 * i, 10], 8, 4))');
    expect(result.newCode).toContain('fix(ellipses[1].center());');
  });
});
