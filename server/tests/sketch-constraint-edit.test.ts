import { describe, it, expect } from 'vitest';
import { applySketchConstraint } from '../src/sketch-constraint-edit.ts';

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
