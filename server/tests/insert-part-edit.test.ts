import { describe, it, expect } from 'vitest';
import { applyInsertPartEdit } from '../src/part-catalog/insert-edit.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

describe('applyInsertPartEdit', () => {
  it('imports the part export and appends a bound insert statement', async () => {
    const code = [
      `import { insert, mate } from "fluidcad/core";`,
      ``,
      `const width = 700;`,
    ].join('\n');

    const result = await applyInsertPartEdit(code, {
      importFrom: './side-plate.part.js',
      exportName: 'sidePlate',
      kind: 'factory',
    });
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
    const result = await applyInsertPartEdit(code, {
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    });
    expect(result.newCode).toContain(`import { boxBody } from './box.fluid.js';`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });

  it('adds the insert import when missing', async () => {
    const code = `import { mate } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, {
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    });
    expect(result.newCode).toContain(`insert,`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });

  it('merges into an existing import of the same module', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      `import { RAIL_WIDTH } from './linear-guides.fluid.js';`,
      ``,
    ].join('\n');
    const result = await applyInsertPartEdit(code, {
      importFrom: './linear-guides.fluid.js',
      exportName: 'getLinearGuides',
      kind: 'factory',
    });
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
    const result = await applyInsertPartEdit(code, {
      importFrom: null,
      exportName: 'local',
      kind: 'value',
    });
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
    const result = await applyInsertPartEdit(code, {
      importFrom: './extrusion.fluid.js',
      exportName: 'getExtrusion',
      kind: 'factory',
    });
    expect(result.newCode).toContain(`const extrusion2 = insert(getExtrusion());`);
  });

  it('renders a sub-assembly with the same insert() shape parts use', async () => {
    const code = [
      `import { mate } from 'fluidcad/core';`,
      ``,
      `const width = 700;`,
    ].join('\n');
    const result = await applyInsertPartEdit(code, {
      importFrom: './gantry.assembly.js',
      exportName: 'gantryAssembly',
      kind: 'assembly',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import {insert, mate } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`import { gantryAssembly } from './gantry.assembly.js';`);
    expect(result.newCode).toContain(`const gantryAssembly1 = insert(gantryAssembly());`);
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
    const result = await applyInsertPartEdit(code, {
      importFrom: './block.fluid.js',
      exportName: 'block',
      kind: 'factory',
    });
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
    const result = await applyInsertPartEdit(code, {
      importFrom: './block.fluid.js',
      exportName: 'block',
      kind: 'factory',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `    return assembly("rig", () => {\n`
      + `        const block1 = insert(block());\n`
      + `    });`,
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
    const result = await applyInsertPartEdit(code, {
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      kind: 'value',
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode.trimEnd().endsWith(`const boxBody1 = insert(boxBody);`)).toBe(true);
  });

  it('refuses a non-identifier export name', async () => {
    const result = await applyInsertPartEdit('', {
      importFrom: './x.fluid.js',
      exportName: 'not a name',
      kind: 'value',
    });
    expect(result.error).toContain('not an importable identifier');
  });

  it('rides applyFeatureEdit as a side-channel spec', async () => {
    const spec: ApplyFeatureEditSpec = {
      feature: 'sketch',
      filePath: '/ws/index.assembly.js',
      producers: [],
      parts: [],
      imports: [],
      insertPart: { importFrom: './box.fluid.js', exportName: 'boxBody', kind: 'value' },
    };
    const result = await applyFeatureEdit(`import { mate } from 'fluidcad/core';\n`, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });
});
