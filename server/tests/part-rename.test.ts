// The part row's Rename in the file that declares the part: the name
// `part('…', …)` takes, and the variable following it.

import { describe, it, expect } from 'vitest';
import { PartRename } from '../src/part-rename.ts';

const FILE = '/ws/carcase.part.js';

async function rename(code: string, sourceLine: number, name: string): Promise<string> {
  const result = await PartRename.apply(code, FILE, { sourceLine, name });
  expect(result.error).toBeUndefined();
  return result.newCode;
}

describe('PartRename', () => {
  it('renames the exported const after the new name', async () => {
    const code = [
      `import { part, param } from 'fluidcad/core';`,
      ``,
      `export const box = part('Carcase', () => {`,
      `  const width = param('Width', 500);`,
      `});`,
      ``,
    ].join('\n');
    expect(await rename(code, 3, 'MyCarcase2')).toBe([
      `import { part, param } from 'fluidcad/core';`,
      ``,
      `export const myCarcase2 = part('MyCarcase2', () => {`,
      `  const width = param('Width', 500);`,
      `});`,
      ``,
    ].join('\n'));
  });

  it('follows the reads of the const in its own file', async () => {
    const code = [
      `const box = part('Carcase', () => {});`,
      `export { box };`,
      `const inner = box.properties.InternalWidth;`,
      `insert(box, { Width: 400 });`,
    ].join('\n');
    expect(await rename(code, 1, 'Fixed leaf')).toBe([
      `const fixedLeaf = part('Fixed leaf', () => {});`,
      `export { fixedLeaf };`,
      `const inner = fixedLeaf.properties.InternalWidth;`,
      `insert(fixedLeaf, { Width: 400 });`,
    ].join('\n'));
  });

  it('keeps the alias an export is listed under', async () => {
    const code = `const box = part('Carcase', () => {});\nexport { box as carcase };\n`;
    expect(await rename(code, 1, 'Shell')).toBe(`const shell = part('Shell', () => {});\nexport { shell as carcase };\n`);
    expect((await PartRename.plan(code, FILE, 1, 'Shell'))?.variableExport).toBe('carcase');
  });

  it('steps past a name the file already declares', async () => {
    const code = `import { part } from 'fluidcad/core';\nexport const box = part('Carcase', () => {});\n`;
    expect(await rename(code, 2, 'Part')).toContain(`export const part2 = part('Part', () => {});`);
  });

  it('keeps the variable when the name reduces to it', async () => {
    const code = `export const fixedLeaf = part('Leaf', () => {});\n`;
    expect(await rename(code, 1, 'Fixed leaf')).toBe(`export const fixedLeaf = part('Fixed leaf', () => {});\n`);
  });

  it('names a part no const binds', async () => {
    expect(await rename(`part('Part 1', () => {});\n`, 1, 'Leaf')).toBe(`part('Leaf', () => {});\n`);
  });

  it('says how other files read the part', async () => {
    const code = `export const box = part('Carcase', () => {});\n`;
    expect(await PartRename.plan(code, FILE, 1, 'Shell')).toMatchObject({
      variable: 'shell',
      variableExport: 'shell',
      declaration: { kind: 'part', key: 'box', filePath: FILE, variableExport: 'box', definition: null },
    });
    const kept = `const box = part('Carcase', () => {});\n`;
    expect((await PartRename.plan(kept, FILE, 1, 'Shell'))?.declaration).toBeNull();
  });

  it('refuses a line that holds no part()', async () => {
    const code = `const s = sketch('xy', () => {});\n`;
    const result = await PartRename.apply(code, FILE, { sourceLine: 1, name: 'Leaf' });
    expect(result.error).toMatch(/no part\(\) statement starts on line 1/);
    expect(result.newCode).toBe(code);
  });
});
