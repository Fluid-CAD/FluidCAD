import { describe, it, expect } from 'vitest';
import { setInsertTransparency } from '../src/insert-chain-edit.ts';

// The parts panel's Transparency… write-back: set or drop the `.transparent(v)`
// call of an insert() chain. Only that call changes — the pose calls around it
// are left byte for byte, so the statement still places the part where it was.
describe('setInsertTransparency', () => {
  it('appends the call to a bare insert', async () => {
    const result = await setInsertTransparency(`const a = insert(p);\n`, 1, 0.4);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(`const a = insert(p).transparent(0.4);\n`);
  });

  it('appends after the pose calls, which stay untouched', async () => {
    const code = `insert(p, { width: 10 }).rotate('z', 30).translate(1.25, -2, 3).grounded();\n`;
    const result = await setInsertTransparency(code, 1, 0.25);
    expect(result.newCode).toBe(
      `insert(p, { width: 10 }).rotate('z', 30).translate(1.25, -2, 3).grounded().transparent(0.25);\n`,
    );
  });

  it('replaces an existing value in place', async () => {
    const code = `insert(p).transparent(0.2).translate(5, 0, 0);\n`;
    const result = await setInsertTransparency(code, 1, 0.75);
    expect(result.newCode).toBe(`insert(p).transparent(0.75).translate(5, 0, 0);\n`);
  });

  it('fills the no-argument form', async () => {
    const result = await setInsertTransparency(`insert(p).transparent();\n`, 1, 0.3);
    expect(result.newCode).toBe(`insert(p).transparent(0.3);\n`);
  });

  it('drops the call for null and for 0, and is a no-op on a bare insert', async () => {
    const code = `insert(p).transparent(0.5).translate(5, 0, 0);\n`;
    expect((await setInsertTransparency(code, 1, null)).newCode).toBe(`insert(p).translate(5, 0, 0);\n`);
    expect((await setInsertTransparency(code, 1, 0)).newCode).toBe(`insert(p).translate(5, 0, 0);\n`);
    expect((await setInsertTransparency(`insert(p);\n`, 1, null)).newCode).toBe(`insert(p);\n`);
  });

  it('collapses several calls into one at the chain end (the last one won anyway)', async () => {
    const code = `insert(p).transparent(0.2).translate(1, 2, 3).transparent(0.9);\n`;
    const result = await setInsertTransparency(code, 1, 0.5);
    expect(result.newCode).toBe(`insert(p).translate(1, 2, 3).transparent(0.5);\n`);
  });

  it('edits a multi-line chain on the row the insert() starts on', async () => {
    const code = [
      `import { insert } from 'fluidcad/core';`,
      `const a = insert(p)`,
      `  .transparent(0.1)`,
      `  .translate(0, 0, 10);`,
      ``,
    ].join('\n');
    const result = await setInsertTransparency(code, 2, 0.6);
    expect(result.newCode).toBe([
      `import { insert } from 'fluidcad/core';`,
      `const a = insert(p)`,
      `  .transparent(0.6)`,
      `  .translate(0, 0, 10);`,
      ``,
    ].join('\n'));
    const dropped = await setInsertTransparency(code, 2, null);
    expect(dropped.newCode).toBe([
      `import { insert } from 'fluidcad/core';`,
      `const a = insert(p)`,
      `  .translate(0, 0, 10);`,
      ``,
    ].join('\n'));
  });

  it('writes a short literal for slider values', async () => {
    expect((await setInsertTransparency(`insert(p);\n`, 1, 0.35000000000000003)).newCode).toBe(`insert(p).transparent(0.35);\n`);
    expect((await setInsertTransparency(`insert(p);\n`, 1, 1)).newCode).toBe(`insert(p).transparent(1);\n`);
  });

  it('refuses an expression argument instead of flattening it', async () => {
    const code = `insert(p).transparent(glass);\n`;
    const result = await setInsertTransparency(code, 1, 0.5);
    expect(result.newCode).toBe(code);
    expect(result.error).toMatch(/\.transparent\(glass\) on line 1 isn't a plain number/);
  });

  it('refuses a line that is not an insert() chain', async () => {
    const code = `const a = insert(p);\nmate('fastened', a.connectors.x, b.connectors.y);\n`;
    const result = await setInsertTransparency(code, 2, 0.5);
    expect(result.newCode).toBe(code);
    expect(result.error).toMatch(/no insert\(\) statement starts on line 2/);
  });

  it('refuses values outside 0..1', async () => {
    for (const bad of [-0.1, 1.2, Number.NaN]) {
      const result = await setInsertTransparency(`insert(p);\n`, 1, bad);
      expect(result.error).toMatch(/transparency must be a number from 0 to 1/);
      expect(result.newCode).toBe(`insert(p);\n`);
    }
  });
});
