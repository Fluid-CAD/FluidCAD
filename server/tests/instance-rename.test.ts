// The parts panel's Rename in the file that declares the instance: the
// `.name('…')` chain, the variable following the name, and the names the
// binding leaves the file under.

import { describe, it, expect } from 'vitest';
import { InstanceRename } from '../src/instance-rename.ts';

const FILE = '/ws/rig.assembly.js';

async function rename(code: string, sourceLine: number, name: string, defaultName?: string): Promise<string> {
  const result = await InstanceRename.apply(code, FILE, { sourceLine, name, defaultName });
  expect(result.error).toBeUndefined();
  return result.newCode;
}

describe('InstanceRename', () => {
  it('renames the const and every read of it after the new name', async () => {
    const code = [
      `const bracket1 = insert(bracket).name('bracket1');`,
      `const plate1 = insert(plate).name('plate1');`,
      `mate(bracket1.connectors.base, plate1.connectors.top);`,
      `replicate(bracket1, [plate1.connectors.left]);`,
    ].join('\n');
    expect(await rename(code, 1, 'Left bracket')).toBe([
      `const leftBracket = insert(bracket).name("Left bracket");`,
      `const plate1 = insert(plate).name('plate1');`,
      `mate(leftBracket.connectors.base, plate1.connectors.top);`,
      `replicate(leftBracket, [plate1.connectors.left]);`,
    ].join('\n'));
  });

  it('steps past a name the file already declares', async () => {
    const code = [
      `import { bracket } from './bracket.part.js';`,
      `const bracket1 = insert(bracket).name('bracket1');`,
    ].join('\n');
    expect(await rename(code, 2, 'Bracket')).toContain(`const bracket2 = insert(bracket).name("Bracket");`);
  });

  it('follows the name even when it is the default and the chain is dropped', async () => {
    const code = `const bracket1 = insert(bracket).name('bracket1');\nmate(bracket1.connectors.a, origin);\n`;
    expect(await rename(code, 1, 'Hinge', 'Hinge')).toBe(`const hinge = insert(bracket);\nmate(hinge.connectors.a, origin);\n`);
  });

  it('leaves a same-named binding of another scope alone', async () => {
    const code = [
      `const bracket1 = insert(bracket).name('bracket1');`,
      `const mirrored = [1, 2].map((bracket1) => bracket1 * 2);`,
      `mate(bracket1.connectors.a, origin);`,
    ].join('\n');
    expect(await rename(code, 1, 'left')).toBe([
      `const left = insert(bracket).name("left");`,
      `const mirrored = [1, 2].map((bracket1) => bracket1 * 2);`,
      `mate(left.connectors.a, origin);`,
    ].join('\n'));
  });

  it('keeps the variable when the name reduces to it', async () => {
    const code = `const leftBracket = insert(bracket);\n`;
    expect(await rename(code, 1, 'Left bracket')).toBe(`const leftBracket = insert(bracket).name("Left bracket");\n`);
  });

  it('keeps the variable when the name has nothing to build an identifier from', async () => {
    const code = `const bracket1 = insert(bracket);\n`;
    expect(await rename(code, 1, '支架')).toBe(`const bracket1 = insert(bracket).name("支架");\n`);
  });

  it('names an insert no const binds', async () => {
    expect(await rename(`insert(bracket).grounded();\n`, 1, 'left')).toBe(`insert(bracket).grounded().name("left");\n`);
  });

  it('refuses a line that holds no insert()', async () => {
    const code = `const width = 700;\n`;
    const result = await InstanceRename.apply(code, FILE, { sourceLine: 1, name: 'left' });
    expect(result.error).toMatch(/no insert\(\) statement starts on line 1/);
    expect(result.newCode).toBe(code);
  });

  describe('the parts an assembly returns', () => {
    const RIG = [
      `export const rig = assembly('rig', () => {`,
      `  const bracket1 = insert(bracket).name('bracket1');`,
      `  const plate1 = insert(plate);`,
      `  mate(bracket1.connectors.base, plate1.connectors.top);`,
      `  return { bracket1, plate1 };`,
      `});`,
    ].join('\n');

    it('renames a returned shorthand with the variable', async () => {
      const out = await rename(RIG, 2, 'Left bracket');
      expect(out).toContain(`const leftBracket = insert(bracket).name("Left bracket");`);
      expect(out).toContain(`return { leftBracket, plate1 };`);
    });

    it('follows the reads of the returned name in the same file', async () => {
      const code = [
        RIG,
        `const left = insert(rig);`,
        `const right = insert(other);`,
        `mate(left.parts.bracket1.connectors.base, right.parts.bracket1.connectors.base);`,
      ].join('\n');
      expect(await rename(code, 2, 'Left bracket')).toContain(
        `mate(left.parts.leftBracket.connectors.base, right.parts.bracket1.connectors.base);`,
      );
    });

    it('says how other files read the instance', async () => {
      const plan = await InstanceRename.plan(RIG, FILE, 2, 'Left bracket');
      expect(plan).toMatchObject({
        variable: 'leftBracket',
        variableExport: null,
        declaration: {
          kind: 'instance',
          key: 'bracket1',
          filePath: FILE,
          variableExport: null,
          definition: { localName: 'rig', exportName: 'rig' },
        },
      });
    });

    it('keeps the key of an entry the returned object spells out', async () => {
      const code = RIG.replace(`return { bracket1, plate1 };`, `return { left: bracket1, plate1 };`);
      expect(await rename(code, 2, 'Left bracket')).toContain(`return { left: leftBracket, plate1 };`);
      expect((await InstanceRename.plan(code, FILE, 2, 'Left bracket'))?.declaration).toBeNull();
    });

    it('keeps the key of a shorthand nested deeper in the returned object', async () => {
      const code = RIG.replace(`return { bracket1, plate1 };`, `return { side: { bracket1 }, plate1 };`);
      expect(await rename(code, 2, 'Left bracket')).toContain(`return { side: { bracket1: leftBracket }, plate1 };`);
    });

    it('keeps the key when another entry already takes the new name', async () => {
      const code = RIG.replace(`return { bracket1, plate1 };`, `return { bracket1, leftBracket: plate1 };`);
      expect(await rename(code, 2, 'Left bracket')).toContain(`return { bracket1: leftBracket, leftBracket: plate1 };`);
    });

    it('keeps the key of an assembly no module-level const names', async () => {
      const code = [
        `export function makeRig() {`,
        `  return assembly('rig', () => {`,
        `    const bracket1 = insert(bracket);`,
        `    return { bracket1 };`,
        `  });`,
        `}`,
      ].join('\n');
      expect(await rename(code, 3, 'Left bracket')).toContain(`return { bracket1: leftBracket };`);
      expect((await InstanceRename.plan(code, FILE, 3, 'Left bracket'))?.declaration).toBeNull();
    });
  });

  describe('a top-level binding the file exports', () => {
    it('renames an exported declaration, and the export with it', async () => {
      const code = `export const bracket1 = insert(bracket);\n`;
      expect(await rename(code, 1, 'left')).toBe(`export const left = insert(bracket).name("left");\n`);
      expect(await InstanceRename.plan(code, FILE, 1, 'left')).toMatchObject({
        variableExport: 'left',
        declaration: { kind: 'instance', key: 'bracket1', variableExport: 'bracket1', definition: null },
      });
    });

    it('renames a listed export', async () => {
      const code = `const bracket1 = insert(bracket);\nexport { bracket1 };\n`;
      expect(await rename(code, 1, 'left')).toBe(`const left = insert(bracket).name("left");\nexport { left };\n`);
    });

    it('keeps the alias an export is listed under', async () => {
      const code = `const bracket1 = insert(bracket);\nexport { bracket1 as main };\n`;
      expect(await rename(code, 1, 'left')).toBe(`const left = insert(bracket).name("left");\nexport { left as main };\n`);
      expect((await InstanceRename.plan(code, FILE, 1, 'left'))?.variableExport).toBe('main');
    });
  });
});
