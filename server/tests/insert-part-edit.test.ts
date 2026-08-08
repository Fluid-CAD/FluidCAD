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
      isFactory: true,
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
      isFactory: false,
    });
    expect(result.newCode).toContain(`import { boxBody } from './box.fluid.js';`);
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });

  it('adds the insert import when missing', async () => {
    const code = `import { mate } from 'fluidcad/core';\n`;
    const result = await applyInsertPartEdit(code, {
      importFrom: './box.fluid.js',
      exportName: 'boxBody',
      isFactory: false,
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
      isFactory: true,
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
      isFactory: false,
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
      isFactory: true,
    });
    expect(result.newCode).toContain(`const extrusion2 = insert(getExtrusion());`);
  });

  it('refuses a non-identifier export name', async () => {
    const result = await applyInsertPartEdit('', {
      importFrom: './x.fluid.js',
      exportName: 'not a name',
      isFactory: false,
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
      insertPart: { importFrom: './box.fluid.js', exportName: 'boxBody', isFactory: false },
    };
    const result = await applyFeatureEdit(`import { mate } from 'fluidcad/core';\n`, spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const boxBody1 = insert(boxBody);`);
  });
});
