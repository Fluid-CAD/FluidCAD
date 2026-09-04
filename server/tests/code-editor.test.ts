import { describe, it, expect } from 'vitest';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addGuide,
  removeGuide,
  addPick,
  removePick,
  removeStatement,
  setFeatureName,
  setPickPoints,
  insertGeometryCall,
  insertGeometryCallWithVariable,
  insertLoadCall,
  updateDimension,
  updateDimensionExpression,
  getDimensionExpression,
  getPointExpression,
  extractVariablesInScope,
  declareTopLevelVariable,
  readUnitStatement,
  setDocumentUnit,
  ensureSymbolImport,
  importLocalName,
  collectBoundNames,
  getJavaScriptParser,
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

  it('places breakpoint after a 2d feature inside a sketch callback, not after the sketch', async () => {
    const code = `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n    line([40, 20]);\n});\n`;
    // referenceRow points at the first line(...) inside the callback.
    const result = await addBreakpoint(code, 2);
    expect(result.newCode).toBe(
      `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n    breakpoint();\n\n    line([40, 20]);\n});\n`,
    );
    expect(result.breakpointLine).toBe(3);
  });

  it('places breakpoint after the last 2d feature inside a sketch callback', async () => {
    const code = `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n    line([40, 20]);\n});\n`;
    const result = await addBreakpoint(code, 3);
    expect(result.newCode).toBe(
      `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n    line([40, 20]);\n    breakpoint();\n\n});\n`,
    );
    expect(result.breakpointLine).toBe(4);
  });

  it('still places breakpoint after the whole sketch when referencing the sketch row', async () => {
    const code = `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n});\nconst b = 2;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toBe(
      `import { breakpoint, line, sketch } from 'fluidcad/core';\nsketch("xy", () => {\n    line([40, 0]);\n});\nbreakpoint();\n\nconst b = 2;\n`,
    );
    expect(result.breakpointLine).toBe(4);
  });

  it('is a no-op when a breakpoint already exists at the resolved insert line', async () => {
    const code = `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\nconst b = 2;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toBe(code);
    expect(result.breakpointLine).toBe(2);
  });
});

describe('addBreakpoint (AST robustness)', () => {
  it('ignores a commented-out import when looking for the fluidcad import', async () => {
    const code = `// import { breakpoint } from 'fluidcad/core';\nconst a = 1;\n`;
    const result = await addBreakpoint(code, 1);
    // Commented import shouldn't match; a real import line is prepended.
    expect(result.newCode.startsWith(`import { breakpoint } from 'fluidcad/core';\n`)).toBe(true);
  });

  it('reuses an import that has trailing inline comments', async () => {
    const code = `import { line } from 'fluidcad/core'; // note\nconst a = 1;\n`;
    const result = await addBreakpoint(code, 1);
    expect(result.newCode).toContain(`import {breakpoint, line } from 'fluidcad/core';`);
    // No new import line was prepended.
    expect(result.newCode.split('\n').filter(l => l.startsWith('import')).length).toBe(1);
  });
});

describe('removeBreakpoint (AST robustness)', () => {
  it('does not treat a commented-out breakpoint() as real', async () => {
    const code = `const a = 1;\n// breakpoint();\nconst b = 2;\n`;
    const result = await removeBreakpoint(code, 1);
    // The comment is not a real call expression — nothing to remove.
    expect(result.newCode).toBe(code);
  });
});

describe('clearBreakpoints (AST robustness)', () => {
  it('skips a commented-out breakpoint() while removing real calls', async () => {
    const code = `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\nbreakpoint();\n// breakpoint();\nconst b = 2;\n`;
    const result = await clearBreakpoints(code);
    expect(result.newCode).toBe(
      `import { breakpoint } from 'fluidcad/core';\nconst a = 1;\n// breakpoint();\nconst b = 2;\n`,
    );
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

describe('addGuide', () => {
  it('appends .guide() after the last close paren on the line', async () => {
    const code = `ellipse([0, 0], 10, 5)\n`;
    const result = await addGuide(code, 1);
    expect(result.newCode).toBe(`ellipse([0, 0], 10, 5).guide()\n`);
  });

  it('appends after an existing chained call', async () => {
    const code = `ellipse([0, 0], 10, 5).centered()\n`;
    const result = await addGuide(code, 1);
    expect(result.newCode).toBe(`ellipse([0, 0], 10, 5).centered().guide()\n`);
  });

  it('is a no-op when .guide( already exists on the line', async () => {
    const code = `line([0, 0], [1, 1]).guide()\n`;
    const result = await addGuide(code, 1);
    expect(result.newCode).toBe(code);
  });
});

describe('removeGuide', () => {
  it('removes .guide() from the line', async () => {
    const code = `ellipse([0, 0], 10, 5).guide();\n`;
    const result = await removeGuide(code, 1);
    expect(result.newCode).toBe(`ellipse([0, 0], 10, 5);\n`);
  });

  it('removes a mid-chain .guide(), keeping later calls', async () => {
    const code = `ellipse([0, 0], 10, 5).guide().centered()\n`;
    const result = await removeGuide(code, 1);
    expect(result.newCode).toBe(`ellipse([0, 0], 10, 5).centered()\n`);
  });

  it('is a no-op when there is no .guide() on the line', async () => {
    const code = `ellipse([0, 0], 10, 5)\n`;
    const result = await removeGuide(code, 1);
    expect(result.newCode).toBe(code);
  });
});

describe('removePick', () => {
  it('removes an empty .pick() from the line', async () => {
    const code = `extrude(sk).pick()\n`;
    const result = await removePick(code, 1);
    expect(result.newCode).toBe(`extrude(sk)\n`);
  });

  it('leaves a .pick() with points untouched', async () => {
    const code = `extrude(sk).pick([1, 2])\n`;
    const result = await removePick(code, 1);
    expect(result.newCode).toBe(code);
  });

  it('is a no-op when there is no .pick() on the line', async () => {
    const code = `extrude(sk)\n`;
    const result = await removePick(code, 1);
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

// ---------------------------------------------------------------------------
// Multi-line call coverage — the AST-based editor must handle calls that
// span several rows (e.g. `offset(\n  edge().circle()\n)`) identically to
// single-line calls.
// ---------------------------------------------------------------------------

describe('multi-line calls', () => {
  describe('addPick', () => {
    it('appends .pick() after the closing paren on a later line', async () => {
      const code = `offset(\n  edge().circle()\n)\n`;
      const result = await addPick(code, 1);
      expect(result.newCode).toBe(`offset(\n  edge().circle()\n).pick()\n`);
    });

    it('is a no-op when .pick() already exists on a later line', async () => {
      const code = `offset(\n  edge().circle()\n).pick()\n`;
      const result = await addPick(code, 1);
      expect(result.newCode).toBe(code);
    });

    it('finds the inner call when it is nested inside sk.add on a different row', async () => {
      const code = `sk.add(\n  offset(\n    edge().circle()\n  )\n)\n`;
      const result = await addPick(code, 2);
      expect(result.newCode).toBe(
        `sk.add(\n  offset(\n    edge().circle()\n  ).pick()\n)\n`,
      );
    });
  });

  describe('insertPoint', () => {
    it('inserts into an empty multi-line call', async () => {
      const code = `offset(\n  edge().circle()\n).pick()\n`;
      const result = await insertPoint(code, 1, [5, 6]);
      expect(result.newCode).toBe(
        `offset(\n  edge().circle()\n).pick([5, 6])\n`,
      );
    });

    it('appends to an existing point in a multi-line call', async () => {
      const code = `offset(\n  edge().circle()\n).pick([1, 2])\n`;
      const result = await insertPoint(code, 1, [3, 4]);
      expect(result.newCode).toBe(
        `offset(\n  edge().circle()\n).pick([1, 2], [3, 4])\n`,
      );
    });
  });

  describe('removePick', () => {
    it('strips a trailing .pick() when the chain spans multiple lines', async () => {
      const code = `extrude(\n  sk\n).pick()\n`;
      const result = await removePick(code, 1);
      expect(result.newCode).toBe(`extrude(\n  sk\n)\n`);
    });

    it('leaves a multi-line .pick() with points untouched', async () => {
      const code = `offset(\n  edge().circle()\n).pick([1, 2])\n`;
      const result = await removePick(code, 1);
      expect(result.newCode).toBe(code);
    });
  });

  describe('removePoint', () => {
    it('removes the closest point when the call spans multiple lines', async () => {
      const code = `offset(\n  edge().circle()\n).pick([0, 0], [10, 10])\n`;
      const result = await removePoint(code, 1, [10, 10]);
      expect(result.newCode).toBe(
        `offset(\n  edge().circle()\n).pick([0, 0])\n`,
      );
    });
  });

  describe('setPickPoints', () => {
    it('replaces the argument span of a multi-line call', async () => {
      const code = `offset(\n  edge().circle()\n).pick([1, 1])\n`;
      const result = await setPickPoints(code, 1, [[2, 2], [3, 3]]);
      expect(result.newCode).toBe(
        `offset(\n  edge().circle()\n).pick([2, 2], [3, 3])\n`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// When `.pick()` is not the last call in the chain (e.g. followed by
// `.symmetric(...)`), point edits must still target `.pick()` — the
// outermost call is the wrong destination.
// ---------------------------------------------------------------------------

describe('point edits target .pick() inside a longer chain', () => {
  it('insertPoint adds to .pick(), not to a trailing .symmetric()', async () => {
    const code = `extrude(sk).pick([1, 2]).symmetric([5, 6], [7, 8])\n`;
    const result = await insertPoint(code, 1, [9, 10]);
    expect(result.newCode).toBe(
      `extrude(sk).pick([1, 2], [9, 10]).symmetric([5, 6], [7, 8])\n`,
    );
  });

  it('removePoint removes from .pick(), not from a trailing .symmetric()', async () => {
    const code = `extrude(sk).pick([1, 2], [3, 4]).symmetric([5, 6], [7, 8])\n`;
    const result = await removePoint(code, 1, [1, 2]);
    expect(result.newCode).toBe(
      `extrude(sk).pick([3, 4]).symmetric([5, 6], [7, 8])\n`,
    );
  });

  it('setPickPoints replaces .pick() args, not a trailing .symmetric() args', async () => {
    const code = `extrude(sk).pick([1, 2]).symmetric([5, 6], [7, 8])\n`;
    const result = await setPickPoints(code, 1, [[9, 9], [10, 10]]);
    expect(result.newCode).toBe(
      `extrude(sk).pick([9, 9], [10, 10]).symmetric([5, 6], [7, 8])\n`,
    );
  });

  it('insertPoint falls back to the outer call for non-pick chains (e.g. bezier)', async () => {
    const code = `bezier([0, 0], [1, 1])\n`;
    const result = await insertPoint(code, 1, [2, 2]);
    expect(result.newCode).toBe(`bezier([0, 0], [1, 1], [2, 2])\n`);
  });
});

describe('insertGeometryCall', () => {
  it('inserts a geometry call at the end of a sketch body', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'line([10, 10], [20, 20])');
    expect(result.newCode).toBe([
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `  line([10, 10], [20, 20])`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('inserts before the first constraint statement in a solved sketch (layout convention §0.2)', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `import { horizontal, coincident } from 'fluidcad/constraints';`,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  horizontal(a);`,
      `  coincident(a.end(), a.start());`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 3, 'circle([0, 0], 5)');
    expect(result.newCode).toContain([
      `  const a = line([0, 0], [10, 0]);`,
      `  circle([0, 0], 5)`,
      `  horizontal(a);`,
    ].join('\n'));
  });

  it('appends a derived op at the body end of a solved sketch (P6 tail region)', async () => {
    const code = [
      `import { sketch, line, offset } from 'fluidcad/core';`,
      `import { horizontal } from 'fluidcad/constraints';`,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  horizontal(a);`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 3, 'offset(2, a)');
    expect(result.newCode).toContain([
      `  const a = line([0, 0], [10, 0]);`,
      `  horizontal(a);`,
      `  offset(2, a)`,
    ].join('\n'));
  });

  it('inserts solved geometry before an existing derived-op statement', async () => {
    // Without constraints yet, the derived op still marks the tail — a new
    // entity must build before the offset resolves its edges.
    const code = [
      `import { sketch, line, offset } from 'fluidcad/core';`,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  const o = offset(2, a);`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'circle([0, 0], 5)');
    expect(result.newCode).toContain([
      `  const a = line([0, 0], [10, 0]);`,
      `  circle([0, 0], 5)`,
      `  const o = offset(2, a);`,
    ].join('\n'));
  });

  it('appends a derived op before a trailing return in a solved sketch', async () => {
    const code = [
      `import { sketch, line, offset } from 'fluidcad/core';`,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  return { a };`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'offset(2, a)');
    expect(result.newCode).toContain([
      `  const a = line([0, 0], [10, 0]);`,
      `  offset(2, a)`,
      `  return { a };`,
    ].join('\n'));
  });

  it('applies the solved layout to every sketch — geometry inserts before derived ops', async () => {
    // The P6 mode flag is gone: every sketch call gets the solved region
    // convention (geometry → constraints → derived ops), flag or no flag.
    const code = [
      `import { sketch, line, offset } from 'fluidcad/core';`,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  offset(2, a);`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'line([10, 0], [20, 0])');
    expect(result.newCode).toContain([
      `  line([10, 0], [20, 0])`,
      `  offset(2, a);`,
    ].join('\n'));
  });

  it('inserts before a breakpoint() at the end of the sketch body', async () => {
    const code = [
      `import { sketch, line, breakpoint } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `  breakpoint()`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'line([10, 10], [20, 20])');
    expect(result.newCode).toBe([
      `import { sketch, line, breakpoint } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `  line([10, 10], [20, 20])`,
      `  breakpoint()`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('inserts into a sketch with a chained modifier, before its breakpoint()', async () => {
    const code = [
      `import { sketch, line, breakpoint } from 'fluidcad/core';`,
      `const s = sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `  breakpoint()`,
      `}).reusable();`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'line([10, 10], [20, 20])');
    expect(result.newCode).toBe([
      `import { sketch, line, breakpoint } from 'fluidcad/core';`,
      `const s = sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `  line([10, 10], [20, 20])`,
      `  breakpoint()`,
      `}).reusable();`,
      ``,
    ].join('\n'));
  });

  it('inserts into an empty sketch body', async () => {
    const code = [
      `import { sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'circle([5, 5], 10)');
    expect(result.newCode).toBe([
      `import { circle, sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  circle([5, 5], 10)`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('adds missing import symbol', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'point([5, 5])');
    expect(result.newCode).toContain('point,');
    expect(result.newCode).toContain('point([5, 5])');
  });

  it('creates a new import when no fluidcad import exists', async () => {
    const code = [
      `sketch(XY, () => {`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 1, 'line([0, 0], [10, 10])');
    expect(result.newCode).toBe([
      `import { line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `})`,
      ``,
    ].join('\n'));
  });

  it('does not duplicate existing import symbol', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 10])`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'line([20, 20], [30, 30])');
    const importLine = result.newCode.split('\n')[0];
    const importMatches = importLine.match(/line/g);
    expect(importMatches!.length).toBe(1);
  });

  it('inserts a multi-line statement and imports every line\'s callee', async () => {
    const code = [
      `import { sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 0])`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'point([5, 5]);\ntext("Hi").size(14).bold()');
    expect(result.newCode).toBe([
      `import { text, point, sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 0])`,
      `  point([5, 5]);`,
      `  text("Hi").size(14).bold()`,
      `})`,
      ``,
    ].join('\n'));
  });
});

describe('getPointExpression', () => {
  it('reads back both axes as authored', async () => {
    const code = `circle([w / 2, holeY], 20)\n`;
    expect(await getPointExpression(code, 1)).toEqual({ x: 'w / 2', y: 'holeY' });
  });

  it('reads the Nth point of a chain', async () => {
    const code = `arc([0, 0], [10, 10]).center([cx, cy])\n`;
    expect(await getPointExpression(code, 1, 2)).toEqual({ x: 'cx', y: 'cy' });
  });

  it('returns null when the call has no point argument', async () => {
    expect(await getPointExpression(`circle(20)\n`, 1)).toBeNull();
  });

  it('returns null for a point that is not an [x, y] literal', async () => {
    expect(await getPointExpression(`circle(hole.center(), 5)\n`, 1)).toBeNull();
  });
});

describe('updateDimension', () => {
  it('updates the trailing scalar of a two-scalar call', async () => {
    const code = `ellipse(30, 15)\n`;
    const result = await updateDimension(code, 1, 25);
    expect(result.newCode).toBe(`ellipse(30, 25)\n`);
  });

  it('updates the trailing scalar past a start point', async () => {
    const code = `ellipse([5, 10], 30, 20)\n`;
    const result = await updateDimension(code, 1, 35);
    expect(result.newCode).toBe(`ellipse([5, 10], 30, 35)\n`);
  });

  it('updates the diameter of circle', async () => {
    const code = `circle([0, 0], 40)\n`;
    const result = await updateDimension(code, 1, 60);
    expect(result.newCode).toBe(`circle([0, 0], 60)\n`);
  });

  it('updates circle with only diameter', async () => {
    const code = `circle(40)\n`;
    const result = await updateDimension(code, 1, 50);
    expect(result.newCode).toBe(`circle(50)\n`);
  });

  it('updates negative distance', async () => {
    const code = `ellipse(30, -15)\n`;
    const result = await updateDimension(code, 1, -25);
    expect(result.newCode).toBe(`ellipse(30, -25)\n`);
  });

  it('replaces a variable dimension with a literal', async () => {
    const code = `circle(diameter)\n`;
    const result = await updateDimension(code, 1, 42);
    expect(result.newCode).toBe(`circle(42)\n`);
  });

  it('replaces an expression dimension with a literal', async () => {
    const code = `circle([5, 10], height / 2)\n`;
    const result = await updateDimension(code, 1, 100);
    expect(result.newCode).toBe(`circle([5, 10], 100)\n`);
  });
});

describe('updateDimensionExpression with dimensionOffset', () => {
  it('offset 0 targets the last scalar', async () => {
    const code = `ellipse(30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'h', 0);
    expect(result.newCode).toBe(`ellipse(30, h)\n`);
  });

  it('offset 1 targets the first scalar', async () => {
    const code = `ellipse(30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`ellipse(w, 20)\n`);
  });

  it('offset 1 skips the start point array', async () => {
    const code = `ellipse([5, 10], 30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`ellipse([5, 10], w, 20)\n`);
  });

  it('walks through an argument-less chained call to the base args', async () => {
    const code = `ellipse(30, 20).guide()\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`ellipse(w, 20).guide()\n`);
  });
});

describe('getDimensionExpression with dimensionOffset', () => {
  it('dimensionCall reads the base scalar past a chained scalar call', async () => {
    const code = `ellipse(30, 20).rotated(tilt)\n`;
    const result = await getDimensionExpression(code, 1, 0, 'ellipse');
    expect(result?.expression).toBe('20');
  });

  it('dimensionCall reads the chained call scalar', async () => {
    const code = `ellipse(30, 20).rotated(tilt)\n`;
    const result = await getDimensionExpression(code, 1, 0, 'rotated');
    expect(result?.expression).toBe('tilt');
  });

  it('offset 0 returns the last scalar', async () => {
    const code = `ellipse([5, 10], 30, height / 2)\n`;
    const result = await getDimensionExpression(code, 1);
    expect(result?.expression).toBe('height / 2');
  });

  it('offset 1 returns the first scalar', async () => {
    const code = `ellipse([5, 10], -(w), 20)\n`;
    const result = await getDimensionExpression(code, 1, 1);
    expect(result?.expression).toBe('-(w)');
  });

  it('offset 1 walks through an argument-less chained call', async () => {
    const code = `ellipse(30, 20).guide()\n`;
    const result = await getDimensionExpression(code, 1, 1);
    expect(result?.expression).toBe('30');
  });
});

describe('insertLoadCall', () => {
  it('appends the load call after the last statement and imports load', async () => {
    const code = `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`;
    const result = await insertLoadCall(code, 'bracket');
    expect(result.newCode).toBe(
      `import { load, extrude } from 'fluidcad/core';\n\nextrude(10);\n\nload('bracket');\n`,
    );
  });

  it('adds the import statement when the file has none', async () => {
    const code = `extrude(10);\n`;
    const result = await insertLoadCall(code, 'bracket');
    expect(result.newCode).toBe(
      `import { load } from 'fluidcad/core';\nextrude(10);\n\nload('bracket');\n`,
    );
  });

  it('reuses an existing load import', async () => {
    const code = `import { load } from 'fluidcad/core';\n`;
    const result = await insertLoadCall(code, 'bracket');
    expect(result.newCode).toBe(`import { load } from 'fluidcad/core';\n\nload('bracket');\n`);
  });

  it('no-ops when the model is already loaded', async () => {
    const code = `import { load } from 'fluidcad/core';\n\nload('bracket');\n`;
    const result = await insertLoadCall(code, 'bracket');
    expect(result.newCode).toBe(code);
  });

  it('appends a second load for a different model', async () => {
    const code = `import { load } from 'fluidcad/core';\n\nload('bracket');\n`;
    const result = await insertLoadCall(code, 'plate');
    expect(result.newCode).toBe(
      `import { load } from 'fluidcad/core';\n\nload('bracket');\n\nload('plate');\n`,
    );
  });

  it('escapes quotes in the file name', async () => {
    const code = `import { load } from 'fluidcad/core';\n`;
    const result = await insertLoadCall(code, "bob's part");
    expect(result.newCode).toBe(`import { load } from 'fluidcad/core';\n\nload('bob\\'s part');\n`);
  });
});

describe('removeStatement', () => {
  it('removes a bare feature statement and its line', async () => {
    const code = `const s = sketch('xy', () => {});\nextrude(10);\nfillet(2, e.edges());\n`;
    const result = await removeStatement(code, 2);
    expect(result.newCode).toBe(`const s = sketch('xy', () => {});\nfillet(2, e.edges());\n`);
  });

  it('removes a const-bound statement including the binding', async () => {
    const code = `const s = sketch('xy', () => {});\nconst e = extrude(10);\n`;
    const result = await removeStatement(code, 2);
    expect(result.newCode).toBe(`const s = sketch('xy', () => {});\n`);
  });

  it('removes every line of a multi-line statement', async () => {
    const code = `const s = sketch('xy', () => {\n  ellipse(30, 20);\n  circle(5);\n});\nextrude(10);\n`;
    const result = await removeStatement(code, 1);
    expect(result.newCode).toBe(`extrude(10);\n`);
  });

  it('removes a chained multi-line statement', async () => {
    const code = `extrude(10)\n  .pick([1, 2])\n  .symmetric();\nfillet(2, e.edges());\n`;
    const result = await removeStatement(code, 1);
    expect(result.newCode).toBe(`fillet(2, e.edges());\n`);
  });

  it('collapses the doubled blank line left behind', async () => {
    const code = `const a = 1;\n\nextrude(10);\n\nconst b = 2;\n`;
    const result = await removeStatement(code, 3);
    expect(result.newCode).toBe(`const a = 1;\n\nconst b = 2;\n`);
  });

  it('keeps indented statements intact inside a block', async () => {
    const code = `function part() {\n  const s = sketch('xy', () => {});\n  extrude(10);\n  return s;\n}\n`;
    const result = await removeStatement(code, 3);
    expect(result.newCode).toBe(`function part() {\n  const s = sketch('xy', () => {});\n  return s;\n}\n`);
  });

  it('no-ops when no call starts on the line', async () => {
    const code = `const a = 1;\nextrude(10);\n`;
    const result = await removeStatement(code, 1);
    expect(result.newCode).toBe(code);
  });

  // The parts panel's Delete routes an assembly instance here by its
  // serialized source line.
  it('removes a bound insert() chain', async () => {
    const code = `const base = insert(plate).grounded();\nconst arm = insert(lever).translate(0, 10, 0);\n`;
    const result = await removeStatement(code, 2);
    expect(result.newCode).toBe(`const base = insert(plate).grounded();\n`);
  });

  it('excises only the statement when it shares a line', async () => {
    const code = `const a = 1; extrude(10);\n`;
    const result = await removeStatement(code, 1);
    expect(result.newCode).toBe(`const a = 1; \n`);
  });
});

describe('setFeatureName', () => {
  it('appends .name() to a bare feature statement', async () => {
    const code = `extrude(10);\nfillet(2, e.edges());\n`;
    const result = await setFeatureName(code, 1, 'Boss');
    expect(result.newCode).toBe(`extrude(10).name('Boss');\nfillet(2, e.edges());\n`);
  });

  it('appends .name() after existing chains on a const-bound statement', async () => {
    const code = `const e = extrude(10).drill(false);\n`;
    const result = await setFeatureName(code, 1, 'Boss');
    expect(result.newCode).toBe(`const e = extrude(10).drill(false).name('Boss');\n`);
  });

  it('appends .name() after a multi-line sketch body', async () => {
    const code = `const s = sketch('xy', () => {\n  ellipse(30, 20);\n});\n`;
    const result = await setFeatureName(code, 1, 'Base profile');
    expect(result.newCode).toBe(`const s = sketch('xy', () => {\n  ellipse(30, 20);\n}).name('Base profile');\n`);
  });

  it('rewrites an existing .name() argument in place', async () => {
    const code = `extrude(10).name('Old').drill(false);\n`;
    const result = await setFeatureName(code, 1, 'New');
    expect(result.newCode).toBe(`extrude(10).name('New').drill(false);\n`);
  });

  it('removes the .name() chain when the name is empty', async () => {
    const code = `extrude(10).name('Boss');\n`;
    const result = await setFeatureName(code, 1, '');
    expect(result.newCode).toBe(`extrude(10);\n`);
  });

  it('removes a mid-chain .name() when the name is null', async () => {
    const code = `extrude(10).name('Boss').drill(false);\n`;
    const result = await setFeatureName(code, 1, null);
    expect(result.newCode).toBe(`extrude(10).drill(false);\n`);
  });

  it('escapes quotes and collapses whitespace runs in the name', async () => {
    const code = `extrude(10);\n`;
    const result = await setFeatureName(code, 1, "  Bob's\n boss  ");
    expect(result.newCode).toBe(`extrude(10).name('Bob\\'s boss');\n`);
  });

  it('no-ops clearing a statement that has no .name()', async () => {
    const code = `extrude(10);\n`;
    const result = await setFeatureName(code, 1, null);
    expect(result.newCode).toBe(code);
  });

  it('no-ops when no call starts on the line', async () => {
    const code = `const a = 1;\nextrude(10);\n`;
    const result = await setFeatureName(code, 1, 'Boss');
    expect(result.newCode).toBe(code);
  });
});

describe('insertGeometryCallWithVariable', () => {
  it('declares a param() variable at top level, after the imports', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 0]);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'line([0, 0], [depth, 0])',
      { name: 'depth', initializer: 'param("depth", 25)' },
    );
    expect(result.newCode).toContain(
      `import { param, sketch, line } from 'fluidcad/core';\nconst depth = param("depth", 25);\nsketch(XY, () => {`,
    );
    expect(result.newCode).toContain(`line([0, 0], [depth, 0])`);
  });

  it('declares every variable of a multi-dimension commit, in order', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  ellipse(5, 5);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'ellipse(w, h)',
      [
        { name: 'w', initializer: '30' },
        { name: 'h', initializer: 'w / 2' },
      ],
    );
    expect(result.newCode).toContain(`  const w = 30;\n  const h = w / 2;`);
    expect(result.newCode).toContain(`ellipse(w, h)`);
  });

  it('splits a multi-variable commit between param() and sketch-local declarations', async () => {
    const code = [
      `import { sketch, ellipse } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  ellipse(5, 5);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'ellipse(w, h)',
      [
        { name: 'w', initializer: 'param("w", 30)' },
        { name: 'h', initializer: '20' },
      ],
    );
    expect(result.newCode).toContain(`const w = param("w", 30);`);
    expect(result.newCode).toContain(`  const h = 20;`);
    expect(result.newCode).toContain(`ellipse(w, h)`);
  });

  it('leaves imports alone for a plain declaration', async () => {
    const code = [
      `import { sketch, line } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  line([0, 0], [10, 0]);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'line([0, 0], [depth, 0])',
      { name: 'depth', initializer: '25' },
    );
    expect(result.newCode).toContain(`import { sketch, line } from 'fluidcad/core';`);
    expect(result.newCode).toContain(`const depth = 25;`);
  });
});

describe('extractVariablesInScope numeric classification', () => {
  it('marks constants and arithmetic expressions numeric, feature results not', async () => {
    const code = [
      "import { sketch, extrude } from 'fluidcad';",
      'const width = 100;',
      'const half = width / 2;',
      'const angled = Math.sqrt(width) + 2;',
      'const sides = param("Sides", 6);',
      'const profile = sketch(() => {});',
      'const housing = extrude(profile, 10);',
      'const alias = housing;',
      'const depth = housing.faces;',
      'extrude(profile, half);',
    ].join('\n');
    const vars = await extractVariablesInScope(code, Number.MAX_SAFE_INTEGER);
    const numericByName = Object.fromEntries(vars.map(v => [v.name, v.numeric]));
    expect(numericByName).toEqual({
      width: true,
      half: true,
      angled: true,
      sides: true,
      profile: false,
      housing: false,
      alias: false,
      depth: false,
    });
  });

  it('excludes strings, arrays, objects, and arrow functions', async () => {
    const code = [
      "const label = 'lid';",
      'const dims = [10, 20];',
      'const cfg = { w: 5 };',
      'const fn = () => 3;',
      'const size = (2 + 3) * 4;',
      'const pick = size > 10 ? size : 10;',
      'const neg = -size;',
      'extrude(size);',
    ].join('\n');
    const vars = await extractVariablesInScope(code, Number.MAX_SAFE_INTEGER);
    const numericByName = Object.fromEntries(vars.map(v => [v.name, v.numeric]));
    expect(numericByName).toEqual({
      label: false,
      dims: false,
      cfg: false,
      fn: false,
      size: true,
      pick: true,
      neg: true,
    });
  });

  it('sees enclosing assembly-body declarations from a statement inside the body', async () => {
    const code = [
      "import { assembly, insert, param } from 'fluidcad/core';",
      '',
      "export const frame = assembly('frame', () => {",
      "    const width = param('Width', 700);",
      "    const depth = param('Depth', 800);",
      '',
      '    const left = insert(extrusion, { Length: depth });',
      '    const back = insert(extrusion);',
      '',
      '    const late = 5;',
      '});',
    ].join('\n');
    const vars = await extractVariablesInScope(code, 8); // the `back` insert line
    const names = vars.map(v => v.name);
    expect(names).toContain('width');
    expect(names).toContain('depth');
    expect(names).toContain('left');
    // Declared after the target line — out of scope there.
    expect(names).not.toContain('late');
    const width = vars.find(v => v.name === 'width')!;
    expect(width.initializer).toBe("param('Width', 700)");
    expect(width.numeric).toBe(true);
  });
});

describe('readUnitStatement', () => {
  it('reads the first top-level unit() literal with its span', async () => {
    const code = `import { unit, sketch } from 'fluidcad/core';\n\nunit('in');\nsketch('xy', () => {});\n`;
    const found = await readUnitStatement(code);
    expect(found).toEqual({
      unit: 'in',
      row: 2,
      startIndex: code.indexOf(`unit('in')`),
      endIndex: code.indexOf(`unit('in');`) + `unit('in');`.length,
    });
  });

  it('accepts double quotes and reads the literal verbatim', async () => {
    const found = await readUnitStatement(`unit("Inches")\n`);
    expect(found?.unit).toBe('Inches');
  });

  it('is null for a file without one', async () => {
    expect(await readUnitStatement(`const a = 1;\nextrude(10);\n`)).toBeNull();
  });

  it('ignores a unit() that is nested, bound, or given a non-literal', async () => {
    expect(await readUnitStatement(`part('a', () => { unit('in'); });\n`)).toBeNull();
    expect(await readUnitStatement(`const u = unit('in');\n`)).toBeNull();
    expect(await readUnitStatement(`const u = 'in';\nunit(u);\n`)).toBeNull();
    expect(await readUnitStatement(`unit();\n`)).toBeNull();
  });
});

describe('setDocumentUnit', () => {
  it('inserts unit() directly after the imports and adds the import', async () => {
    const code = `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`;
    expect(await setDocumentUnit(code, 'in')).toEqual({
      newCode: `import { unit, extrude } from 'fluidcad/core';\nunit('in');\n\nextrude(10);\n`,
    });
  });

  it('replaces the literal of an existing top-level unit(), keeping its quotes', async () => {
    const code = `import { unit, extrude } from 'fluidcad/core';\n\nunit("mm"); // declared\n\nextrude(10);\n`;
    expect((await setDocumentUnit(code, 'in')).newCode).toBe(
      `import { unit, extrude } from 'fluidcad/core';\n\nunit("in"); // declared\n\nextrude(10);\n`,
    );
  });

  it('is a no-op when the file already declares that unit', async () => {
    const code = `import { unit } from 'fluidcad/core';\nunit('in');\n`;
    expect(await setDocumentUnit(code, 'in')).toEqual({ newCode: code });
  });

  it('lands above param() declarations, where the anchor rule wants the unit', async () => {
    const code = [
      `import { param, extrude } from 'fluidcad/core';`,
      `import { face } from 'fluidcad/filters';`,
      ``,
      `const depth = param('Depth', 10);`,
      `extrude(depth);`,
      ``,
    ].join('\n');
    expect((await setDocumentUnit(code, 'in')).newCode).toBe([
      `import { unit, param, extrude } from 'fluidcad/core';`,
      `import { face } from 'fluidcad/filters';`,
      `unit('in');`,
      ``,
      `const depth = param('Depth', 10);`,
      `extrude(depth);`,
      ``,
    ].join('\n'));
  });

  it('puts the import above the statement in an import-less file', async () => {
    expect((await setDocumentUnit(`extrude(10);\n`, 'mm')).newCode).toBe(
      `import { unit } from 'fluidcad/core';\nunit('mm');\nextrude(10);\n`,
    );
  });

  it('canonicalises the unit spelling and refuses an unknown one', async () => {
    expect((await setDocumentUnit(`extrude(10);\n`, 'inches')).newCode).toContain(`unit('in');`);
    const refused = await setDocumentUnit(`extrude(10);\n`, 'furlong');
    expect(refused.newCode).toBe(`extrude(10);\n`);
    expect(refused.error).toMatch(/Unknown length unit 'furlong'/);
  });

  it('refuses an assembly file without touching it', async () => {
    const code = `import { assembly } from 'fluidcad/core';\nexport const a = () => assembly('a', () => {});\n`;
    const refused = await setDocumentUnit(code, 'in', '/ws/robot.assembly.js');
    expect(refused.newCode).toBe(code);
    expect(refused.error).toMatch(/not allowed in assembly files/);
    // A part path is fine.
    expect((await setDocumentUnit(code, 'in', '/ws/arm.part.js')).error).toBeUndefined();
  });

  describe('unit: null — follow the project unit', () => {
    it('removes the statement line and the now-unused import specifier', async () => {
      const code = `import {unit, extrude } from 'fluidcad/core';\nunit('in');\n\nextrude(10);\n`;
      expect(await setDocumentUnit(code, null)).toEqual({
        newCode: `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`,
      });
    });

    it('takes the comma before a last specifier and collapses a double blank line', async () => {
      const code = `import { extrude, unit } from 'fluidcad/core';\n\nunit("mm"); // declared\n\nextrude(10);\n`;
      expect((await setDocumentUnit(code, null)).newCode).toBe(
        `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`,
      );
    });

    it('keeps the import when another unit identifier is still used', async () => {
      const code = `import { unit, extrude } from 'fluidcad/core';\nunit('in');\nconst u = unit;\nextrude(10);\n`;
      expect((await setDocumentUnit(code, null)).newCode).toBe(
        `import { unit, extrude } from 'fluidcad/core';\nconst u = unit;\nextrude(10);\n`,
      );
    });

    it('removes the whole import line when unit was all it brought in', async () => {
      const code = `import { extrude } from 'fluidcad/core';\nimport { unit } from 'fluidcad';\nunit('in');\nextrude(10);\n`;
      expect((await setDocumentUnit(code, null)).newCode).toBe(
        `import { extrude } from 'fluidcad/core';\nextrude(10);\n`,
      );
    });

    it('is a no-op when the file declares no unit', async () => {
      const code = `import { extrude } from 'fluidcad/core';\nextrude(10);\n`;
      expect(await setDocumentUnit(code, null)).toEqual({ newCode: code });
    });

    it('still refuses an assembly file', async () => {
      const refused = await setDocumentUnit(`// asm\n`, null, '/ws/robot.assembly.js');
      expect(refused.newCode).toBe(`// asm\n`);
      expect(refused.error).toMatch(/not allowed in assembly files/);
    });
  });
});

describe('declareTopLevelVariable', () => {
  it('lands directly after the last import', async () => {
    const code = `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`;
    expect(await declareTopLevelVariable(code, 'depth', 'param("depth", 10)')).toBe(
      `import { extrude } from 'fluidcad/core';\nconst depth = param("depth", 10);\n\nextrude(10);\n`,
    );
  });

  it('lands after the unit() statement so the unit stays first', async () => {
    const code = `import { unit, extrude } from 'fluidcad/core';\n\nunit('in');\n\nextrude(10);\n`;
    expect(await declareTopLevelVariable(code, 'depth', 'param("depth", 10)')).toBe(
      `import { unit, extrude } from 'fluidcad/core';\n\nunit('in');\nconst depth = param("depth", 10);\n\nextrude(10);\n`,
    );
  });

  it('keeps anchoring after the imports when unit() comes before them', async () => {
    // Legal JS (imports hoist) — but the anchor rule is about not splitting
    // "imports, then unit"; a unit written above its imports stays as it is.
    const code = `unit('in');\nimport { unit, extrude } from 'fluidcad/core';\nextrude(10);\n`;
    expect(await declareTopLevelVariable(code, 'depth', '10')).toBe(
      `unit('in');\nimport { unit, extrude } from 'fluidcad/core';\nconst depth = 10;\nextrude(10);\n`,
    );
  });

  it('becomes the first line of an import-less, unit-less file', async () => {
    expect(await declareTopLevelVariable(`extrude(10);\n`, 'depth', '10')).toBe(
      `const depth = 10;\nextrude(10);\n`,
    );
  });

  it('still lets a new import statement go above the unit()', async () => {
    const code = `import { unit } from 'fluidcad/core';\nunit('in');\nface();\n`;
    expect(await ensureSymbolImport(code, 'face', 'fluidcad/filters')).toBe(
      `import { unit } from 'fluidcad/core';\nimport { face } from 'fluidcad/filters';\nunit('in');\nface();\n`,
    );
  });
});

describe('collectBoundNames', () => {
  it('collects import bindings and declarations at every depth', async () => {
    const parser = await getJavaScriptParser();
    const code = [
      `import def, { a, b as c } from './x.js';`,
      `import * as ns from './y.js';`,
      `const d = 1, { e, f: g } = obj, [h] = arr;`,
      `function fn() { let inner = 2; }`,
      `class K {}`,
    ].join('\n');
    const names = collectBoundNames(parser.parse(code));
    for (const expected of ['def', 'a', 'c', 'ns', 'd', 'e', 'g', 'h', 'fn', 'inner', 'K']) {
      expect(names.has(expected), expected).toBe(true);
    }
    // `b` is the imported export name, not the local binding; `f` is a key.
    expect(names.has('b')).toBe(false);
    expect(names.has('f')).toBe(false);
  });
});

describe('importLocalName', () => {
  it('keeps the export name when nothing binds it', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    expect(await importLocalName(code, 'plate', './plate.fluid.js')).toBe('plate');
  });

  it('returns an existing specifier\'s alias for the same module', async () => {
    const code = `import { part as platePart } from './plate.fluid.js';\n`;
    expect(await importLocalName(code, 'part', './plate.fluid.js')).toBe('platePart');
  });

  it('aliases by file stem when another module already binds the name', async () => {
    const code = `import { part } from './plate.fluid.js';\n`;
    expect(await importLocalName(code, 'part', './bracket.fluid.js')).toBe('bracket');
    expect(await importLocalName(code, 'part', './side-plate.part.js')).toBe('sidePlate');
  });

  it('aliases when a local declaration or a core symbol takes the name', async () => {
    const local = `import { insert } from 'fluidcad/core';\nconst plate = 1;\n`;
    // The stem equals the export name here, so the numbered form is next.
    expect(await importLocalName(local, 'plate', './plate.fluid.js')).toBe('plate2');
    expect(await importLocalName(local, 'plate', './plate-v2.fluid.js')).toBe('plateV2');
    const core = `import { insert, part } from 'fluidcad/core';\n`;
    expect(await importLocalName(core, 'part', './plate.fluid.js')).toBe('plate');
  });

  it('falls back to a numbered alias when the stem forms are taken too', async () => {
    const code = [
      `import { part } from './bracket.fluid.js';`,
      `const bracket = 1;`,
      `const bracketPart = 2;`,
    ].join('\n');
    expect(await importLocalName(code, 'part', './bracket.fluid.js')).toBe('part');
    expect(await importLocalName(code, 'part', '../lib/bracket.fluid.js')).toBe('part2');
  });
});

describe('ensureSymbolImport with an alias', () => {
  it('renders `symbol as alias` in a new import statement', async () => {
    const code = `import { part } from './plate.fluid.js';\n`;
    expect(await ensureSymbolImport(code, 'part', './bracket.fluid.js', 'bracket')).toBe(
      `import { part } from './plate.fluid.js';\nimport { part as bracket } from './bracket.fluid.js';\n`,
    );
  });

  it('merges an aliased specifier into an existing import of the module', async () => {
    const code = `import { other } from './parts.fluid.js';\nconst part = 1;\n`;
    expect(await ensureSymbolImport(code, 'part', './parts.fluid.js', 'parts')).toBe(
      `import { part as parts, other } from './parts.fluid.js';\nconst part = 1;\n`,
    );
  });

  it('leaves an existing specifier alone, aliased or not', async () => {
    const code = `import { part as platePart } from './plate.fluid.js';\n`;
    expect(await ensureSymbolImport(code, 'part', './plate.fluid.js', 'platePart')).toBe(code);
    expect(await ensureSymbolImport(code, 'part', './plate.fluid.js')).toBe(code);
  });

  it('ignores an alias equal to the symbol', async () => {
    const code = `import { insert } from 'fluidcad/core';\n`;
    expect(await ensureSymbolImport(code, 'plate', './plate.fluid.js', 'plate')).toBe(
      `import { insert } from 'fluidcad/core';\nimport { plate } from './plate.fluid.js';\n`,
    );
  });
});
