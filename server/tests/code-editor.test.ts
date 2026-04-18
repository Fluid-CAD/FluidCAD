import { describe, it, expect } from 'vitest';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addPick,
  setPickPoints,
} from '../src/code-editor.ts';

describe('addBreakpoint', () => {
  it('adds the import line and inserts breakpoint after the statement', async () => {
    const code = `const a = 1;\nconst b = 2;\n`;
    const result = await addBreakpoint(code, 0);
    // Following line has content, so a blank line follows the breakpoint.
    expect(result.newCode).toBe(
      `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\n\nconst b = 2;\n`,
    );
    // Breakpoint is on line 2 of the new file: import, const a, breakpoint
    expect(result.breakpointLine).toBe(2);
  });

  it('reuses an existing fluidcad/core import', async () => {
    const code = `import { line } from 'fluidcad/core';\nconst a = 1;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toBe(
      `import {breakpoint, line } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\n`,
    );
    // No line shift because the import was edited in place.
    expect(result.breakpointLine).toBe(2);
  });

  it('does not duplicate when breakpoint is already imported', async () => {
    const code = `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toBe(
      `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\n`,
    );
    expect(result.breakpointLine).toBe(2);
  });

  it('inserts a blank line after when the next line has content', async () => {
    const code = `const a = 1;\nconst b = 2;`;
    const result = await addBreakpoint(code, 0);
    // Following row has content, so a blank line follows the breakpoint
    expect(result.newCode).toBe(
      `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\n\nconst b = 2;`,
    );
  });

  it('walks past blank lines to find the enclosing statement', async () => {
    const code = `const a = 1;\n\n\nconst b = 2;\n`;
    // referenceRow points at a blank line; the resolver walks back to const a
    const result = await addBreakpoint(code, 2);
    expect(result.newCode).toContain(`const a = 1;\nbreakpoint();`);
  });

  it('places breakpoint after a multi-line statement using tree-sitter', async () => {
    const code = `const a = {\n  x: 1,\n  y: 2,\n};\nconst b = 3;\n`;
    // Cursor is on the first line of the object literal
    const result = await addBreakpoint(code, 0);
    expect(result.newCode).toContain(`};\nbreakpoint();\n\nconst b = 3;`);
  });

  it('is a no-op when a breakpoint already exists at the resolved insert line', async () => {
    const code = `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\nconst b = 2;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toBe(code);
    expect(result.breakpointLine).toBe(2);
  });
});

describe('removeBreakpoint', () => {
  it('deletes the breakpoint line', async () => {
    const code = `const a = 1;\nbreakpoint();\nconst b = 2;\n`;
    const result = await removeBreakpoint(code, 1);
    expect(result.newCode).toBe(`const a = 1;\nconst b = 2;\n`);
    expect(result.breakpointLine).toBeNull();
  });

  it('is a no-op when the line does not contain breakpoint()', async () => {
    const code = `const a = 1;\nconst b = 2;\n`;
    const result = await removeBreakpoint(code, 0);
    expect(result.newCode).toBe(code);
  });
});

describe('toggleBreakpoint', () => {
  it('removes a breakpoint when cursor is on it', async () => {
    const code = `const a = 1;\nbreakpoint();\nconst b = 2;\n`;
    const result = await toggleBreakpoint(code, 1);
    expect(result.newCode).toBe(`const a = 1;\nconst b = 2;\n`);
  });

  it('removes the breakpoint on the next line if cursor is just before it', async () => {
    const code = `const a = 1;\nbreakpoint();\nconst b = 2;\n`;
    const result = await toggleBreakpoint(code, 0);
    expect(result.newCode).toBe(`const a = 1;\nconst b = 2;\n`);
  });

  it('adds a breakpoint when cursor is on a statement', async () => {
    const code = `const a = 1;\nconst b = 2;\n`;
    const result = await toggleBreakpoint(code, 0);
    expect(result.newCode).toContain(`const a = 1;\nbreakpoint();`);
    expect(result.breakpointLine).not.toBeNull();
  });
});

describe('clearBreakpoints', () => {
  it('removes every breakpoint() line', async () => {
    const code = `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\nconst b = 2;\nbreakpoint();\nconst c = 3;\n`;
    const result = await clearBreakpoints(code);
    expect(result.newCode).toBe(
      `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nconst b = 2;\nconst c = 3;\n`,
    );
  });

  it('returns code unchanged when there are no breakpoints', async () => {
    const code = `const a = 1;\n`;
    const result = await clearBreakpoints(code);
    expect(result.newCode).toBe(code);
  });
});

describe('insertPoint', () => {
  it('appends a point to a call with no arguments', async () => {
    const code = `line()\n`;
    const result = await insertPoint(code, 1, [10, 20]);
    expect(result.newCode).toBe(`line([10, 20])\n`);
  });

  it('appends a point with comma separator when other args exist', async () => {
    const code = `line([0, 0])\n`;
    const result = await insertPoint(code, 1, [10, 20]);
    expect(result.newCode).toBe(`line([0, 0], [10, 20])\n`);
  });

  it('walks past blank lines to find the call', async () => {
    const code = `line([0, 0])\n\n`;
    // sourceLine 2 is blank; should walk back to row 0
    const result = await insertPoint(code, 2, [5, 6]);
    expect(result.newCode).toBe(`line([0, 0], [5, 6])\n\n`);
  });
});

describe('addPick', () => {
  it('appends .pick() after the last close paren on the line', async () => {
    const code = `line([0, 0], [1, 1])\n`;
    const result = await addPick(code, 1);
    expect(result.newCode).toBe(`line([0, 0], [1, 1]).pick()\n`);
  });

  it('is a no-op when .pick( already exists on the line', async () => {
    const code = `line([0, 0]).pick()\n`;
    const result = await addPick(code, 1);
    expect(result.newCode).toBe(code);
  });
});

describe('removePoint', () => {
  it('removes the only point from a single-arg call', async () => {
    const code = `line([5, 5])\n`;
    const result = await removePoint(code, 1, [5, 5]);
    expect(result.newCode).toBe(`line()\n`);
  });

  it('removes the closest point and trailing comma from the first arg', async () => {
    const code = `line([0, 0], [10, 10])\n`;
    const result = await removePoint(code, 1, [0, 0]);
    expect(result.newCode).toBe(`line([10, 10])\n`);
  });

  it('removes the closest point and leading comma from a non-first arg', async () => {
    const code = `line([0, 0], [10, 10])\n`;
    const result = await removePoint(code, 1, [10, 10]);
    expect(result.newCode).toBe(`line([0, 0])\n`);
  });
});

describe('setPickPoints', () => {
  it('replaces all arguments with the new point list', async () => {
    const code = `line([0, 0], [1, 1])\n`;
    const result = await setPickPoints(code, 1, [
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
    expect(result.newCode).toBe(`line([2, 2], [3, 3], [4, 4])\n`);
  });

  it('handles an empty replacement', async () => {
    const code = `line([0, 0], [1, 1])\n`;
    const result = await setPickPoints(code, 1, []);
    expect(result.newCode).toBe(`line()\n`);
  });
});
