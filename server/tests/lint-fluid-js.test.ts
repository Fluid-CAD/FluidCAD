import { describe, it, expect } from 'vitest';
import { lintFluidJs } from '../src/lint-fluid-js.ts';

describe('lintFluidJs', () => {
  it('reports every FluidCAD symbol used without an import', async () => {
    const code = [
      'sketch("xy", () => rect(100, 50).centered());',
      'extrude(20);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing.map((m) => m.symbol).sort()).toEqual(['extrude', 'rect', 'sketch']);
    expect(result.missing.every((m) => m.module === 'fluidcad/core')).toBe(true);
    expect(result.suggestion).toBe(
      'import { extrude, rect, sketch } from "fluidcad/core";',
    );
  });

  it('accepts the standard fluid.js with all imports present', async () => {
    const code = [
      'import { sketch, rect, extrude } from "fluidcad/core";',
      '',
      'sketch("xy", () => rect(100, 50).centered());',
      'extrude(20);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
    expect(result.suggestion).toBe('');
  });

  it('handles multi-line imports and renamed bindings', async () => {
    const code = [
      'import {',
      '  sketch,',
      '  extrude as ex,',
      '  rect,',
      '} from "fluidcad/core";',
      '',
      'sketch("xy", () => rect(100, 50).centered());',
      'ex(20);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('groups missing symbols by module in the suggestion', async () => {
    const code = [
      'sketch("xy", () => rect(60, 60).centered());',
      'const e = extrude(20);',
      'select(face().planar());',
      'fillet(2);',
      'tCircle(outside(c), outside(d), 10);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    const lines = result.suggestion.split('\n');
    expect(lines).toEqual([
      'import { outside } from "fluidcad/constraints";',
      'import { extrude, fillet, rect, select, sketch, tCircle } from "fluidcad/core";',
      'import { face } from "fluidcad/filters";',
    ]);
  });

  it('ignores method calls on existing objects (e.cut, etc.)', async () => {
    const code = [
      'import { sketch, rect, extrude } from "fluidcad/core";',
      '',
      'sketch("xy", () => rect(10, 10));',
      'const e = extrude(5);',
      'e.endFaces();',     // `endFaces` is not in our table; safe anyway
      'e.cut(5);',         // `cut` IS in the table — but member access => skip
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('ignores object-key uses of symbol names', async () => {
    const code = [
      'import { sketch, rect, extrude, repeat } from "fluidcad/core";',
      '',
      'sketch("xy", () => rect(10, 10));',
      'const e = extrude(5);',
      'repeat("linear", "x", { count: 4, offset: 20 }, e);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('skips strings and comments', async () => {
    const code = [
      'import { sketch, rect, extrude } from "fluidcad/core";',
      '',
      '// use extrude(30) to make a box',
      'const note = "circle, polygon, slot";',
      'sketch("xy", () => rect(10, 10));',
      'extrude(5);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('treats top-level `const` declarations as bindings (shadowing)', async () => {
    const code = [
      'const sketch = 42;',
      'console.log(sketch);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('records the first occurrence line/column for each missing symbol', async () => {
    const code = [
      '// line 0',
      'sketch("xy", () => circle(10));',  // line 1
      '',
      'sketch("xy", () => circle(5));',   // line 3 — same symbol, ignore
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toHaveLength(2);
    const sketch = result.missing.find((m) => m.symbol === 'sketch')!;
    expect(sketch.line).toBe(1);
    expect(sketch.column).toBe(0);
  });
});
