import { describe, it, expect } from 'vitest';
import {
  addBreakpoint,
  removeBreakpoint,
  toggleBreakpoint,
  clearBreakpoints,
  insertPoint,
  removePoint,
  addPick,
  removePick,
  setPickPoints,
  insertGeometryCall,
  updateGeometryPosition,
  updateDimension,
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
// span several rows (e.g. `trim(\n  edge().circle()\n)`) identically to
// single-line calls.
// ---------------------------------------------------------------------------

describe('multi-line calls', () => {
  describe('addPick', () => {
    it('appends .pick() after the closing paren on a later line', async () => {
      const code = `trim(\n  edge().circle()\n)\n`;
      const result = await addPick(code, 1);
      expect(result.newCode).toBe(`trim(\n  edge().circle()\n).pick()\n`);
    });

    it('is a no-op when .pick() already exists on a later line', async () => {
      const code = `trim(\n  edge().circle()\n).pick()\n`;
      const result = await addPick(code, 1);
      expect(result.newCode).toBe(code);
    });

    it('finds the trim call when it is nested inside sk.add on a different row', async () => {
      const code = `sk.add(\n  trim(\n    edge().circle()\n  )\n)\n`;
      const result = await addPick(code, 2);
      expect(result.newCode).toBe(
        `sk.add(\n  trim(\n    edge().circle()\n  ).pick()\n)\n`,
      );
    });
  });

  describe('insertPoint', () => {
    it('inserts into an empty multi-line call', async () => {
      const code = `trim(\n  edge().circle()\n).pick()\n`;
      const result = await insertPoint(code, 1, [5, 6]);
      expect(result.newCode).toBe(
        `trim(\n  edge().circle()\n).pick([5, 6])\n`,
      );
    });

    it('appends to an existing point in a multi-line call', async () => {
      const code = `trim(\n  edge().circle()\n).pick([1, 2])\n`;
      const result = await insertPoint(code, 1, [3, 4]);
      expect(result.newCode).toBe(
        `trim(\n  edge().circle()\n).pick([1, 2], [3, 4])\n`,
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
      const code = `trim(\n  edge().circle()\n).pick([1, 2])\n`;
      const result = await removePick(code, 1);
      expect(result.newCode).toBe(code);
    });
  });

  describe('removePoint', () => {
    it('removes the closest point when the call spans multiple lines', async () => {
      const code = `trim(\n  edge().circle()\n).pick([0, 0], [10, 10])\n`;
      const result = await removePoint(code, 1, [10, 10]);
      expect(result.newCode).toBe(
        `trim(\n  edge().circle()\n).pick([0, 0])\n`,
      );
    });
  });

  describe('setPickPoints', () => {
    it('replaces the argument span of a multi-line call', async () => {
      const code = `trim(\n  edge().circle()\n).pick([1, 1])\n`;
      const result = await setPickPoints(code, 1, [[2, 2], [3, 3]]);
      expect(result.newCode).toBe(
        `trim(\n  edge().circle()\n).pick([2, 2], [3, 3])\n`,
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

  it('inserts into an empty sketch body', async () => {
    const code = [
      `import { sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'circle([5, 5], 10)');
    expect(result.newCode).toBe([
      `import {circle, sketch } from 'fluidcad/core';`,
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
    const result = await insertGeometryCall(code, 2, 'hLine(15)');
    expect(result.newCode).toContain('hLine,');
    expect(result.newCode).toContain('hLine(15)');
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
});

describe('updateGeometryPosition', () => {
  it('replaces an existing point argument', async () => {
    const code = `line([5, 10], [20, 30])\n`;
    const result = await updateGeometryPosition(code, 1, [15, 25]);
    expect(result.newCode).toBe(`line([15, 25], [20, 30])\n`);
  });

  it('replaces the first point even in single-arg overload', async () => {
    const code = `line([20, 30])\n`;
    const result = await updateGeometryPosition(code, 1, [5, 10]);
    expect(result.newCode).toBe(`line([5, 10])\n`);
  });

  it('inserts position before a non-point argument', async () => {
    const code = `circle(40)\n`;
    const result = await updateGeometryPosition(code, 1, [10, 20]);
    expect(result.newCode).toBe(`circle([10, 20], 40)\n`);
  });

  it('replaces a point containing a variable reference', async () => {
    const code = `line([600, height])\n`;
    const result = await updateGeometryPosition(code, 1, [700, 850]);
    expect(result.newCode).toBe(`line([700, 850])\n`);
  });

  it('replaces a point where both elements are variables', async () => {
    const code = `line([x, y])\n`;
    const result = await updateGeometryPosition(code, 1, [100, 200]);
    expect(result.newCode).toBe(`line([100, 200])\n`);
  });

  it('replaces a point containing a binary expression', async () => {
    const code = `line([width / 2, height * 3])\n`;
    const result = await updateGeometryPosition(code, 1, [50, 90]);
    expect(result.newCode).toBe(`line([50, 90])\n`);
  });

  it('replaces the last point with variable in two-arg line', async () => {
    const code = `line([0, 0], [w, h])\n`;
    const result = await updateGeometryPosition(code, 1, [10, 20], -1);
    expect(result.newCode).toBe(`line([0, 0], [10, 20])\n`);
  });
});

describe('updateDimension', () => {
  it('updates the distance of hLine', async () => {
    const code = `hLine(15)\n`;
    const result = await updateDimension(code, 1, 25);
    expect(result.newCode).toBe(`hLine(25)\n`);
  });

  it('updates the distance of vLine with start point', async () => {
    const code = `vLine([5, 10], 20)\n`;
    const result = await updateDimension(code, 1, 35);
    expect(result.newCode).toBe(`vLine([5, 10], 35)\n`);
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
    const code = `hLine(-15)\n`;
    const result = await updateDimension(code, 1, -25);
    expect(result.newCode).toBe(`hLine(-25)\n`);
  });

  it('replaces a variable dimension with a literal', async () => {
    const code = `hLine(distance)\n`;
    const result = await updateDimension(code, 1, 42);
    expect(result.newCode).toBe(`hLine(42)\n`);
  });

  it('replaces an expression dimension with a literal', async () => {
    const code = `vLine([5, 10], height / 2)\n`;
    const result = await updateDimension(code, 1, 100);
    expect(result.newCode).toBe(`vLine([5, 10], 100)\n`);
  });
});
