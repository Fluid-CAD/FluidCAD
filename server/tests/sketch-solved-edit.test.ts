import { describe, it, expect } from 'vitest';
import { applySolvedEmission } from '../src/sketch-solved-edit.ts';

// Solved-sketch emission transform (sketch-rewrite P5): geometry + constraint
// statements in one edit, geometry before the body's first constraint
// statement (locked plan §0.2), constraints appended at the body end.

const SKETCH = [
  `import { sketch, line, circle } from "fluidcad/core";`,
  `import { horizontal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  line([100, 0], [100, 50]);`,
  `  horizontal(a);`,
  `});`,
].join('\n');

const EMPTY_SKETCH = [
  `import { sketch } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `});`,
].join('\n');

describe('applySolvedEmission', () => {
  it('inserts geometry BEFORE the first constraint statement, constraints at the body end', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 50], [0, 50])' }],
      constraints: [{
        kind: 'coincident',
        targets: [{ newIndex: 0, role: 'start' }, { line: 6, role: 'end', featureType: 'line' }],
      }],
    });
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    // Geometry lands between the existing entities and horizontal(a); the
    // coincident appends after horizontal(a).
    // Names allocate in constraint-target order: the new line (newIndex
    // target) claims l1, the hoisted existing statement gets l2.
    const geomIdx = lines.findIndex(l => l.includes('const l1 = line([100, 50], [0, 50]);'));
    const horizIdx = lines.findIndex(l => l.includes('horizontal(a);'));
    const coincIdx = lines.findIndex(l => l.includes('coincident(l1.start(), l2.end());'));
    expect(geomIdx).toBeGreaterThan(0);
    expect(geomIdx).toBeLessThan(horizIdx);
    expect(coincIdx).toBeGreaterThan(horizIdx);
    // The existing unbound line was hoisted.
    expect(result.newCode).toContain('const l2 = line([100, 0], [100, 50]);');
    // Reported line points at the geometry statement (1-indexed).
    expect(lines[result.geometryLines![0] - 1]).toContain('const l1 = line([100, 50], [0, 50]);');
    expect(result.names).toEqual(['l1']);
  });

  it('appends constraints BEFORE the first derived-op statement (P6 tail region)', async () => {
    const code = [
      `import { sketch, line, offset } from "fluidcad/core";`,
      `import { horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  horizontal(a);`,
      `  const o = offset(2, a);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 4,
      geometry: [],
      constraints: [{
        kind: 'fix',
        targets: [{ line: 5, role: 'start', featureType: 'line' }],
      }],
    });
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    const fixIdx = lines.findIndex(l => l.includes('fix(a.start());'));
    const offsetIdx = lines.findIndex(l => l.includes('const o = offset(2, a);'));
    const horizIdx = lines.findIndex(l => l.includes('horizontal(a);'));
    expect(fixIdx).toBeGreaterThan(horizIdx);
    expect(fixIdx).toBeLessThan(offsetIdx);
  });

  it('emits a full rect (4 lines + 8 constraints) into an empty body, geometry above constraints', async () => {
    const result = await applySolvedEmission(EMPTY_SKETCH, {
      sketchLine: 3,
      geometry: [
        { kind: 'line', text: 'line([0, 0], [40, 0])' },
        { kind: 'line', text: 'line([40, 0], [40, 30])' },
        { kind: 'line', text: 'line([40, 30], [0, 30])' },
        { kind: 'line', text: 'line([0, 30], [0, 0])' },
      ],
      constraints: [
        { kind: 'coincident', targets: [{ newIndex: 0, role: 'end' }, { newIndex: 1, role: 'start' }] },
        { kind: 'coincident', targets: [{ newIndex: 1, role: 'end' }, { newIndex: 2, role: 'start' }] },
        { kind: 'coincident', targets: [{ newIndex: 2, role: 'end' }, { newIndex: 3, role: 'start' }] },
        { kind: 'coincident', targets: [{ newIndex: 3, role: 'end' }, { newIndex: 0, role: 'start' }] },
        { kind: 'horizontal', targets: [{ newIndex: 0 }] },
        { kind: 'horizontal', targets: [{ newIndex: 2 }] },
        { kind: 'vertical', targets: [{ newIndex: 1 }] },
        { kind: 'vertical', targets: [{ newIndex: 3 }] },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `sketch('xy', () => {`,
      `  const l1 = line([0, 0], [40, 0]);`,
      `  const l2 = line([40, 0], [40, 30]);`,
      `  const l3 = line([40, 30], [0, 30]);`,
      `  const l4 = line([0, 30], [0, 0]);`,
      `  coincident(l1.end(), l2.start());`,
      `  coincident(l2.end(), l3.start());`,
      `  coincident(l3.end(), l4.start());`,
      `  coincident(l4.end(), l1.start());`,
      `  horizontal(l1);`,
      `  horizontal(l3);`,
      `  vertical(l2);`,
      `  vertical(l4);`,
      `});`,
    ].join('\n'));
    // Imports split per module, and geometryLines survive the added import line.
    expect(result.newCode).toContain(`import {line, sketch } from "fluidcad/core";`);
    expect(result.newCode).toContain(`import { vertical,horizontal, coincident } from 'fluidcad/constraints';`);
    const lines = result.newCode.split('\n');
    result.geometryLines!.forEach((n, i) => {
      expect(lines[n - 1]).toContain(`const l${i + 1} = `);
    });
  });

  it('leaves unreferenced geometry unbound and reports null names', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'circle', text: 'circle([10, 10], 20)' }],
      constraints: [],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  circle([10, 10], 20);\n  horizontal(a);`);
    expect(result.names).toEqual([null]);
  });

  it('appends .guide() per geometry entry', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [
        { kind: 'circle', text: 'circle([10, 10], 20)', guide: true },
        { kind: 'line', text: 'line([0, 0], [5, 5]).guide()', guide: true },
      ],
      constraints: [],
    });
    expect(result.newCode).toContain('circle([10, 10], 20).guide();');
    // Already-guided text is not double-suffixed.
    expect(result.newCode).toContain('line([0, 0], [5, 5]).guide();');
    expect(result.newCode).not.toContain('.guide().guide()');
  });

  it('geometry and constraints both land before an active breakpoint', async () => {
    const withBp = SKETCH.replace(`  horizontal(a);`, `  horizontal(a);\n  breakpoint();`);
    const result = await applySolvedEmission(withBp, {
      sketchLine: 4,
      geometry: [{ kind: 'point', text: 'point([1, 2])' }],
      constraints: [{ kind: 'fix', targets: [{ newIndex: 0 }] }],
    });
    expect(result.error).toBeUndefined();
    // Geometry before the first constraint (which precedes the breakpoint);
    // the fix lands after horizontal(a), before breakpoint().
    expect(result.newCode).toContain([
      `  const p1 = point([1, 2]);`,
      `  horizontal(a);`,
      `  fix(p1);`,
      `  breakpoint();`,
    ].join('\n'));
  });

  it('a breakpoint ABOVE the first constraint wins the geometry row', async () => {
    const withBp = SKETCH.replace(`  horizontal(a);`, `  breakpoint();\n  horizontal(a);`);
    const result = await applySolvedEmission(withBp, {
      sketchLine: 4,
      geometry: [{ kind: 'point', text: 'point([1, 2])' }],
      constraints: [{ kind: 'fix', targets: [{ newIndex: 0 }] }],
    });
    expect(result.newCode).toContain([
      `  const p1 = point([1, 2]);`,
      `  fix(p1);`,
      `  breakpoint();`,
      `  horizontal(a);`,
    ].join('\n'));
  });

  it('declares local newVariables at the body top and re-anchors line targets', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([100, 50], [100 - w, 50])' }],
      constraints: [{
        kind: 'coincident',
        targets: [{ newIndex: 0, role: 'start' }, { line: 6, role: 'end', featureType: 'line' }],
      }],
      newVariables: [{ name: 'w', initializer: '40' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xy', () => {\n  const w = 40;`);
    // Line 6 still resolved to the (shifted) second line statement.
    expect(result.newCode).toContain('const l2 = line([100, 0], [100, 50]);');
    expect(result.newCode).toContain('coincident(l1.start(), l2.end());');
    const lines = result.newCode.split('\n');
    expect(lines[result.geometryLines![0] - 1]).toContain('const l1 = line([100, 50], [100 - w, 50]);');
  });

  it('declares param() newVariables at top level and keeps geometryLines honest', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'circle', text: 'circle([10, 10], d)' }],
      constraints: [],
      newVariables: [{ name: 'd', initializer: 'param(20)' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toMatch(/const d = param\(20\);/);
    const lines = result.newCode.split('\n');
    expect(lines[result.geometryLines![0] - 1]).toContain('circle([10, 10], d);');
  });

  it('refuses malformed geometry text and out-of-range newIndex', async () => {
    const badText = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'circle([0, 0], 5)' }],
      constraints: [],
    });
    expect(badText.error).toContain('invalid line statement text');
    expect(badText.newCode).toBe(SKETCH);

    const multi = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([0, 0], [1, 1]);\nfix(x)' }],
      constraints: [],
    });
    expect(multi.error).toContain('invalid line statement text');

    const outOfRange = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([0, 0], [1, 1])' }],
      constraints: [{ kind: 'horizontal', targets: [{ newIndex: 1 }] }],
    });
    expect(outOfRange.error).toContain('newIndex 1 is out of range');
  });

  it('refuses a target naming both line and newIndex, or neither', async () => {
    const both = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([0, 0], [1, 1])' }],
      constraints: [{ kind: 'coincident', targets: [{ line: 5, newIndex: 0 }, { line: 6 }] }],
    });
    expect(both.error).toContain('exactly one of line/newIndex');

    const neither = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [],
      constraints: [{ kind: 'coincident', targets: [{}, { line: 6 }] }],
    });
    expect(neither.error).toContain('exactly one of line/newIndex');
  });

  it('refuses an empty emission', async () => {
    const result = await applySolvedEmission(SKETCH, {
      sketchLine: 4,
      geometry: [],
      constraints: [],
    });
    expect(result.error).toContain('nothing to emit');
  });

  it('allocates names past existing identifiers (no collisions)', async () => {
    const withNames = SKETCH.replace('const a = ', 'const l1 = ').replace('horizontal(a);', 'horizontal(l1);');
    const result = await applySolvedEmission(withNames, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([1, 1], [2, 2])' }],
      constraints: [{ kind: 'horizontal', targets: [{ newIndex: 0 }] }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const l2 = line([1, 1], [2, 2]);');
    expect(result.newCode).toContain('horizontal(l2);');
  });
});
