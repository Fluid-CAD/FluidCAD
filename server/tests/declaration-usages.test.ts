// The reads other files make of one `param()` or `property()` declaration —
// `insert()` overrides by label, `.properties.<name>` off the definition or
// an instance of it, and an imported top-level variable — and the two
// rewrites the parameters panel needs of them: following a rename, and
// standing the declaration's value in for them when it goes.

import { describe, it, expect } from 'vitest';
import { DeclarationUsages, type DeclarationRef } from '../src/declaration-usages.ts';

const PLATE_WIDTH: DeclarationRef = {
  kind: 'param',
  key: 'Width',
  filePath: '/ws/parts/plate.part.js',
  variable: 'width',
  variableExport: null,
  definition: { localName: 'plate', exportName: 'plate' },
};

const POCKET: DeclarationRef = {
  kind: 'property',
  key: 'pocketDiameter',
  filePath: '/ws/parts/housing.part.js',
  variable: null,
  variableExport: null,
  definition: { localName: 'housing', exportName: 'housing' },
};

const SHARED_WIDTH: DeclarationRef = {
  kind: 'param',
  key: 'Width',
  filePath: '/ws/shared.fluid.js',
  variable: 'width',
  variableExport: 'width',
  definition: null,
};

const ASSEMBLY = '/ws/frame.assembly.js';

const OVERRIDES = [
  `import { assembly, insert } from 'fluidcad/core';`,
  `import { plate } from './parts/plate.part.js';`,
  `import { plate as other } from './other/plate.part';`,
  ``,
  `const a = insert(plate, { Width: 120, Depth: 40 }).grounded();`,
  `insert(plate, { 'Width': 60 });`,
  `insert(plate, { Width });`,
  `insert(other, { Width: 1 });`,
  ``,
].join('\n');

describe('DeclarationUsages — insert() overrides of a parameter', () => {
  it('finds the entries keyed by the label on inserts of the definition, however the key is spelled', async () => {
    const usages = await DeclarationUsages.of(OVERRIDES, ASSEMBLY, PLATE_WIDTH);
    const sites = usages.sites();
    expect(sites.map((s) => s.kind)).toEqual(['override', 'override', 'override']);
    expect(sites.map((s) => s.kind === 'override' && s.entry.startPosition.row + 1)).toEqual([5, 6, 7]);
  });

  it('renames the key, quoting a label that is no identifier, and expands a shorthand', async () => {
    const result = await DeclarationUsages.apply(OVERRIDES, ASSEMBLY, {
      action: 'rename', declaration: PLATE_WIDTH, newKey: 'Overall width', newVariable: 'overallWidth', newVariableExport: null,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`insert(plate, { 'Overall width': 120, Depth: 40 }).grounded();`);
    expect(result.newCode).toContain(`insert(plate, { 'Overall width': 60 });`);
    expect(result.newCode).toContain(`insert(plate, { 'Overall width': Width });`);
    expect(result.newCode).toContain(`insert(other, { Width: 1 });`);
  });

  it('drops the entries on a delete, the whole argument when it empties', async () => {
    const result = await DeclarationUsages.apply(OVERRIDES, ASSEMBLY, {
      action: 'inline', declaration: PLATE_WIDTH, expression: '100', portable: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const a = insert(plate, { Depth: 40 }).grounded();`);
    expect(result.newCode).toContain(`insert(plate);\ninsert(plate);\ninsert(other, { Width: 1 });`);
  });

  it('drops overrides even when the default cannot travel — nothing is inlined for them', async () => {
    const result = await DeclarationUsages.apply(OVERRIDES, ASSEMBLY, {
      action: 'inline', declaration: PLATE_WIDTH, expression: 'base * 2', portable: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).not.toContain('Width: 120');
  });

  it('leaves a file that imports the definition from somewhere else alone', async () => {
    const elsewhere = OVERRIDES.replace(`./parts/plate.part.js`, `./plate.part.js`);
    const usages = await DeclarationUsages.of(elsewhere, ASSEMBLY, PLATE_WIDTH);
    expect(usages.sites()).toEqual([]);
  });
});

const READS = [
  `import { assembly, insert, extrude } from 'fluidcad/core';`,
  `import { housing } from './parts/housing.part.js';`,
  `import { plate } from './parts/plate.part.js';`,
  ``,
  `const wide = insert(housing, { Width: 100 }).grounded();`,
  `insert(plate, { Width: wide.properties.pocketDiameter - 0.4 });`,
  `const gap = housing.properties.pocketDiameter;`,
  `extrude(wide.instance(2).properties.pocketDiameter * 2);`,
  `const p = insert(plate); p.properties.pocketDiameter;`,
  ``,
].join('\n');

describe('DeclarationUsages — .properties reads of a property', () => {
  it('finds reads off the definition and off instances of it, not off another part', async () => {
    const usages = await DeclarationUsages.of(READS, ASSEMBLY, POCKET);
    expect(usages.sites().map((s) => s.kind === 'read' && s.member.startPosition.row + 1)).toEqual([6, 7, 8]);
  });

  it('renames the property in every read', async () => {
    const result = await DeclarationUsages.apply(READS, ASSEMBLY, {
      action: 'rename', declaration: POCKET, newKey: 'pocketDia', newVariable: null, newVariableExport: null,
    });
    expect(result.newCode).toContain(`insert(plate, { Width: wide.properties.pocketDia - 0.4 });`);
    expect(result.newCode).toContain(`const gap = housing.properties.pocketDia;`);
    expect(result.newCode).toContain(`extrude(wide.instance(2).properties.pocketDia * 2);`);
    expect(result.newCode).toContain(`p.properties.pocketDiameter;`);
  });

  it('stands a portable value in for every read, parenthesized where an operator would bind into it', async () => {
    const result = await DeclarationUsages.apply(READS, ASSEMBLY, {
      action: 'inline', declaration: POCKET, expression: '92 - 8', portable: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`insert(plate, { Width: (92 - 8) - 0.4 });`);
    expect(result.newCode).toContain(`const gap = 92 - 8;`);
    expect(result.newCode).toContain(`extrude((92 - 8) * 2);`);
  });

  it('refuses to inline a value that only means something in its own file, naming the reads', async () => {
    const result = await DeclarationUsages.apply(READS, ASSEMBLY, {
      action: 'inline', declaration: POCKET, expression: 'width - 2 * wall', portable: false,
    });
    expect(result.error).toContain('only means something in its own file');
    expect(result.error).toContain('lines 6, 7, 8');
    expect(result.newCode).toBe(READS);
  });
});

const IMPORTED = [
  `import { part, extrude } from 'fluidcad/core';`,
  `import { width, depth } from './shared.fluid.js';`,
  ``,
  `export const p = part('P', () => {`,
  `  extrude(width + depth);`,
  `  const dims = { width };`,
  `});`,
  ``,
].join('\n');

describe('DeclarationUsages — an imported top-level variable', () => {
  it('renames the specifier and every read of its local name', async () => {
    const result = await DeclarationUsages.apply(IMPORTED, ASSEMBLY, {
      action: 'rename', declaration: SHARED_WIDTH, newKey: 'Span', newVariable: 'span', newVariableExport: 'span',
    });
    expect(result.newCode).toContain(`import { span, depth } from './shared.fluid.js';`);
    expect(result.newCode).toContain(`extrude(span + depth);`);
    expect(result.newCode).toContain(`const dims = { width: span };`);
  });

  it('keeps an aliased import, and a local name the file already uses, by aliasing the new export', async () => {
    const aliased = IMPORTED.replace(`import { width, depth }`, `import { width as w, depth }`)
      .replace(`extrude(width + depth)`, `extrude(w + depth)`).replace(`{ width }`, `{ w }`);
    const kept = await DeclarationUsages.apply(aliased, ASSEMBLY, {
      action: 'rename', declaration: SHARED_WIDTH, newKey: 'Span', newVariable: 'span', newVariableExport: 'span',
    });
    expect(kept.newCode).toContain(`import { span as w, depth } from './shared.fluid.js';`);
    expect(kept.newCode).toContain(`extrude(w + depth);`);

    const taken = IMPORTED.replace(`  extrude(width + depth);`, `  const span = 1;\n  extrude(width + depth + span);`);
    const result = await DeclarationUsages.apply(taken, ASSEMBLY, {
      action: 'rename', declaration: SHARED_WIDTH, newKey: 'Span', newVariable: 'span', newVariableExport: 'span',
    });
    expect(result.newCode).toContain(`import { span as width, depth } from './shared.fluid.js';`);
    expect(result.newCode).toContain(`extrude(width + depth + span);`);
  });

  it('inlines the value and drops the specifier — the whole import when it was alone', async () => {
    const result = await DeclarationUsages.apply(IMPORTED, ASSEMBLY, {
      action: 'inline', declaration: SHARED_WIDTH, expression: '100', portable: true,
    });
    expect(result.newCode).toContain(`import { depth } from './shared.fluid.js';`);
    expect(result.newCode).toContain(`extrude(100 + depth);`);
    expect(result.newCode).toContain(`const dims = { width: 100 };`);

    const alone = IMPORTED.replace(`import { width, depth }`, `import { width }`).replace(`width + depth`, `width`);
    const gone = await DeclarationUsages.apply(alone, ASSEMBLY, {
      action: 'inline', declaration: SHARED_WIDTH, expression: '100', portable: true,
    });
    expect(gone.newCode).toBe([
      `import { part, extrude } from 'fluidcad/core';`,
      ``,
      `export const p = part('P', () => {`,
      `  extrude(100);`,
      `  const dims = { width: 100 };`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('drops the braces of a sole named specifier beside a default import', async () => {
    const withDefault = IMPORTED.replace(`import { width, depth }`, `import shared, { width }`).replace(`width + depth`, `width + shared.depth`);
    const result = await DeclarationUsages.apply(withDefault, ASSEMBLY, {
      action: 'inline', declaration: SHARED_WIDTH, expression: '100', portable: true,
    });
    expect(result.newCode).toContain(`import shared from './shared.fluid.js';`);
    expect(result.newCode).toContain(`extrude(100 + shared.depth);`);
  });

  it('parenthesizes a compound value used as an object or a callee, never as an index', async () => {
    const shapes = IMPORTED.replace(`  extrude(width + depth);`, `  extrude(width[0] + arr[width] + width.toFixed(1));`);
    const result = await DeclarationUsages.apply(shapes, ASSEMBLY, {
      action: 'inline', declaration: SHARED_WIDTH, expression: 'a + b', portable: true,
    });
    expect(result.newCode).toContain(`extrude((a + b)[0] + arr[a + b] + (a + b).toFixed(1));`);
  });

  it('does not touch a same-named import from another module, or a shadowing local', async () => {
    const shadowed = IMPORTED.replace(`  const dims = { width };`, `  const inner = (width) => width * 2;`);
    const result = await DeclarationUsages.apply(shadowed, ASSEMBLY, {
      action: 'inline', declaration: SHARED_WIDTH, expression: '100', portable: true,
    });
    expect(result.newCode).toContain(`extrude(100 + depth);`);
    expect(result.newCode).toContain(`const inner = (width) => width * 2;`);
  });
});
