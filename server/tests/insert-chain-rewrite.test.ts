import { describe, it, expect } from 'vitest';
import { updateInsertChain } from '../src/insert-chain-edit.ts';

describe('updateInsertChain', () => {
  it('adds .grounded() to a bare insert', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, { ground: true });
    expect(result.newCode).toBe(`insert(p).grounded();\n`);
  });

  it('preserves existing chain when adding .grounded()', async () => {
    const code = `insert(p).name('foo');\n`;
    const result = await updateInsertChain(code, 1, { ground: true });
    expect(result.newCode).toBe(`insert(p).name('foo').grounded();\n`);
  });

  it('removes .grounded() when ground is false', async () => {
    const code = `insert(p).grounded();\n`;
    const result = await updateInsertChain(code, 1, { ground: false });
    expect(result.newCode).toBe(`insert(p);\n`);
  });

  it('adds .name(value) to a bare insert', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, { name: 'foo' });
    expect(result.newCode).toBe(`insert(p).name("foo");\n`);
  });

  it('replaces an existing .name(...) literal', async () => {
    const code = `insert(p).name('old');\n`;
    const result = await updateInsertChain(code, 1, { name: 'new' });
    expect(result.newCode).toBe(`insert(p).name("new");\n`);
  });

  it('drops .name() when value matches the part default', async () => {
    const code = `insert(p).name('housing');\n`;
    const result = await updateInsertChain(code, 1, { name: 'housing', defaultName: 'housing' });
    expect(result.newCode).toBe(`insert(p);\n`);
  });

  it('drops .name() when value is null', async () => {
    const code = `insert(p).name('foo');\n`;
    const result = await updateInsertChain(code, 1, { name: null });
    expect(result.newCode).toBe(`insert(p);\n`);
  });

  it('one-ground invariant: setting ground on one removes it from all others', async () => {
    const code = [
      `insert(a).grounded();`,
      `insert(b);`,
      ``,
    ].join('\n');
    const result = await updateInsertChain(code, 2, { ground: true });
    expect(result.newCode).toBe(
      [`insert(a);`, `insert(b).grounded();`, ``].join('\n'),
    );
  });

  it('idempotent: re-applying the same ground=true is a no-op', async () => {
    const code = `insert(p).grounded();\n`;
    const result = await updateInsertChain(code, 1, { ground: true });
    expect(result.newCode).toBe(code);
  });

  it('idempotent: re-applying the same name is a no-op (modulo quote style)', async () => {
    const code = `insert(p).name("foo");\n`;
    const result = await updateInsertChain(code, 1, { name: 'foo' });
    expect(result.newCode).toBe(code);
  });

  it('combined name + ground in one call', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, { name: 'foo', ground: true });
    expect(result.newCode).toBe(`insert(p).name("foo").grounded();\n`);
  });

  it('does nothing when source line does not contain insert(...)', async () => {
    const code = `const x = 1;\n`;
    const result = await updateInsertChain(code, 1, { ground: true });
    expect(result.newCode).toBe(code);
  });

  it('appends .translate(x, y, z) to a bare insert', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, { translate: [1, 2, 3] });
    expect(result.newCode).toBe(`insert(p).translate(1, 2, 3);\n`);
  });

  it('replaces an existing .translate(...) in place', async () => {
    const code = `insert(p).translate(1, 2, 3);\n`;
    const result = await updateInsertChain(code, 1, { translate: [4, 5, 6] });
    expect(result.newCode).toBe(`insert(p).translate(4, 5, 6);\n`);
  });

  it('drops .translate() when value is null', async () => {
    const code = `insert(p).translate(1, 2, 3);\n`;
    const result = await updateInsertChain(code, 1, { translate: null });
    expect(result.newCode).toBe(`insert(p);\n`);
  });

  it('drops .translate() when value is within epsilon of the origin', async () => {
    const code = `insert(p).translate(1, 2, 3);\n`;
    const result = await updateInsertChain(code, 1, { translate: [0, 0, 0] });
    expect(result.newCode).toBe(`insert(p);\n`);
  });

  it('does not append .translate(0, 0, 0) on a never-moved insert', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, { translate: [0, 0, 0] });
    expect(result.newCode).toBe(code);
  });

  it('rounds noisy floats to six decimal places', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, {
      translate: [1.0000000001, 2.123456789, -3.5],
    });
    expect(result.newCode).toBe(`insert(p).translate(1, 2.123457, -3.5);\n`);
  });

  it('preserves .grounded() and .name() while updating .translate()', async () => {
    const code = `insert(p).name('foo').grounded();\n`;
    const result = await updateInsertChain(code, 1, { translate: [1, 2, 3] });
    expect(result.newCode).toBe(`insert(p).name('foo').grounded().translate(1, 2, 3);\n`);
  });

  it('combined name + translate + ground in one call', async () => {
    const code = `insert(p);\n`;
    const result = await updateInsertChain(code, 1, {
      name: 'foo',
      translate: [1, 2, 3],
      ground: true,
    });
    expect(result.newCode).toBe(`insert(p).name("foo").translate(1, 2, 3).grounded();\n`);
  });

  it('idempotent: re-applying the same .translate() is a no-op', async () => {
    const code = `insert(p).translate(1, 2, 3);\n`;
    const result = await updateInsertChain(code, 1, { translate: [1, 2, 3] });
    expect(result.newCode).toBe(code);
  });

  describe('a renamed instance takes its variable along', () => {
    it('renames the const and every read of it after the new name', async () => {
      const code = [
        `const bracket1 = insert(bracket).name('bracket1');`,
        `const plate1 = insert(plate).name('plate1');`,
        `mate(bracket1.connectors.base, plate1.connectors.top);`,
        `replicate(bracket1, [plate1.connectors.left]);`,
      ].join('\n');
      const result = await updateInsertChain(code, 1, { name: 'Left bracket' });
      expect(result.newCode).toBe([
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
      const result = await updateInsertChain(code, 2, { name: 'Bracket' });
      expect(result.newCode).toContain(`const bracket2 = insert(bracket).name("Bracket");`);
    });

    it('follows the name even when it is the default and the chain is dropped', async () => {
      const code = `const bracket1 = insert(bracket).name('bracket1');\nmate(bracket1.connectors.a, origin);\n`;
      const result = await updateInsertChain(code, 1, { name: 'Hinge', defaultName: 'Hinge' });
      expect(result.newCode).toBe(`const hinge = insert(bracket);\nmate(hinge.connectors.a, origin);\n`);
    });

    it('keeps the key of a shorthand in the returned parts', async () => {
      const code = [
        `export const rig = assembly('rig', () => {`,
        `  const bracket1 = insert(bracket).name('bracket1');`,
        `  return { bracket1 };`,
        `});`,
      ].join('\n');
      const result = await updateInsertChain(code, 2, { name: 'Left bracket' });
      expect(result.newCode).toContain(`const leftBracket = insert(bracket).name("Left bracket");`);
      expect(result.newCode).toContain(`return { bracket1: leftBracket };`);
    });

    it('leaves a same-named binding of another scope alone', async () => {
      const code = [
        `const bracket1 = insert(bracket).name('bracket1');`,
        `const mirrored = [1, 2].map((bracket1) => bracket1 * 2);`,
        `mate(bracket1.connectors.a, origin);`,
      ].join('\n');
      const result = await updateInsertChain(code, 1, { name: 'left' });
      expect(result.newCode).toBe([
        `const left = insert(bracket).name("left");`,
        `const mirrored = [1, 2].map((bracket1) => bracket1 * 2);`,
        `mate(left.connectors.a, origin);`,
      ].join('\n'));
    });

    it('keeps the variable when the name reduces to it', async () => {
      const code = `const leftBracket = insert(bracket);\n`;
      const result = await updateInsertChain(code, 1, { name: 'Left bracket' });
      expect(result.newCode).toBe(`const leftBracket = insert(bracket).name("Left bracket");\n`);
    });

    it('keeps the variable when the name has nothing to build an identifier from', async () => {
      const code = `const bracket1 = insert(bracket);\n`;
      const result = await updateInsertChain(code, 1, { name: '支架' });
      expect(result.newCode).toBe(`const bracket1 = insert(bracket).name("支架");\n`);
    });

    it('keeps the name of an exported binding', async () => {
      const declared = `export const bracket1 = insert(bracket);\n`;
      expect((await updateInsertChain(declared, 1, { name: 'left' })).newCode)
        .toBe(`export const bracket1 = insert(bracket).name("left");\n`);
      const listed = `const bracket1 = insert(bracket);\nexport { bracket1 };\n`;
      expect((await updateInsertChain(listed, 1, { name: 'left' })).newCode)
        .toBe(`const bracket1 = insert(bracket).name("left");\nexport { bracket1 };\n`);
    });

    it('leaves the variable alone on edits that do not rename', async () => {
      const code = `const bracket1 = insert(bracket).name('Left bracket');\n`;
      const result = await updateInsertChain(code, 1, { ground: true });
      expect(result.newCode).toBe(`const bracket1 = insert(bracket).name('Left bracket').grounded();\n`);
    });
  });
});
