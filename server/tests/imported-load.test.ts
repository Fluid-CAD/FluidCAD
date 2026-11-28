import { describe, it, expect } from 'vitest';
import { applyImportedLoad } from '../src/apply-feature-edit/index.ts';

const PART = { line: 3, column: 21 };

describe('applyImportedLoad', () => {
  it('lands the load call in the active part, as a new project\'s empty part takes it', async () => {
    const code = `import { part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n});\n`;
    const result = await applyImportedLoad(code, 'bracket', PART);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(
      `import { load, part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n  load('bracket');\n});\n`,
    );
  });

  it('puts it after the part\'s last statement', async () => {
    const code = `import { part, cylinder } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n  cylinder(20, 60);\n});\n`;
    const result = await applyImportedLoad(code, 'bracket', PART);
    expect(result.newCode).toBe(
      `import { load, part, cylinder } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n  cylinder(20, 60);\n  load('bracket');\n});\n`,
    );
  });

  it('writes into the part it is given, not the file\'s last', async () => {
    const code = [
      `import { part } from 'fluidcad/core';`,
      ``,
      `export const a = part('A', () => {`,
      `});`,
      ``,
      `export const b = part('B', () => {`,
      `});`,
      ``,
    ].join('\n');
    const result = await applyImportedLoad(code, 'bracket', PART);
    expect(result.newCode).toContain(`part('A', () => {\n  load('bracket');\n});`);
    expect(result.newCode).toContain(`part('B', () => {\n});`);
  });

  it('no-ops when the file already loads the model, wherever the call is', async () => {
    const code = `import { load, part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n  load('bracket');\n});\n`;
    const result = await applyImportedLoad(code, 'bracket', PART);
    expect(result.newCode).toBe(code);
  });

  it('refuses a part line that holds no part, leaving the code as it was', async () => {
    const code = `import { part } from 'fluidcad/core';\n\nexport const part1 = part('Part 1', () => {\n});\n`;
    const result = await applyImportedLoad(code, 'bracket', { line: 1, column: 0 });
    expect(result.error).toMatch(/no part\(\) call found at line 1/);
    expect(result.newCode).toBe(code);
  });

  it('goes to the top level with no active part', async () => {
    const code = `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`;
    const result = await applyImportedLoad(code, 'bracket');
    expect(result.newCode).toBe(
      `import { load, extrude } from 'fluidcad/core';\n\nextrude(10);\n\nload('bracket');\n`,
    );
  });
});
