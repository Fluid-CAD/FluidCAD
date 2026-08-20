import { describe, it, expect } from 'vitest';
import { applySketchConstraint } from '../src/sketch-constraint-edit.ts';
import { applyDistanceTangency } from '../src/sketch-solved-edit.ts';

// Constraint emission for solved sketches (sketch-rewrite P4): hoisting of
// unbound entity statements + body-end insertion + constraints import, all
// in one transform.

const SKETCH = [
  `import { sketch, line, circle } from "fluidcad/core";`,
  `import { horizontal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  line([100, 0], [100, 50]);`,
  `  circle([50, 25], 20).guide();`,
  `  horizontal(a);`,
  `}, true);`,
].join('\n');

describe('applySketchConstraint', () => {
  it('emits a two-target constraint using existing bindings', async () => {
    const withBound = SKETCH.replace('line([100, 0], [100, 50]);', 'const b = line([100, 0], [100, 50]);');
    const result = await applySketchConstraint(withBound, {
      sketchLine: 4,
      kind: 'perpendicular',
      targets: [{ line: 5, featureType: 'line' }, { line: 6, featureType: 'line' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  perpendicular(a, b);\n}, true);`);
    expect(result.newCode).toContain(`import {perpendicular, horizontal } from "fluidcad/constraints"`);
  });

  it('hoists an unbound producer to a collision-free const', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'parallel',
      targets: [{ line: 5 }, { line: 6 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l1 = line([100, 0], [100, 50]);`);
    expect(result.newCode).toContain(`parallel(a, l1);`);
  });

  it('renders point roles, values and axes', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'distance',
      targets: [{ line: 5, role: 'start' }, { line: 6, role: 'end' }],
      valueExpr: '25.5',
      axis: 'x',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`distance(a.start(), l1.end(), 25.5, 'x');`);
  });

  it('renders the max tangency condition as a chained .max()', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'distance',
      targets: [{ line: 5, featureType: 'line' }, { line: 7, featureType: 'circle' }],
      valueExpr: '70',
      tangency: 'max',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`distance(a, c1, 70).max();`);
  });

  it('two targets on the SAME unbound statement hoist once and share the name (a lone line\'s length is distance(l.start(), l.end(), …))', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'distance',
      targets: [
        { line: 6, role: 'start', featureType: 'line' },
        { line: 6, role: 'end', featureType: 'line' },
      ],
      valueExpr: '40',
    });
    expect(result.error).toBeUndefined();
    // A per-target hoist would emit `const l2 = const l1 = line(…)`.
    expect(result.newCode).toContain(`  const l1 = line([100, 0], [100, 50]);`);
    expect(result.newCode).not.toContain('const l2');
    expect(result.newCode).toContain(`distance(l1.start(), l1.end(), 40);`);
  });

  it('two targets on the same bound statement reuse its binding', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'distance',
      targets: [
        { line: 5, role: 'start', featureType: 'line' },
        { line: 5, role: 'end', featureType: 'line' },
      ],
      valueExpr: '100',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`distance(a.start(), a.end(), 100);`);
  });

  it('a chained statement hoists at the statement, and the base callee is checked', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'radius',
      targets: [{ line: 7, featureType: 'circle' }],
      valueExpr: '10',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const c1 = circle([50, 25], 20).guide();`);
    expect(result.newCode).toContain(`radius(c1, 10);`);
  });

  it('REGRESSION: appends before a trailing return statement — a constraint after it never runs', async () => {
    const withReturn = SKETCH.replace(`  horizontal(a);`, `  horizontal(a);\n  return { a };`);
    const result = await applySketchConstraint(withReturn, {
      sketchLine: 4,
      kind: 'distance',
      targets: [{ line: 5, role: 'start' }, { line: 5, role: 'end' }],
      valueExpr: '100',
      axis: 'x',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  distance(a.start(), a.end(), 100, 'x');\n  return { a };`);
  });

  it('appends before an active breakpoint', async () => {
    const withBp = SKETCH.replace(`  horizontal(a);`, `  horizontal(a);\n  breakpoint();`);
    const result = await applySketchConstraint(withBp, {
      sketchLine: 4,
      kind: 'vertical',
      targets: [{ line: 6 }],
    });
    expect(result.newCode).toContain(`  vertical(l1);\n  breakpoint();`);
  });

  it('refuses a featureType mismatch (source changed under the picks)', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'radius',
      targets: [{ line: 5, featureType: 'circle' }],
      valueExpr: '10',
    });
    expect(result.error).toContain('line 5 is a line() statement now');
    expect(result.newCode).toBe(SKETCH);
  });

  it('refuses non-entity targets and unknown kinds', async () => {
    const nonEntity = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8 }],
    });
    expect(nonEntity.error).toContain('line 8 is not a sketch entity statement');

    const badKind = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'rect' as any,
      targets: [{ line: 5 }],
    });
    expect(badKind.error).toContain("unknown constraint kind 'rect'");
  });

  it('refuses a missing sketch line', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 2,
      kind: 'horizontal',
      targets: [{ line: 5 }],
    });
    expect(result.error).toContain('no sketch statement at line 2');
  });
});

describe('applyDistanceTangency', () => {
  const DIMMED = [
    `import { sketch, line, arc } from "fluidcad/core";`,
    `import { distance, radius } from "fluidcad/constraints";`,
    ``,
    `sketch('xy', () => {`,
    `  const l1 = line([0, 0], [0, 100]);`,
    `  const a1 = arc([140, 30], [140, 70], [140, 50]);`,
    `  radius(a1, 20);`,
    `  distance(l1, a1, 130);`,
    `}, true);`,
  ].join('\n');

  it('appends .max() to a bare distance statement', async () => {
    const result = await applyDistanceTangency(DIMMED, { line: 8, tangency: 'max' });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`distance(l1, a1, 130).max();`);
  });

  it('strips .max() when switching back to min; min on a bare statement is a no-op', async () => {
    const withMax = DIMMED.replace('distance(l1, a1, 130);', 'distance(l1, a1, 130).max();');
    const back = await applyDistanceTangency(withMax, { line: 8, tangency: 'min' });
    expect(back.error).toBeUndefined();
    expect(back.newCode).toContain(`distance(l1, a1, 130);`);
    expect(back.newCode).not.toContain('.max()');

    const noop = await applyDistanceTangency(DIMMED, { line: 8, tangency: 'min' });
    expect(noop.newCode).toBe(DIMMED);
  });

  it('replaces an explicit .min() and survives other chained calls', async () => {
    const chained = DIMMED.replace(
      'distance(l1, a1, 130);',
      `distance(l1, a1, 130).min().name('gap');`,
    );
    const result = await applyDistanceTangency(chained, { line: 8, tangency: 'max' });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`distance(l1, a1, 130).name('gap').max();`);
  });

  it('refuses a line that is not a distance statement', async () => {
    const result = await applyDistanceTangency(DIMMED, { line: 7, tangency: 'max' });
    expect(result.error).toContain('not a distance() statement');
    expect(result.newCode).toBe(DIMMED);
  });
});
