import { describe, it, expect } from 'vitest';
import { applySketchConstraint } from '../src/sketch-constraint-edit.ts';
import { applyDistanceTangency, applySolvedEmission } from '../src/sketch-solved-edit.ts';

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
  `});`,
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
    expect(result.newCode).toContain(`  perpendicular(a, b);\n});`);
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

  it('renders fixed-reference targets (P6): hoisting, .ref(i) and the terse form', async () => {
    const code = [
      `import { sketch, line, project } from "fluidcad/core";`,
      `import { tangent } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  project(sel);`,
      `  const l = line([25, -30], [25, 30]);`,
      `});`,
    ].join('\n');

    // Terse single-entity form: refIndex null → bare variable.
    const terse = await applySketchConstraint(code, {
      sketchLine: 4,
      kind: 'tangent',
      targets: [
        { line: 5, featureType: 'project', refIndex: null },
        { line: 6, featureType: 'line' },
      ],
    });
    expect(terse.error).toBeUndefined();
    expect(terse.newCode).toContain(`const prj1 = project(sel);`);
    expect(terse.newCode).toContain(`tangent(prj1, l);`);

    // Indexed form with a point role.
    const indexed = await applySketchConstraint(code, {
      sketchLine: 4,
      kind: 'coincident',
      targets: [
        { line: 6, featureType: 'line', role: 'start' },
        { line: 5, featureType: 'project', refIndex: 2, role: 'start' },
      ],
    });
    expect(indexed.error).toBeUndefined();
    expect(indexed.newCode).toContain(`coincident(l.start(), prj1.ref(2).start());`);
  });

  it('refuses a reference target whose line is not a project/intersect statement', async () => {
    const result = await applySketchConstraint(SKETCH, {
      sketchLine: 4,
      kind: 'tangent',
      targets: [
        { line: 5, featureType: 'project', refIndex: null },
        { line: 6, featureType: 'line' },
      ],
    });
    expect(result.error).toContain('not a project()/intersect() statement');
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

// Loop-instance constraint targeting: entities created in a user loop share
// one source line, so targets carry a 0-based `occurrence` and the transform
// collects the instances into an array hoisted before the outermost loop.
describe('applySketchConstraint (loop instances)', () => {
  const LOOP_SKETCH = [
    `import { sketch, line } from "fluidcad/core";`,
    ``,
    `sketch('xy', () => {`,
    `  for (let i = 0; i < 5; i++) {`,
    `    line([i * 10, 0], [i * 10, 20]);`,
    `  }`,
    `});`,
  ].join('\n');

  it('collects an unbound loop statement into an array and indexes per occurrence', async () => {
    const result = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 5, featureType: 'line', occurrence: 0 },
        { line: 5, featureType: 'line', occurrence: 3 },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `sketch('xy', () => {`,
      `  const lines = [];`,
      `  for (let i = 0; i < 5; i++) {`,
      `    lines.push(line([i * 10, 0], [i * 10, 20]));`,
      `  }`,
      `  parallel(lines[0], lines[3]);`,
      `});`,
    ].join('\n'));
  });

  it('keeps a bound loop statement\'s binding and appends the push after it', async () => {
    const bound = [
      `import { sketch, line } from "fluidcad/core";`,
      `import { horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  for (let i = 0; i < 4; i++) {`,
      `    const l = line([0, i * 10], [50, i * 10]);`,
      `    horizontal(l);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(bound, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 6, featureType: 'line', occurrence: 2 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const lines = [];`,
      `  for (let i = 0; i < 4; i++) {`,
      `    const l = line([0, i * 10], [50, i * 10]);`,
      `    lines.push(l);`,
      `    horizontal(l);`,
      `  }`,
      `  horizontal(lines[2]);`,
    ].join('\n'));

    // A second emission reuses the collector the binding already feeds.
    const again = await applySketchConstraint(result.newCode, {
      sketchLine: 4,
      kind: 'vertical',
      targets: [{ line: 7, featureType: 'line', occurrence: 1 }],
    });
    expect(again.error).toBeUndefined();
    expect(again.newCode).toContain(`vertical(lines[1]);`);
    expect(again.newCode.match(/const lines = \[\];/g)).toHaveLength(1);
    expect(again.newCode.match(/lines\.push\(/g)).toHaveLength(1);
  });

  it('a second emission against push-wrapped code reuses the array — no second hoist, no double wrap', async () => {
    const first = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 5, featureType: 'line', occurrence: 0 },
        { line: 5, featureType: 'line', occurrence: 3 },
      ],
    });
    expect(first.error).toBeUndefined();
    // The parallel import shifted everything down one; the push-wrapped
    // entity statement now sits on line 7 (findEditableCallAt returns the
    // OUTERMOST call on the row — the push wrapper).
    const second = await applySketchConstraint(first.newCode, {
      sketchLine: 4,
      kind: 'perpendicular',
      targets: [
        { line: 7, featureType: 'line', occurrence: 1 },
        { line: 7, featureType: 'line', occurrence: 2 },
      ],
    });
    expect(second.error).toBeUndefined();
    expect(second.newCode).toContain(`perpendicular(lines[1], lines[2]);`);
    expect(second.newCode.match(/const lines = \[\];/g)).toHaveLength(1);
    expect(second.newCode.match(/lines\.push\(/g)).toHaveLength(1);
  });

  it('refuses an occurrence with no enclosing loop (helper function)', async () => {
    const helper = [
      `import { sketch, line } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const rung = (y) => line([0, y], [40, y]);`,
      `  rung(0);`,
      `  rung(10);`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(helper, {
      sketchLine: 3,
      kind: 'horizontal',
      targets: [{ line: 4, featureType: 'line', occurrence: 1 }],
    });
    expect(result.error).toContain('line 4 runs more than once (helper function)');
    expect(result.newCode).toBe(helper);
  });

  it('mixes a loop-instance target with a plain bound target', async () => {
    const mixed = [
      `import { sketch, line } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const base = line([0, 0], [100, 0]);`,
      `  for (let i = 0; i < 3; i++) {`,
      `    line([i * 30, 10], [i * 30 + 20, 10]);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(mixed, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 4, featureType: 'line' },
        { line: 6, featureType: 'line', occurrence: 1 },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const base = line([0, 0], [100, 0]);`,
      `  const lines = [];`,
      `  for (let i = 0; i < 3; i++) {`,
      `    lines.push(line([i * 30, 10], [i * 30 + 20, 10]));`,
      `  }`,
      `  parallel(base, lines[1]);`,
    ].join('\n'));
  });

  it('composes point roles on loop-instance refs (one collector per statement)', async () => {
    const result = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'coincident',
      targets: [
        { line: 5, featureType: 'line', occurrence: 0, role: 'end' },
        { line: 5, featureType: 'line', occurrence: 1, role: 'start' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`coincident(lines[0].end(), lines[1].start());`);
    expect(result.newCode.match(/const lines = \[\];/g)).toHaveLength(1);
  });

  it('composes .ref(i) on a loop-instance reference target', async () => {
    const projected = [
      `import { sketch, line, project } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const l = line([0, 0], [50, 0]);`,
      `  for (const s of sels) {`,
      `    project(s);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(projected, {
      sketchLine: 3,
      kind: 'tangent',
      targets: [
        { line: 6, featureType: 'project', refIndex: 0, occurrence: 1 },
        { line: 4, featureType: 'line' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const projects = [];`);
    expect(result.newCode).toContain(`    projects.push(project(s));`);
    expect(result.newCode).toContain(`tangent(projects[1].ref(0), l);`);
  });

  it('nested loops hoist the collector before the OUTERMOST loop', async () => {
    const nested = [
      `import { sketch, line } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  for (let i = 0; i < 2; i++) {`,
      `    for (let j = 0; j < 2; j++) {`,
      `      line([i * 10, j * 10], [i * 10 + 5, j * 10]);`,
      `    }`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(nested, {
      sketchLine: 3,
      kind: 'horizontal',
      targets: [{ line: 6, featureType: 'line', occurrence: 3 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const lines = [];`,
      `  for (let i = 0; i < 2; i++) {`,
      `    for (let j = 0; j < 2; j++) {`,
      `      lines.push(line([i * 10, j * 10], [i * 10 + 5, j * 10]));`,
      `    }`,
      `  }`,
      `  horizontal(lines[3]);`,
    ].join('\n'));
  });

  it('an occurrence-absent target inside a loop still takes the array rail (index 0)', async () => {
    // The old const-inside-the-loop hoist would be out of scope at the
    // constraint row — the collector rail applies even without an occurrence.
    const result = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'horizontal',
      targets: [{ line: 5, featureType: 'line' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`lines.push(line([i * 10, 0], [i * 10, 20]));`);
    expect(result.newCode).toContain(`horizontal(lines[0]);`);
    expect(result.newCode).not.toContain('const l1');
  });

  it('refuses malformed occurrences (negative, non-integer, or on a datum)', async () => {
    const negative = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'horizontal',
      targets: [{ line: 5, occurrence: -1 }],
    });
    expect(negative.error).toContain(`invalid target occurrence '-1'`);

    const fractional = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'horizontal',
      targets: [{ line: 5, occurrence: 1.5 }],
    });
    expect(fractional.error).toContain(`invalid target occurrence '1.5'`);

    const onDatum = await applySketchConstraint(LOOP_SKETCH, {
      sketchLine: 3,
      kind: 'fix',
      targets: [{ datum: 'origin', occurrence: 1 } as any],
    });
    expect(onDatum.error).toContain('composes only with a line target');
  });

  it('a loop transform composes with new geometry in one emission (row math holds)', async () => {
    const result = await applySolvedEmission(LOOP_SKETCH, {
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([0, 30], [50, 30])' }],
      constraints: [{
        kind: 'parallel',
        targets: [
          { newIndex: 0 },
          { line: 5, featureType: 'line', occurrence: 2 },
        ],
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `sketch('xy', () => {`,
      `  const lines = [];`,
      `  for (let i = 0; i < 5; i++) {`,
      `    lines.push(line([i * 10, 0], [i * 10, 20]));`,
      `  }`,
      `  const l1 = line([0, 30], [50, 30]);`,
      `  parallel(l1, lines[2]);`,
      `});`,
    ].join('\n'));
    // The collector hoist added a row INSIDE the sketch; the constraints
    // import added one above it — the reported lines must reflect both.
    expect(result.geometryLines).toEqual([9]);
    expect(result.sketchLine).toBe(4);
  });
});

// Copy-instance constraint targeting: a 2D copy() duplicate is a solver
// entity reached through the slot-indexed accessor — targets carry an
// `instanceIndex` and render `cp.instance(k)` (roles compose on top). The
// copy statement lives in the derived-ops tail, so a constraint referencing
// it lands AFTER the copy row (the placement amendment) — a TDZ
// ReferenceError otherwise — while non-copy emissions keep the normal
// geometry → constraints → derived-ops policy byte-identical.
describe('applySketchConstraint (copy instances)', () => {
  const COPY_SKETCH = [
    `import { sketch, line, copy } from "fluidcad/core";`,
    `import { horizontal } from "fluidcad/constraints";`,
    ``,
    `sketch('xy', () => {`,
    `  const a = line([0, 0], [100, 0]);`,
    `  line([100, 0], [100, 50]);`,
    `  horizontal(a);`,
    `  copy('linear', [0, 1], { count: 3, distance: 20 }, a);`,
    `  fillet(5);`,
    `});`,
  ].join('\n');

  it('hoists an unbound copy statement to `cp` and emits AFTER the copy row', async () => {
    const result = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'parallel',
      targets: [
        { line: 8, featureType: 'copy', instanceIndex: 2 },
        { line: 6, featureType: 'line' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l1 = line([100, 0], [100, 50]);`);
    // Between the copy and the next derived op — NOT in the constraints
    // region (that would reference cp1 before its const exists).
    expect(result.newCode).toContain([
      `  const cp1 = copy('linear', [0, 1], { count: 3, distance: 20 }, a);`,
      `  parallel(cp1.instance(2), l1);`,
      `  fillet(5);`,
    ].join('\n'));
  });

  it('reuses an existing copy binding', async () => {
    const bound = COPY_SKETCH.replace(`  copy(`, `  const dup = copy(`);
    const result = await applySketchConstraint(bound, {
      sketchLine: 4,
      kind: 'parallel',
      targets: [
        { line: 8, featureType: 'copy', instanceIndex: 2 },
        { line: 6, featureType: 'line' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`parallel(dup.instance(2), l1);`);
    expect(result.newCode).not.toContain('const cp1');
  });

  it('composes point roles on copy-instance refs', async () => {
    const result = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'distance',
      targets: [
        { line: 8, featureType: 'copy', instanceIndex: 1, role: 'start' },
        { line: 5, featureType: 'line', role: 'end' },
      ],
      valueExpr: '25',
      axis: 'x',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const cp1 = copy('linear', [0, 1], { count: 3, distance: 20 }, a);`,
      `  distance(cp1.instance(1).start(), a.end(), 25, 'x');`,
    ].join('\n'));
  });

  it('a constraint with NO copy target keeps the normal constraints-region placement', async () => {
    const result = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'vertical',
      targets: [{ line: 6, featureType: 'line' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  horizontal(a);`,
      `  vertical(l1);`,
      `  copy('linear', [0, 1], { count: 3, distance: 20 }, a);`,
    ].join('\n'));
  });

  it('a copy inside a user loop rides the collector rail — `copies` plural, after the LOOP', async () => {
    const loopCopy = [
      `import { sketch, line, copy } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  for (let i = 0; i < 2; i++) {`,
      `    copy('linear', [0, 1], { count: 2, distance: 10 + i * 5 }, a);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(loopCopy, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 6, featureType: 'copy', instanceIndex: 0, occurrence: 1 },
        { line: 4, featureType: 'line' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const copies = [];`,
      `  for (let i = 0; i < 2; i++) {`,
      `    copies.push(copy('linear', [0, 1], { count: 2, distance: 10 + i * 5 }, a));`,
      `  }`,
      `  parallel(copies[1].instance(0), a);`,
      `});`,
    ].join('\n'));
  });

  it('REGRESSION: a co-referenced entity BELOW the copy anchors the constraint too (TDZ on the hoisted const otherwise)', async () => {
    // E2E repro: the copy target's anchor alone put the constraint after the
    // copy() but BEFORE the hoisted `const l1 = line(…)` it references —
    // "Cannot access 'l1' before initialization". Every line-addressed
    // target anchors now, so the constraint lands after the LAST of them.
    const repro = [
      `import { sketch, line, copy } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const src = line([0, 0], [40, 10]);`,
      `  const cp1 = copy('linear', 'x', { count: 3, offset: 60 }, src);`,
      `  line([0, 60], [40, 90]);`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(repro, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 5, featureType: 'copy', instanceIndex: 2 },
        { line: 6, featureType: 'line' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const cp1 = copy('linear', 'x', { count: 3, offset: 60 }, src);`,
      `  const l1 = line([0, 60], [40, 90]);`,
      `  parallel(cp1.instance(2), l1);`,
      `});`,
    ].join('\n'));
  });

  it('REGRESSION: a copy-free constraint referencing a statement below the constraints region lands after its hoist', async () => {
    // Same latent TDZ without any copy involved: legal hand-written sketches
    // can park entity statements in the derived-ops tail.
    const lateLine = [
      `import { sketch, line } from "fluidcad/core";`,
      `import { horizontal } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [100, 0]);`,
      `  horizontal(a);`,
      `  fillet(5);`,
      `  line([0, 60], [40, 90]);`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(lateLine, {
      sketchLine: 4,
      kind: 'vertical',
      targets: [{ line: 8, featureType: 'line' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const l1 = line([0, 60], [40, 90]);`,
      `  vertical(l1);`,
      `});`,
    ].join('\n'));
    expect(result.newCode).not.toContain(`vertical(l1);\n  fillet(5);`);
  });

  it('REGRESSION: a loop-rail target below a copy target wins the anchor race — the constraint lands after the LOOP', async () => {
    const mixed = [
      `import { sketch, line, copy } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const src = line([0, 0], [40, 0]);`,
      `  const cp1 = copy('linear', 'x', { count: 2, offset: 50 }, src);`,
      `  for (let i = 0; i < 3; i++) {`,
      `    line([i * 10, 60], [i * 10 + 5, 90]);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applySketchConstraint(mixed, {
      sketchLine: 3,
      kind: 'parallel',
      targets: [
        { line: 5, featureType: 'copy', instanceIndex: 1 },
        { line: 7, featureType: 'line', occurrence: 2 },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const cp1 = copy('linear', 'x', { count: 2, offset: 50 }, src);`,
      `  const lines = [];`,
      `  for (let i = 0; i < 3; i++) {`,
      `    lines.push(line([i * 10, 60], [i * 10 + 5, 90]));`,
      `  }`,
      `  parallel(cp1.instance(1), lines[2]);`,
      `});`,
    ].join('\n'));
  });

  it('refuses malformed copy-instance targets', async () => {
    const onLine = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 6, featureType: 'copy', instanceIndex: 1 }],
    });
    expect(onLine.error).toContain('line 6 is not a 2D copy() statement');
    expect(onLine.newCode).toBe(COPY_SKETCH);

    const wrongType = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8, featureType: 'line', instanceIndex: 1 }],
    });
    expect(wrongType.error).toContain(`a target instanceIndex requires featureType 'copy'`);

    const withRef = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8, featureType: 'copy', instanceIndex: 1, refIndex: 0 } as any],
    });
    expect(withRef.error).toContain('a copy-instance target takes no refIndex');

    const negative = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8, featureType: 'copy', instanceIndex: -1 }],
    });
    expect(negative.error).toContain(`invalid target instanceIndex '-1'`);

    const fractional = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8, featureType: 'copy', instanceIndex: 1.5 }],
    });
    expect(fractional.error).toContain(`invalid target instanceIndex '1.5'`);

    // The wire allows a copy featureType with no instanceIndex (the UI
    // never sends it) — the copy() statement itself is no solver entity.
    const noIndex = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'horizontal',
      targets: [{ line: 8, featureType: 'copy' }],
    });
    expect(noIndex.error).toContain('pick a specific instance');

    const onDatum = await applySketchConstraint(COPY_SKETCH, {
      sketchLine: 4,
      kind: 'fix',
      targets: [{ datum: 'origin', instanceIndex: 1 } as any],
    });
    expect(onDatum.error).toContain('composes only with a line target');
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
    `});`,
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
