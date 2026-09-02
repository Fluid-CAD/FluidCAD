import { describe, it, expect } from 'vitest';
import { applyInsertPartEdit } from '../src/part-catalog/insert-edit.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';
import { newFileContent } from '../src/file-kind.ts';

/** Single-entry sugar — most cases exercise one insert. */
function one(entry: {
  importFrom: string | null;
  exportName: string;
  kind: 'value' | 'factory' | 'assembly';
  params?: Record<string, string | number | boolean | (string | number)[]>;
}) {
  return { inserts: [entry] };
}

describe('applyInsertPartEdit', () => {
  it('imports the part export and appends a bound insert statement', async () => {
    const code = [
      `import { insert, mate } from "fluidcad/core";`,
      ``,
      `const width = 700;`,
    ].join('\n');

    const result = await applyInsertPartEdit(code, one({
      importFrom: './side-plate.part.js',
      exportName: 'sidePlate',
      kind: 'factory',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([
      `import { insert, mate } from "fluidcad/core";`,
      `import { sidePlate } from './side-plate.part.js';`,
      ``,
      `const width = 700;`,
      ``,
      `const sidePlate1 = insert(sidePlate());`,
    ].join('\n'));
  });

  it('renders a direct part export without a call', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, one({
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    }));
    expect(result.newCode).toContain(`import { boxBody } from './box.fluid.js';`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });

  it('adds the insert import when missing', async () => {
    const code = `import { mate } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, one({
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    }));
    expect(result.newCode).toContain(`insert,`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });

  it('merges into an existing import of the same module', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      `import { RAIL_WIDTH } from './linear-guides.fluid.js';`,
      ``,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './linear-guides.fluid.js',
      exportName: 'getLinearGuides',
      kind: 'factory',
    }));
    const importLines = result.newCode.split('\n').filter(l => l.includes('linear-guides'));
    expect(importLines).toHaveLength(1);
    expect(importLines[0]).toContain('getLinearGuides');
    expect(importLines[0]).toContain('RAIL_WIDTH');
  });

  it('skips the import for a part exported by the assembly file itself', async () => {
    const code = [
      `import { insert, part } from 'fluidcad/core';`,
      ``,
      `export const local = part('Local', () => {});`,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: null,
      exportName: 'local',
      kind: 'value',
    }));
    expect(result.newCode.match(/import /g)).toHaveLength(1);
    expect(result.newCode).toContain(`const local1 = insert(local);`);
  });

  it('derives the instance name from the export and dodges collisions', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      `import { getExtrusion } from './extrusion.fluid.js';`,
      ``,
      `const extrusion1 = insert(getExtrusion());`,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './extrusion.fluid.js',
      exportName: 'getExtrusion',
      kind: 'factory',
    }));
    expect(result.newCode).toContain(`const extrusion2 = insert(getExtrusion());`);
  });

  it('renders a sub-assembly with the same insert() shape parts use', async () => {
    const code = [
      `import { mate } from 'fluidcad/core';`,
      ``,
      `const width = 700;`,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './gantry.assembly.js',
      exportName: 'gantryAssembly',
      kind: 'assembly',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { insert, mate } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`import { gantryAssembly } from './gantry.assembly.js';`);
    expect(result.newCode).toContain(`const gantryAssembly1 = insert(gantryAssembly());`);
  });

  it('renders non-default params as insert()\'s second argument', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, one({
      importFrom: './extrusion.fluid.js',
      exportName: 'extrusion',
      kind: 'value',
      params: { Size: '80x80', Length: 540, Capped: true },
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `const extrusion1 = insert(extrusion, { Size: '80x80', Length: 540, Capped: true });`,
    );
  });

  it('quotes non-identifier labels, escapes strings, renders arrays', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, one({
      importFrom: './p.fluid.js',
      exportName: 'p',
      kind: 'value',
      params: { 'Guide Width': 20, Note: "it's", Holes: [1, 2, 'x'] },
    }));
    expect(result.newCode).toContain(
      `const p1 = insert(p, { 'Guide Width': 20, Note: 'it\\'s', Holes: [1, 2, 'x'] });`,
    );
  });

  it('renders params on a factory call form too', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, one({
      importFrom: './plate.fluid.js',
      exportName: 'sidePlate',
      kind: 'factory',
      params: { Thickness: 20 },
    }));
    expect(result.newCode).toContain(`const sidePlate1 = insert(sidePlate(), { Thickness: 20 });`);
  });

  it('applies a whole batch in one transform with self-consistent numbering', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, {
      inserts: [
        { importFrom: './extrusion.fluid.js', exportName: 'extrusion', kind: 'value', params: { Length: 540 } },
        { importFrom: './extrusion.fluid.js', exportName: 'extrusion', kind: 'value', params: { Length: 540 } },
        { importFrom: './box.fluid.js', exportName: 'boxBody', kind: 'value' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const extrusion1 = insert(extrusion, { Length: 540 });`);
    expect(result.newCode).toContain(`const extrusion2 = insert(extrusion, { Length: 540 });`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
    const importLines = result.newCode.split('\n').filter(l => l.startsWith('import'));
    expect(importLines).toHaveLength(3);
  });

  it('places the insert inside a definition-style file\'s assembly() body', async () => {
    const code = [
      `import { assembly, insert } from "fluidcad/core";`,
      `import { block } from "./block.fluid.js";`,
      ``,
      `export function rig() {`,
      `    return assembly("rig", () => {`,
      `        const a = insert(block()).grounded();`,
      `        return { a };`,
      `    });`,
      `}`,
      ``,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './block.fluid.js',
      exportName: 'block',
      kind: 'factory',
    }));
    expect(result.error).toBeUndefined();
    // Grouped under the existing insert, inside the body — never at the
    // file's top level (module scope runs outside the assembly's frame).
    expect(result.newCode).toContain(
      `        const a = insert(block()).grounded();\n`
      + `        const block1 = insert(block());\n`,
    );
  });

  it('splices an empty assembly() body open for the first insert', async () => {
    const code = [
      `import { assembly, insert } from "fluidcad/core";`,
      `import { block } from "./block.fluid.js";`,
      ``,
      `export function rig() {`,
      `    return assembly("rig", () => {});`,
      `}`,
      ``,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './block.fluid.js',
      exportName: 'block',
      kind: 'factory',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `    return assembly("rig", () => {\n`
      + `        const block1 = insert(block());\n`
      + `    });`,
    );
  });

  it('puts the first insert of a freshly created assembly file inside the prefilled body', async () => {
    // The exact content /files/create writes for a new assembly file — the
    // template and this transform are two halves of one contract.
    const code = newFileContent('gantry.assembly.js');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './block.fluid.js',
      exportName: 'block',
      kind: 'factory',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `export const gantry = assembly('gantry', () => {\n`
      + `    const block1 = insert(block());\n`
      + `});`,
    );
  });

  it('keeps the top-level append when several assembly() bodies exist', async () => {
    const code = [
      `import { assembly, insert } from "fluidcad/core";`,
      ``,
      `export const a = () => assembly('a', () => {});`,
      `export const b = () => assembly('b', () => {});`,
      ``,
    ].join('\n');
    const result = await applyInsertPartEdit(code, one({
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    }));
    expect(result.error).toBeUndefined();
    expect(result.newCode.trimEnd().endsWith(`const boxBody1 = insert(boxBody);`)).toBe(true);
  });

  it('refuses a non-identifier export name', async () => {
    const result = await applyInsertPartEdit('', one({
      importFrom: './x.fluid.js',
      exportName: 'not a name',
      kind: 'value',
    }));
    expect(result.error).toContain('not an importable identifier');
  });

  it('refuses the whole batch on one unsupported param value', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, {
      inserts: [
        { importFrom: './a.fluid.js', exportName: 'a', kind: 'value' },
        { importFrom: './b.fluid.js', exportName: 'b', kind: 'value', params: { Bad: Number.NaN } },
      ],
    });
    expect(result.error).toContain(`Parameter 'Bad'`);
    expect(result.newCode).toBe(code);
  });

  it('refuses an empty batch', async () => {
    const result = await applyInsertPartEdit('', { inserts: [] });
    expect(result.error).toContain('No inserts');
  });

  it('rides applyFeatureEdit as a side-channel spec', async () => {
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: '/ws/index.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      insertPart: { inserts: [{ importFrom: './box.fluid.js', exportName: 'boxBody', kind: 'value' }] },
    };
    const result = await applyFeatureEdit(`import { mate } from 'fluidcad/core';\n`, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });
});
