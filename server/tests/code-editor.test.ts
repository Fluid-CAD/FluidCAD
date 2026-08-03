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
  removeStatement,
  setFeatureName,
  setPickPoints,
  setTrimTargets,
  insertGeometryCall,
  insertGeometryCallWithVariable,
  insertLoadCall,
  updateGeometryPosition,
  updateDimension,
  updateDimensionExpression,
  getDimensionExpression,
  getPointExpression,
  updatePointExpression,
  updatePointExpressionWithVariable,
  extractVariablesInScope,
  setRectDimensions,
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

describe('setTrimTargets', () => {
  it('fills an empty trim() and adds the edge filter import', async () => {
    const code = `sketch('xy', () => {\n  rect(80, 60);\n  trim().pick();\n});\n`;
    const result = await setTrimTargets(code, 3, 'edge().line(80)');
    expect(result.newCode).toContain(`trim(edge().line(80)).pick();`);
    expect(result.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
  });

  it('appends to existing trim targets', async () => {
    const code = `import { edge } from 'fluidcad/filters';\ntrim(edge().circle()).pick();\n`;
    const result = await setTrimTargets(code, 2, 'edge().line(30)');
    expect(result.newCode).toBe(
      `import { edge } from 'fluidcad/filters';\ntrim(edge().circle(), edge().line(30)).pick();\n`,
    );
  });

  it('is a no-op when the call on the line is not trim', async () => {
    const code = `extrude(sk).pick();\n`;
    const result = await setTrimTargets(code, 1, 'edge().line(80)');
    expect(result.newCode).toBe(code);
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
      `  rect(10, 10)`,
      `})`,
      ``,
    ].join('\n');
    const result = await insertGeometryCall(code, 2, 'move([5, 5]);\ntext("Hi").size(14).bold()');
    expect(result.newCode).toBe([
      `import { text,move, sketch } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  rect(10, 10)`,
      `  move([5, 5]);`,
      `  text("Hi").size(14).bold()`,
      `})`,
      ``,
    ].join('\n'));
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

  it('replaces a bare variable point argument', async () => {
    const code = `tArc(end)\n`;
    const result = await updateGeometryPosition(code, 1, [350, 290]);
    expect(result.newCode).toBe(`tArc([350, 290])\n`);
  });

  it('replaces a bare variable with a literal point arg following', async () => {
    const code = `line(start, [200, 200])\n`;
    const result = await updateGeometryPosition(code, 1, [100, 100]);
    expect(result.newCode).toBe(`line([100, 100], [200, 200])\n`);
  });

  it('replaces a bare variable without affecting a number arg', async () => {
    const code = `hLine(start, 240)\n`;
    const result = await updateGeometryPosition(code, 1, [50, 60]);
    expect(result.newCode).toBe(`hLine([50, 60], 240)\n`);
  });

  it('replaces a method call point argument', async () => {
    const code = `tArc(l1.start())\n`;
    const result = await updateGeometryPosition(code, 1, [100, 100]);
    expect(result.newCode).toBe(`tArc([100, 100])\n`);
  });

  it('folds a chained reposition into the preceding relative move', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  circle(40)',
      '})',
      '',
    ].join('\n');
    const result = await updateGeometryPosition(code, 3, [12, 1], 0, [10, 6]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(7, -2)',
      '  circle(40)',
      '})',
      '',
    ].join('\n'));
  });

  it('promotes when no relative move precedes the chained call', async () => {
    const code = [
      'sketch("xy", () => {',
      '  line([0, 0], [10, 6])',
      '  circle(40)',
      '})',
      '',
    ].join('\n');
    const result = await updateGeometryPosition(code, 3, [12, 1], 0, [10, 6]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  line([0, 0], [10, 6])',
      '  circle([12, 1], 40)',
      '})',
      '',
    ].join('\n'));
  });
});

describe('updatePointExpression', () => {
  it('writes per-axis expressions verbatim', async () => {
    const code = `circle([5, 10], 20)\n`;
    const result = await updatePointExpression(code, 1, 'w / 2', 'holeY');
    expect(result.newCode).toBe(`circle([w / 2, holeY], 20)\n`);
  });

  it('promotes to the positioned overload when the call has no point yet', async () => {
    const code = `circle(20)\n`;
    const result = await updatePointExpression(code, 1, '100', '103');
    expect(result.newCode).toBe(`circle([100, 103], 20)\n`);
  });

  it('targets the Nth point of a two-point call', async () => {
    const code = `line([0, 0], [20, 30])\n`;
    const result = await updatePointExpression(code, 1, 'a', 'b', 1);
    expect(result.newCode).toBe(`line([0, 0], [a, b])\n`);
  });

  it('reaches a point inside a longer chain', async () => {
    const code = `arc([0, 0], [10, 10]).center([5, 5])\n`;
    const result = await updatePointExpression(code, 1, 'cx', 'cy', 2);
    expect(result.newCode).toBe(`arc([0, 0], [10, 10]).center([cx, cy])\n`);
  });

  // A Point2DLike may be a lazy accessor; overwriting it would silently drop
  // a parametric reference, so the expression editor declines instead.
  it('refuses a lazy-vertex point rather than clobbering it', async () => {
    const code = `circle(hole.center(), 5)\n`;
    const result = await updatePointExpression(code, 1, '1', '2');
    expect(result.newCode).toBe(code);
  });

  it('refuses a point held in a variable', async () => {
    const code = `line(origin, [10, 10])\n`;
    const result = await updatePointExpression(code, 1, '1', '2');
    expect(result.newCode).toBe(code);
  });

  // The relative form the drawing tools emit: repositioning must fold the
  // delta into the preceding move() rather than converting to absolute.
  it('folds a numeric reposition into the preceding relative move', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpression(code, 3, '10', '7', 0, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(7, 7)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n'));
  });

  it('folds a reposition into a move with negative offsets', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(-11.82, -6.73)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpression(code, 3, '7.18', '2.27', 0, [8.18, 3.27]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(-12.82, -7.73)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n'));
  });

  it('keeps the source untouched when the reposition lands on the old point', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpression(code, 3, '8', '3', 0, [8, 3]);
    expect(result.newCode).toBe(code);
  });

  it('promotes instead of folding when the move offsets are expressions', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(dx, 3)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpression(code, 3, '10', '7', 0, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(dx, 3)',
      '  polygon([10, 7], 6, 8.2)',
      '})',
      '',
    ].join('\n'));
  });

  it('promotes an expression commit even when a numeric move precedes', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  polygon(6, 8.2)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpression(code, 3, 'w / 2', '7', 0, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  polygon([w / 2, 7], 6, 8.2)',
      '})',
      '',
    ].join('\n'));
  });
});

describe('setRectDimensions', () => {
  it('rewrites signed dimensions and the start of a positioned rect', async () => {
    const code = `rect([2, 5], 10, -8)\n`;
    const result = await setRectDimensions(code, 1, [3, 6], 12, -9);
    expect(result.newCode).toBe(`rect([3, 6], 12, -9)\n`);
  });

  it('folds a chained rect start move into the preceding relative move', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  rect(10, -8)',
      '})',
      '',
    ].join('\n');
    const result = await setRectDimensions(code, 3, [9, 4], 12, -9, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(6, 4)',
      '  rect(12, -9)',
      '})',
      '',
    ].join('\n'));
  });

  it('keeps a chained rect in place when only the dimensions change', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  rect(10, -8)',
      '})',
      '',
    ].join('\n');
    const result = await setRectDimensions(code, 3, [8, 3], 12, -9, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  rect(12, -9)',
      '})',
      '',
    ].join('\n'));
  });

  it('promotes a chained rect to the positioned form when no move precedes', async () => {
    const code = [
      'sketch("xy", () => {',
      '  line([0, 0], [8, 3])',
      '  rect(10, -8)',
      '})',
      '',
    ].join('\n');
    const result = await setRectDimensions(code, 3, [9, 4], 12, -9, [8, 3]);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  line([0, 0], [8, 3])',
      '  rect([9, 4], 12, -9)',
      '})',
      '',
    ].join('\n'));
  });

  it('leaves the start alone for a chained rect when the old start is unknown', async () => {
    const code = [
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  rect(10, -8)',
      '})',
      '',
    ].join('\n');
    const result = await setRectDimensions(code, 3, [9, 4], 12, -9);
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  move(5, 3)',
      '  rect(12, -9)',
      '})',
      '',
    ].join('\n'));
  });

  it('rewrites dimensions through a chained .centered()', async () => {
    const code = `rect(10, 8).centered()\n`;
    const result = await setRectDimensions(code, 1, null, 12, 9);
    expect(result.newCode).toBe(`rect(12, 9).centered()\n`);
  });
});

describe('updatePointExpressionWithVariable', () => {
  it('declares one variable per axis above the edited statement', async () => {
    const code = [
      'sketch("xy", () => {',
      '  circle([5, 10], 20)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpressionWithVariable(
      code, 2, 'cx', 'cy', 1,
      [{ name: 'cx', initializer: '100' }, { name: 'cy', initializer: '103' }],
    );
    expect(result.newCode).toBe([
      'sketch("xy", () => {',
      '  const cx = 100;',
      '  const cy = 103;',
      '  circle([cx, cy], 20)',
      '})',
      '',
    ].join('\n'));
  });

  it('lands a param() at top level and keeps the edit anchored', async () => {
    const code = [
      'import { circle, sketch } from "fluidcad/core";',
      'sketch("xy", () => {',
      '  circle([5, 10], 20)',
      '})',
      '',
    ].join('\n');
    const result = await updatePointExpressionWithVariable(
      code, 3, 'cx', '10', 2,
      [{ name: 'cx', initializer: 'param("Centre X", 100)' }],
    );
    expect(result.newCode).toContain('const cx = param("Centre X", 100);');
    expect(result.newCode).toContain('circle([cx, 10], 20)');
    expect(result.newCode).toContain('param');
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

describe('updateDimensionExpression with dimensionOffset', () => {
  it('offset 0 targets rect height', async () => {
    const code = `rect(30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'h', 0);
    expect(result.newCode).toBe(`rect(30, h)\n`);
  });

  it('offset 1 targets rect width', async () => {
    const code = `rect(30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`rect(w, 20)\n`);
  });

  it('offset 1 skips the start point array of rect', async () => {
    const code = `rect([5, 10], 30, 20)\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`rect([5, 10], w, 20)\n`);
  });

  it('walks through .centered() to the rect args', async () => {
    const code = `rect(30, 20).centered()\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1);
    expect(result.newCode).toBe(`rect(w, 20).centered()\n`);
  });
});

describe('updateDimensionExpression with dimensionCall', () => {
  it('targets rect height past a .radius() call', async () => {
    const code = `rect(30, 20).radius(5)\n`;
    const result = await updateDimensionExpression(code, 1, 'h', 0, 'rect');
    expect(result.newCode).toBe(`rect(30, h).radius(5)\n`);
  });

  it('targets rect width past .radius() and .centered()', async () => {
    const code = `rect([5, 10], 30, 20).centered().radius(5)\n`;
    const result = await updateDimensionExpression(code, 1, 'w', 1, 'rect');
    expect(result.newCode).toBe(`rect([5, 10], w, 20).centered().radius(5)\n`);
  });

  it('targets a single fillet radius', async () => {
    const code = `rect(30, 20).radius(5)\n`;
    const result = await updateDimensionExpression(code, 1, 'r', 0, 'radius');
    expect(result.newCode).toBe(`rect(30, 20).radius(r)\n`);
  });

  it('targets one radius of a per-corner list by offset from the end', async () => {
    const code = `rect(30, 20).radius(1, 2, 3, 4)\n`;
    const result = await updateDimensionExpression(code, 1, 'r', 1, 'radius');
    expect(result.newCode).toBe(`rect(30, 20).radius(1, 2, r, 4)\n`);
  });

  it('without dimensionCall keeps the outermost-call behavior', async () => {
    const code = `rect(30, 20).radius(5)\n`;
    const result = await updateDimensionExpression(code, 1, '7', 0);
    expect(result.newCode).toBe(`rect(30, 20).radius(7)\n`);
  });
});

describe('updateDimensionExpression with dimensionInsert', () => {
  it('replaces an existing tArc radius in place', async () => {
    const code = `tArc(30, [80, 30])\n`;
    const result = await updateDimensionExpression(code, 1, 'r', 0, 'tArc', true);
    expect(result.newCode).toBe(`tArc(r, [80, 30])\n`);
  });

  it('inserts the radius as first argument of a radius-less tArc', async () => {
    const code = `tArc([80, 30])\n`;
    const result = await updateDimensionExpression(code, 1, '45', 0, 'tArc', true);
    expect(result.newCode).toBe(`tArc(45, [80, 30])\n`);
  });

  it('inserts past a chained call into the named tArc call', async () => {
    const code = `tArc([80, 30]).guide()\n`;
    const result = await updateDimensionExpression(code, 1, '45', 0, 'tArc', true);
    expect(result.newCode).toBe(`tArc(45, [80, 30]).guide()\n`);
  });

  it('without dimensionInsert a radius-less tArc stays untouched', async () => {
    const code = `tArc([80, 30])\n`;
    const result = await updateDimensionExpression(code, 1, '45', 0, 'tArc');
    expect(result.newCode).toBe(code);
  });
});

describe('updateDimensionExpression with dimensionPoint', () => {
  it('replaces the radius and re-aims the endpoint atomically', async () => {
    const code = `tArc(30, [80, 30])\n`;
    const result = await updateDimensionExpression(code, 1, '45', 0, 'tArc', true, [92.43, 17.57]);
    expect(result.newCode).toBe(`tArc(45, [92.43, 17.57])\n`);
  });

  it('inserts the radius and re-aims the endpoint of a radius-less tArc', async () => {
    const code = `tArc([80, 30])\n`;
    const result = await updateDimensionExpression(code, 1, '45', 0, 'tArc', true, [92.43, 17.57]);
    expect(result.newCode).toBe(`tArc(45, [92.43, 17.57])\n`);
  });

  it('re-aims past a chained call and keeps the chain intact', async () => {
    const code = `tArc(30, [80, 30]).guide()\n`;
    const result = await updateDimensionExpression(code, 1, 'r', 0, 'tArc', true, [92.43, 17.57]);
    expect(result.newCode).toBe(`tArc(r, [92.43, 17.57]).guide()\n`);
  });
});

describe('getDimensionExpression with dimensionOffset', () => {
  it('dimensionCall reads rect height past a .radius() call', async () => {
    const code = `rect(30, 20).radius(fillet)\n`;
    const result = await getDimensionExpression(code, 1, 0, 'rect');
    expect(result?.expression).toBe('20');
  });

  it('dimensionCall reads the fillet radius', async () => {
    const code = `rect(30, 20).radius(fillet)\n`;
    const result = await getDimensionExpression(code, 1, 0, 'radius');
    expect(result?.expression).toBe('fillet');
  });

  it('offset 0 returns rect height', async () => {
    const code = `rect([5, 10], 30, height / 2)\n`;
    const result = await getDimensionExpression(code, 1);
    expect(result?.expression).toBe('height / 2');
  });

  it('offset 1 returns rect width', async () => {
    const code = `rect([5, 10], -(w), 20)\n`;
    const result = await getDimensionExpression(code, 1, 1);
    expect(result?.expression).toBe('-(w)');
  });

  it('offset 1 walks through .centered()', async () => {
    const code = `rect(30, 20).centered()\n`;
    const result = await getDimensionExpression(code, 1, 1);
    expect(result?.expression).toBe('30');
  });
});

describe('insertLoadCall', () => {
  it('appends the load call after the last statement and imports load', async () => {
    const code = `import { extrude } from 'fluidcad/core';\n\nextrude(10);\n`;
    const result = await insertLoadCall(code, 'bracket');
    expect(result.newCode).toBe(
      `import {load, extrude } from 'fluidcad/core';\n\nextrude(10);\n\nload('bracket');\n`,
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
    const code = `const s = sketch('xy', () => {\n  rect(30, 20);\n  circle(5);\n});\nextrude(10);\n`;
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
    const code = `const s = sketch('xy', () => {\n  rect(30, 20);\n});\n`;
    const result = await setFeatureName(code, 1, 'Base profile');
    expect(result.newCode).toBe(`const s = sketch('xy', () => {\n  rect(30, 20);\n}).name('Base profile');\n`);
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
      `import {param, sketch, line } from 'fluidcad/core';\nconst depth = param("depth", 25);\nsketch(XY, () => {`,
    );
    expect(result.newCode).toContain(`line([0, 0], [depth, 0])`);
  });

  it('declares every variable of a multi-dimension commit, in order', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  rect(5, 5);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'rect(w, h)',
      [
        { name: 'w', initializer: '30' },
        { name: 'h', initializer: 'w / 2' },
      ],
    );
    expect(result.newCode).toContain(`  const w = 30;\n  const h = w / 2;`);
    expect(result.newCode).toContain(`rect(w, h)`);
  });

  it('splits a multi-variable commit between param() and sketch-local declarations', async () => {
    const code = [
      `import { sketch, rect } from 'fluidcad/core';`,
      `sketch(XY, () => {`,
      `  rect(5, 5);`,
      `});`,
    ].join('\n');
    const result = await insertGeometryCallWithVariable(
      code, 2, 'rect(w, h)',
      [
        { name: 'w', initializer: 'param("w", 30)' },
        { name: 'h', initializer: '20' },
      ],
    );
    expect(result.newCode).toContain(`const w = param("w", 30);`);
    expect(result.newCode).toContain(`  const h = 20;`);
    expect(result.newCode).toContain(`rect(w, h)`);
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
});
