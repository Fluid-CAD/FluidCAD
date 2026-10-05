import { describe, it, expect } from 'vitest';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';
import { RegionDeclarations } from '../src/apply-feature-edit/region-declarations.ts';
import { SketchEntityDelete } from '../src/sketch-entity-delete.ts';
import { RemoveFeature } from '../src/remove-feature.ts';

// Region declarations: a dialog's picks become `region('r1', …)` rows of the
// profile sketch and `.region('r1')` on the feature. The kernel never reads
// variable names — the server writes them, through the same binding rail
// the constraint toolbar uses.

const FILE = '/ws/model.fluid.js';

const SKETCH = [
  `import { sketch, circle, line, extrude } from 'fluidcad/core';`,
  ``,
  `const s = sketch('xy', () => {`,
  `  const a = circle([-20, 0], 80);`,
  `  circle([20, 0], 80);`,
  `  const l1 = line([0, -50], [0, 50]);`,
  `});`,
].join('\n');

function createSpec(regionPicks: ApplyFeatureEditSpec['extrude'] extends infer T ? (T extends { regionPicks?: infer P } ? P : never) : never): ApplyFeatureEditSpec {
  return {
    feature: 'extrude',
    filePath: FILE,
    producers: [{ line: 3, column: 10, featureType: 'sketch', nameHint: 's', bind: true }],
    parts: [],
    imports: [],
    extrude: {
      op: 'add', distance: 20, distance2: null, symmetric: false, draft: null, endOffset: null,
      drill: true, thin: null, profile: 'bound', regionPicks, regionSketch: { line: 3, column: 10 },
    },
  };
}

describe('RegionDeclarations — create', () => {
  it('declares a picked boundary in the sketch and names it on the statement', async () => {
    const result = await applyFeatureEdit(SKETCH, createSpec([
      { items: [{ line: 4, callee: 'circle', far: false }, { line: 5, callee: 'circle', far: false }] },
    ]));
    expect(result.error).toBeUndefined();
    const lines = result.newCode.split('\n');
    // The unbound circle was hoisted so the declaration can name it.
    expect(lines).toContain(`  const c1 = circle([20, 0], 80);`);
    expect(lines).toContain(`  region('r1', a, c1);`);
    expect(result.newCode).toContain(`extrude(20, s).region('r1')`);
    expect(lines[0]).toContain('region');
    expect(lines[0]).not.toContain('far');
    // The declaration is the last row of the body.
    expect(lines.indexOf(`  region('r1', a, c1);`)).toBe(lines.indexOf('});') - 1);
  });

  it('writes far() for the far side and imports it', async () => {
    const result = await applyFeatureEdit(SKETCH, createSpec([
      { items: [{ line: 4, callee: 'circle', far: false }, { line: 5, callee: 'circle', far: true }] },
      { items: [{ line: 4, callee: 'circle', far: true }, { line: 5, callee: 'circle', far: false }] },
    ]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  region('r1', a, far(c1));`);
    expect(result.newCode).toContain(`  region('r2', far(a), c1);`);
    expect(result.newCode).toContain(`extrude(20, s).region('r1', 'r2')`);
    expect(result.newCode.split('\n')[0]).toMatch(/import \{.*\bfar\b.*\} from 'fluidcad\/core'/);
  });

  it('reuses a declaration that already lists the boundary, and allocates past the highest r<n>', async () => {
    const code = SKETCH.replace(`  const l1 = line([0, -50], [0, 50]);\n`, `  const l1 = line([0, -50], [0, 50]);\n  region('r3', l1, a);\n  region('lens', a, c1);\n`)
      .replace(`  circle([20, 0], 80);`, `  const c1 = circle([20, 0], 80);`);
    const result = await applyFeatureEdit(code, createSpec([
      { items: [{ line: 5, callee: 'circle', far: false }, { line: 4, callee: 'circle', far: false }] },
      { items: [{ line: 5, callee: 'circle', far: false }] },
    ]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(20, s).region('lens', 'r4')`);
    expect(result.newCode).toContain(`  region('r4', c1);`);
    expect((result.newCode.match(/^  region\('lens'/gm) ?? []).length).toBe(1);
  });

  it('names a rect edge by its accessor and a projected edge by ref()', async () => {
    const code = [
      `import { sketch, project, extrude } from 'fluidcad/core';`,
      `import { rect } from 'fluidcad/shapes';`,
      ``,
      `const s = sketch('xy', () => {`,
      `  const r = rect([0, 0], 40, 20);`,
      `  const p = project(e.edges());`,
      `});`,
    ].join('\n');
    const result = await applyFeatureEdit(code, {
      ...createSpec([{ items: [
        { line: 5, callee: 'rect', edge: 'top', far: false },
        { line: 5, callee: 'rect', edge: 'corner2', far: true },
        { line: 6, callee: 'project', edge: 'e3', far: false },
      ] }]),
      producers: [{ line: 4, column: 10, featureType: 'sketch', nameHint: 's', bind: true }],
      extrude: { ...createSpec([]).extrude!, regionPicks: [{ items: [
        { line: 5, callee: 'rect', edge: 'top', far: false },
        { line: 5, callee: 'rect', edge: 'corner2', far: true },
        { line: 6, callee: 'project', edge: 'e3', far: false },
      ] }], regionSketch: { line: 4, column: 10 } },
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  region('r1', r.top(), far(r.corner(2)), p.ref(2));`);
  });

  it('binds a looped statement through a collector array', async () => {
    const code = [
      `import { sketch, circle, extrude } from 'fluidcad/core';`,
      ``,
      `const s = sketch('xy', () => {`,
      `  for (let i = 0; i < 3; i++) {`,
      `    circle([i * 30, 0], 10);`,
      `  }`,
      `});`,
    ].join('\n');
    const result = await applyFeatureEdit(code, createSpec([{ items: [{ line: 5, occurrence: 1, callee: 'circle', far: false }] }]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  const circles = [];`);
    expect(result.newCode).toContain(`    circles.push(circle([i * 30, 0], 10));`);
    expect(result.newCode).toContain(`  region('r1', circles[1]);`);
    expect(result.newCode).toContain(`extrude(20, s).region('r1')`);
  });

  it('refuses when the source moved under the picks', async () => {
    const result = await applyFeatureEdit(SKETCH, createSpec([{ items: [{ line: 6, callee: 'circle', far: false }] }]));
    expect(result.error).toContain('line 6 is a line() statement now');
    expect(result.newCode).toBe(SKETCH);
  });

  it('plans the names a preview shows without editing', async () => {
    const names = await RegionDeclarations.planNames(SKETCH, 3, [
      { items: [{ line: 4, callee: 'circle', far: false }] },
      { name: 'kept' },
    ]);
    expect(names).toEqual(['r1', 'kept']);
    expect(await RegionDeclarations.planNames(SKETCH, 3, [])).toEqual([]);
  });
});

describe('RegionDeclarations — edit', () => {
  const declared = [
    `import { sketch, circle, extrude, region, far } from 'fluidcad/core';`,
    ``,
    `const s = sketch('xy', () => {`,
    `  const a = circle([-20, 0], 80);`,
    `  const b = circle([20, 0], 80);`,
    `  region('lens', a, b);`,
    `  region('left', a, far(b));`,
    `  region('right', far(a), b);`,
    `});`,
    `extrude(20, s).region('lens', 'left')`,
    `extrude(5, s).region('right')`,
  ].join('\n');

  function editSpec(regionPicks: NonNullable<ApplyFeatureEditSpec['edit']>['extrude'] extends infer T ? (T extends { regionPicks?: infer P } ? P : never) : never, withSketch = true): ApplyFeatureEditSpec {
    return {
      feature: 'extrude',
      filePath: FILE,
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 10, column: 0,
        extrude: {
          op: 'add', distance: 20, distance2: null, symmetric: false, draft: null, endOffset: null,
          drill: true, thin: null, regionPicks, ...(withSketch ? { regionSketch: { line: 3, column: 10 } } : {}),
        },
      },
    };
  }

  it('keeps a name-only pick list that matches the chain without touching the sketch', async () => {
    const result = await applyFeatureEdit(declared, editSpec([{ name: 'lens' }, { name: 'left' }]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(declared);
  });

  it('drops the declarations the statement alone referenced when a pick goes', async () => {
    const result = await applyFeatureEdit(declared, editSpec([{ name: 'lens' }]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain(`region('left'`);
    expect(result.newCode).toContain(`  region('lens', a, b);`);
    expect(result.newCode).toContain(`extrude(20, s).region('lens')\n`);
    expect(result.newCode).toContain(`extrude(5, s).region('right')`);
  });

  it('keeps a declaration another statement still names', async () => {
    const result = await applyFeatureEdit(declared, editSpec([{ name: 'right' }]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  region('right', far(a), b);`);
    expect(result.newCode).not.toContain(`region('lens'`);
    expect(result.newCode).not.toContain(`region('left'`);
    expect(result.newCode).toContain(`extrude(20, s).region('right')\n`);
  });

  it('drops the chain and every declaration only it named on an empty list', async () => {
    const result = await applyFeatureEdit(declared, editSpec([]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(20, s)\n`);
    expect(result.newCode).not.toContain(`region('lens'`);
    expect(result.newCode).toContain(`region('right'`);
  });

  it('adds a newly picked boundary next to the kept names', async () => {
    const result = await applyFeatureEdit(declared, editSpec([
      { name: 'lens' },
      { items: [{ line: 4, callee: 'circle', far: false }] },
    ]));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  region('r1', a);`);
    expect(result.newCode).toContain(`extrude(20, s).region('lens', 'r1')`);
    expect(result.newCode).not.toContain(`region('left'`);
  });

  it('rewrites a name-only chain without the sketch when the profile is unknown', async () => {
    const result = await applyFeatureEdit(declared, editSpec([{ name: 'left' }], false));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(20, s).region('left')\n`);
    // Without the sketch the orphan cannot be pruned; nothing else changes.
    expect(result.newCode).toContain(`region('lens'`);
  });

  it('refuses a boundary pick without its sketch', async () => {
    const result = await applyFeatureEdit(declared, editSpec([{ items: [{ line: 4, callee: 'circle', far: false }] }], false));
    expect(result.error).toContain('need their profile sketch');
  });
});

describe('region declarations under other edits', () => {
  const code = [
    `import { sketch, circle, line, extrude, region, far } from 'fluidcad/core';`,
    ``,
    `const s = sketch('xy', () => {`,
    `  const a = circle([-20, 0], 80);`,
    `  const b = circle([20, 0], 80);`,
    `  const l1 = line([0, -50], [0, 50]);`,
    `  region('lens', a, b);`,
    `  region('half', a, far(l1));`,
    `  region('sliver', l1);`,
    `});`,
    `extrude(20, s).region('lens', 'half')`,
  ].join('\n');

  it('drops a deleted entity from its declarations and removes the ones left empty', async () => {
    const result = await SketchEntityDelete.apply(code, { sketchLine: 3, lines: [6] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  region('lens', a, b);`);
    expect(result.newCode).toContain(`  region('half', a);`);
    expect(result.newCode).not.toContain(`region('sliver'`);
    expect(result.newCode).not.toContain(`line([0, -50]`);
    expect(result.removed).toEqual([{ line: 9, kind: 'region' }]);
  });

  it('removes the declarations a removed feature alone named', async () => {
    const captured = await RemoveFeature.capture(code, 11);
    expect('error' in captured).toBe(false);
    const result = await RemoveFeature.apply(code, captured as { statement: { line: number; expectedText: string } });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain(`extrude(20, s)`);
    expect(result.newCode).not.toContain(`region('lens'`);
    expect(result.newCode).not.toContain(`region('half'`);
    // A hand-written declaration no statement named is not the removal's to take.
    expect(result.newCode).toContain(`  region('sliver', l1);`);
  });

  it('prunes only unreferenced names', async () => {
    const pruned = await RegionDeclarations.pruneUnreferenced(code, ['lens', 'sliver']);
    expect(pruned).toContain(`region('lens'`);
    expect(pruned).not.toContain(`region('sliver'`);
  });
});
