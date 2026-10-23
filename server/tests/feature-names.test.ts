// Feature names (plan: shape-naming-and-lineage, stage B). The create path
// writes `.name('<DisplayType> <n>')` on every statement it emits, n past
// the highest such name the file holds; the display type per callee is the
// lib's own; dialog edits leave the chain alone; and a file written without
// any names renders with the same numbered labels and no warning.

import { describe, it, expect } from 'vitest';
import { FeatureNames } from '../src/feature-names.ts';
import { DISPLAY_TYPE_BY_CALLEE } from '../src/apply-feature-edit/parse/parsed-statement.ts';
import { getJavaScriptParser, splitLines } from '../src/code-editor/index.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';
import { applyInsertPartEdit } from '../src/part-catalog/insert-edit.ts';
import { PartPropertiesAggregator } from '../src/fluidcad-server/part-properties.ts';
import { setupOC, render } from '../../lib/tests/setup.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import cut from '../../lib/core/cut.js';
import { circle } from '../../lib/core/2d/index.js';
import { Extrude } from '../../lib/features/extrude.js';
import { Rib } from '../../lib/features/rib.js';
import { Hole } from '../../lib/features/hole/hole.js';
import { Sweep } from '../../lib/features/sweep.js';
import { Loft } from '../../lib/features/loft.js';
import { Shell } from '../../lib/features/shell.js';
import { Fillet } from '../../lib/features/fillet.js';
import { Chamfer } from '../../lib/features/chamfer.js';
import { Revolve } from '../../lib/features/revolve.js';
import { Text } from '../../lib/features/2d/text.js';
import { Wrap } from '../../lib/features/wrap.js';
import { Sketch } from '../../lib/features/2d/sketch.js';
import { RepeatLinear } from '../../lib/features/repeat-linear.js';
import { RepeatCircular } from '../../lib/features/repeat-circular.js';
import { RepeatMatrix } from '../../lib/features/repeat-matrix.js';
import { MirrorFeature } from '../../lib/features/mirror-feature.js';
import { CopyLinear } from '../../lib/features/copy-linear.js';
import { CopyCircular } from '../../lib/features/copy-circular.js';
import { CopyPattern } from '../../lib/features/copy-pattern.js';
import { MirrorShape } from '../../lib/features/mirror-shape.js';
import { Rotate } from '../../lib/features/rotate.js';
import { Translate } from '../../lib/features/translate.js';
import { Split } from '../../lib/features/split.js';
import { Fuse } from '../../lib/features/fuse.js';
import { Subtract } from '../../lib/features/subtract.js';
import { Common } from '../../lib/features/common.js';
import { Helix } from '../../lib/features/helix.js';
import { PlaneObject } from '../../lib/features/plane.js';
import { AxisObject } from '../../lib/features/axis.js';

async function parse(code: string) {
  const parser = await getJavaScriptParser();
  return { tree: parser.parse(code), lines: splitLines(code) };
}

/** The lib's label for a class, without running its constructor — `getDisplayType()` reads nothing an instance holds (bar the extrude's op mode). */
function libDisplayType(cls: { prototype: unknown }, fields: Record<string, unknown> = {}): string {
  const bare = Object.assign(Object.create(cls.prototype as object), fields);
  return bare.getDisplayType();
}

function createSpec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'fillet',
    value: 3,
    filePath: '/ws/model.fluid.js',
    producers: [{ line: 4, column: 0, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: [2], filterArgs: null }],
    imports: [],
    ...overrides,
  };
}

function editSpec(
  feature: ApplyFeatureEditSpec['feature'],
  edit: NonNullable<ApplyFeatureEditSpec['edit']>,
  overrides: Partial<ApplyFeatureEditSpec> = {},
): ApplyFeatureEditSpec {
  return { feature, filePath: '/ws/model.fluid.js', producers: [], parts: [], imports: [], edit, ...overrides };
}

describe('DISPLAY_TYPE_BY_CALLEE', () => {
  it('matches the lib getDisplayType() of every callee the create path names', () => {
    // Every class a callee of the table builds; a callee with several
    // classes (repeat, copy) lists them all — they must agree.
    const classes: Record<string, { cls: { prototype: unknown }; fields?: Record<string, unknown> }[]> = {
      extrude: [{ cls: Extrude }],
      cut: [{ cls: Extrude, fields: { _operationMode: 'remove' } }],
      rib: [{ cls: Rib }],
      hole: [{ cls: Hole }],
      sweep: [{ cls: Sweep }],
      loft: [{ cls: Loft }],
      shell: [{ cls: Shell }],
      fillet: [{ cls: Fillet }],
      chamfer: [{ cls: Chamfer }],
      revolve: [{ cls: Revolve }],
      text: [{ cls: Text }],
      wrap: [{ cls: Wrap }],
      sketch: [{ cls: Sketch }],
      repeat: [{ cls: RepeatLinear }, { cls: RepeatCircular }, { cls: RepeatMatrix }, { cls: MirrorFeature }],
      copy: [{ cls: CopyLinear }, { cls: CopyCircular }, { cls: CopyPattern }],
      mirror: [{ cls: MirrorShape }],
      rotate: [{ cls: Rotate }],
      translate: [{ cls: Translate }],
      split: [{ cls: Split }],
      fuse: [{ cls: Fuse }],
      subtract: [{ cls: Subtract }],
      common: [{ cls: Common }],
      helix: [{ cls: Helix }],
      plane: [{ cls: PlaneObject }],
      axis: [{ cls: AxisObject }],
    };
    expect(Object.keys(classes).sort()).toEqual(Object.keys(DISPLAY_TYPE_BY_CALLEE).sort());
    for (const [callee, list] of Object.entries(classes)) {
      for (const { cls, fields } of list) {
        expect(libDisplayType(cls, fields), callee).toBe(DISPLAY_TYPE_BY_CALLEE[callee]);
      }
    }
  });
});

describe('FeatureNames', () => {
  it('collects .name() literals and part() first arguments with their line and callee', async () => {
    const { tree } = await parse([
      `import { sketch, extrude, part } from 'fluidcad/core'`,
      `sketch('xy', () => {`,
      `  circle([0, 0], 5)`,
      `}).name('Sketch 1')`,
      `const e = extrude(10).drill(false).name('Boss')`,
      `export const body = part('Body', () => {`,
      `  extrude(2).name("Extrude 2")`,
      `}).material('steel')`,
      `extrude(label)`,
    ].join('\n'));
    expect(FeatureNames.collect(tree)).toEqual([
      { name: 'Sketch 1', line: 2, callee: 'sketch' },
      { name: 'Boss', line: 5, callee: 'extrude' },
      { name: 'Body', line: 6, callee: 'part' },
      { name: 'Extrude 2', line: 7, callee: 'extrude' },
    ]);
  });

  it('allocates one past the highest number, never a freed one', async () => {
    const { tree } = await parse(`extrude(1).name('Extrude 1')\nextrude(3).name('Extrude 3')\nextrude(2)\n`);
    expect(FeatureNames.allocate(tree, 'Extrude')).toBe('Extrude 4');
    expect(FeatureNames.allocate(tree, 'Sketch')).toBe('Sketch 1');
  });

  it('counts only whole "<Type> <n>" names of that type', async () => {
    const { tree } = await parse(`extrude(1).name('Extrude 7 top')\ncut(1).name('Cut 2')\npart('Extrude 5', () => {})\n`);
    expect(FeatureNames.allocate(tree, 'Extrude')).toBe('Extrude 6');
    expect(FeatureNames.allocate(tree, 'Cut')).toBe('Cut 3');
  });

  it('reports the statement already holding a name, but not the renamed statement itself', async () => {
    const code = `extrude(1).name('Boss')\nexport const p = part('Lid', () => {})\nextrude(2).name('Rim')\n`;
    const { tree, lines } = await parse(code);
    expect(FeatureNames.conflict(tree, lines, 'Boss', 3)).toEqual({ name: 'Boss', line: 1, callee: 'extrude' });
    expect(FeatureNames.conflict(tree, lines, 'Lid', 3)).toEqual({ name: 'Lid', line: 2, callee: 'part' });
    expect(FeatureNames.conflict(tree, lines, 'Rim', 3)).toBeNull();
    expect(FeatureNames.conflict(tree, lines, 'Flange', 3)).toBeNull();
    expect(await FeatureNames.conflictIn(code, 'Boss', 1)).toBeNull();
    expect(FeatureNames.conflictMessage('Boss', { name: 'Boss', line: 1, callee: 'extrude' }))
      .toBe(`'Boss' is already the name of the extrude at line 1`);
  });

  it('names a statement by its callee, and nothing inside a sketch body or without a display type', async () => {
    const code = `sketch('xy', () => {\n  circle([0, 0], 5)\n})\nextrude(2)\n`;
    const { tree } = await parse(code);
    expect(FeatureNames.chainFor(tree, 'extrude')).toBe(`.name('Extrude 1')`);
    expect(FeatureNames.chainFor(tree, 'fillet', code.length)).toBe(`.name('Fillet 1')`);
    expect(FeatureNames.chainFor(tree, 'fillet', code.indexOf('  circle'))).toBe('');
    expect(FeatureNames.chainFor(tree, 'part')).toBe('');
    expect(FeatureNames.chainFor(tree, 'section')).toBe('');
    expect(FeatureNames.chainFor(tree, 'connector')).toBe('');
    expect(FeatureNames.chainFor(tree, 'offset')).toBe('');
  });

  it('normalizes a typed name to one line', () => {
    expect(FeatureNames.normalize("  Bob's\n boss  ")).toBe("Bob's boss");
    expect(FeatureNames.normalize(null)).toBe('');
    expect(FeatureNames.normalize('   ')).toBe('');
  });
});

describe('the create path writes the name', () => {
  it('ends a created extrude with .name(\'Extrude 1\')', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, createSpec({
      feature: 'extrude', value: undefined, parts: [],
      producers: [{ line: 3, column: 0, featureType: 'sketch', nameHint: 's', bind: false }],
      extrude: { op: 'add', distance: 25, distance2: null, symmetric: false, draft: null, endOffset: null, drill: true, thin: null },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xy', () => { ellipse(100, 50) })\nextrude(25).name('Extrude 1')\n`);
  });

  it('numbers a created statement past the names the file holds, not the rows it has', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `fillet(1, e.startEdges()).name('Fillet 4')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, createSpec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(3, e.endEdges(2)).name('Fillet 5')`);
  });

  it('names a created sketch after its callback, and a new part\'s first sketch inside the part', async () => {
    const empty = await applyFeatureEdit('', createSpec({ feature: 'sketch', value: undefined, producers: [], parts: [], sketchPlane: 'xy' }));
    expect(empty.error).toBeUndefined();
    expect(empty.newCode).toBe(`import { sketch } from 'fluidcad/core';\nsketch('xy', () => {\n\n}).name('Sketch 1');\n`);

    const part = await applyFeatureEdit(
      `import { sketch, part } from 'fluidcad/core'\n\nsketch('xz', () => {}).name('Sketch 1')\nexport const part1 = part('Part 1', () => {\n\n})\n`,
      createSpec({ feature: 'sketch', value: undefined, producers: [], parts: [], sketchPlane: 'xy', activePart: { line: 4, column: 0 } }),
    );
    expect(part.error).toBeUndefined();
    expect(part.newCode).toContain(`export const part1 = part('Part 1', () => {\n  sketch('xy', () => {\n\n  }).name('Sketch 2')\n\n})`);
  });

  it('never names a part() or an insert() statement', async () => {
    const part = await applyFeatureEdit('', createSpec({ feature: 'sketch', value: undefined, producers: [], parts: [], newPart: {} }));
    expect(part.error).toBeUndefined();
    expect(part.newCode).toBe(`import { part } from 'fluidcad/core';\nexport const part1 = part('Part 1', () => {\n\n});\n`);

    const inserted = await applyInsertPartEdit(`import { insert } from 'fluidcad/core';\n`, {
      inserts: [{ importFrom: './box.fluid.js', exportName: 'boxBody', kind: 'value' }],
    });
    expect(inserted.error).toBeUndefined();
    expect(inserted.newCode).toContain(`insert(boxBody).name('boxBody1')`);
    expect(inserted.newCode.match(/\.name\(/g)).toHaveLength(1);
  });

  it('leaves a 2D fillet inside a sketch body unnamed', async () => {
    const code = [
      `import { sketch, circle, line, point } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  circle([0, 0], 80)`,
      `  line([0, 0], [135, 30])`,
      `})`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, createSpec({
      value: 4,
      producers: [
        { line: 4, column: 0, featureType: 'circle', nameHint: 'r', bind: true },
        { line: 5, column: 0, featureType: 'line', nameHint: 'l', bind: true },
      ],
      parts: [
        { producer: 0, accessor: 'edge', indices: null, filterArgs: "'top'" },
        { producer: 1, accessor: '', indices: null, filterArgs: null },
      ],
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`  fillet(4, r.edge('top'), l)\n})`);
    expect(result.newCode).not.toContain('.name(');
  });
});

describe('dialog edits keep the .name() chain', () => {
  it('on an extrude', async () => {
    const code = [
      `import { sketch, ellipse, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `extrude(30).name('Extrude 1')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('extrude', {
      line: 4, column: 0,
      extrude: { op: 'add', distance: 45, distance2: null, symmetric: false, draft: null, endOffset: null, drill: true, thin: null },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`extrude(45).name('Extrude 1')\n`);
  });

  it('on a fillet', async () => {
    const code = [
      `import { sketch, ellipse, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30).name('Extrude 1')`,
      `fillet(2, e.endEdges()).name('Fillet 1')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('fillet', { line: 5, column: 0 }, { value: 4 }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`fillet(4, e.endEdges()).name('Fillet 1')\n`);
  });

  it('on a repeat', async () => {
    const code = [
      `import { sketch, ellipse, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ellipse(100, 50) })`,
      `const e = extrude(30)`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, e).name('Repeat 1')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('repeat', {
      line: 5, column: 0,
      repeat: {
        kind: 'linear',
        spacingMode: 'length',
        directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 5, value: 120 }],
      },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`repeat('linear', 'x', { count: 5, length: 120 }, e).name('Repeat 1')\n`);
  });

  it('on a sketch retargeted to another plane', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  ellipse(100, 50)`,
      `}).name('Sketch 1')`,
      ``,
    ].join('\n');
    const result = await applyFeatureEdit(code, editSpec('sketch', {
      line: 3, column: 0,
      sketch: { target: { kind: 'standard', plane: 'xz' } },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sketch('xz', () => {\n  ellipse(100, 50)\n}).name('Sketch 1')\n`);
  });
});

describe('a file written without names', () => {
  setupOC();

  it('renders with "<Type> <n>" labels and no warning — what an MCP write_file gets', () => {
    sketch('xy', () => { circle([0, 0], 10); });
    extrude(5);
    sketch('xy', () => { circle([0, 0], 4); });
    cut(3);
    sketch('xz', () => { circle([0, 0], 2); });
    extrude(3);
    const rows = render().getRenderedObjects() as any[];

    expect(rows.filter(r => r.type === 'sketch').map(r => r.name)).toEqual(['Sketch 1', 'Sketch 2', 'Sketch 3']);
    expect(rows.filter(r => r.type === 'extrude').map(r => r.name)).toEqual(['Extrude 1', 'Extrude 2']);
    expect(rows.filter(r => r.type === 'cut').map(r => r.name)).toEqual(['Cut 1']);
    expect(rows.every(r => r.hasCustomName === undefined)).toBe(true);
    expect(rows.filter(r => r.hasError)).toEqual([]);
    expect(PartPropertiesAggregator.collectWarnings(rows, null)).toEqual([]);
  });
});
