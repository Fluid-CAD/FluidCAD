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
});
