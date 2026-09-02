import { describe, it, expect } from 'vitest';
import { lintFluidJs } from '../src/lint-fluid-js.ts';

describe('lintFluidJs', () => {
  it('reports every FluidCAD symbol used without an import', async () => {
    const code = [
      'sketch("xy", () => circle(50));',
      'extrude(20);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing.map((m) => m.symbol).sort()).toEqual(['circle', 'extrude', 'sketch']);
    expect(result.missing.every((m) => m.module === 'fluidcad/core')).toBe(true);
    expect(result.suggestion).toBe(
      'import { circle, extrude, sketch } from "fluidcad/core";',
    );
  });

  it('accepts the standard fluid.js with all imports present', async () => {
    const code = [
      'import { sketch, circle, extrude } from "fluidcad/core";',
      '',
      'sketch("xy", () => circle(50));',
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
      '  circle,',
      '} from "fluidcad/core";',
      '',
      'sketch("xy", () => circle(50));',
      'ex(20);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('groups missing symbols by module in the suggestion', async () => {
    const code = [
      'sketch("xy", () => circle(60));',
      'const e = extrude(20);',
      'select(face().planar());',
      'fillet(2);',
      'coincident(c.end(), d.start());',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    const lines = result.suggestion.split('\n');
    expect(lines).toEqual([
      'import { coincident } from "fluidcad/constraints";',
      'import { circle, extrude, fillet, select, sketch } from "fluidcad/core";',
      'import { face } from "fluidcad/filters";',
    ]);
  });

  it('ignores method calls on existing objects (e.cut, etc.)', async () => {
    const code = [
      'import { sketch, circle, extrude } from "fluidcad/core";',
      '',
      'sketch("xy", () => circle(10));',
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
      'import { sketch, circle, extrude, repeat } from "fluidcad/core";',
      '',
      'sketch("xy", () => circle(10));',
      'const e = extrude(5);',
      'repeat("linear", "x", { count: 4, offset: 20 }, e);',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing).toEqual([]);
  });

  it('skips strings and comments', async () => {
    const code = [
      'import { sketch, circle, extrude } from "fluidcad/core";',
      '',
      '// use extrude(30) to make a box',
      'const note = "line, ellipse, arc";',
      'sketch("xy", () => circle(10));',
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

describe('lintFluidJs — unit symbols', () => {
  it('reports unit() without its import, from fluidcad/core', async () => {
    const result = await lintFluidJs(`unit('in');\n`);
    expect(result.missing).toEqual([{ symbol: 'unit', module: 'fluidcad/core', line: 0, column: 0 }]);
    expect(result.suggestion).toBe(`import { unit } from "fluidcad/core";`);
  });

  it('reports the conversion helpers only when they are called', async () => {
    const code = [
      `import { extrude, sketch, circle } from 'fluidcad/core';`,
      `sketch('xy', () => { circle(mm(3.2)); });`,
      `extrude(inch(1));`,
      `const scale = (m) => m * 2;`,
      `const cm = 10;`,
      `let ft;`,
      `extrude(cm + scale(ft));`,
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing.map((m) => m.symbol)).toEqual(['inch', 'mm']);
    expect(result.suggestion).toBe(`import { inch, mm } from "fluidcad/units";`);
  });
});

describe('lintFluidJs — unit() placement diagnostics', () => {
  const header = `import { unit, sketch, rect, extrude, part } from 'fluidcad/core';`;

  it('is clean for a well-placed unit()', async () => {
    const result = await lintFluidJs(
      `${header}\nunit('in');\nconst w = 4;\nsketch('xy', () => { rect(w, 2); });\nextrude(1);\n`,
      { filePath: '/ws/bracket.fluid.js' },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts every alias the project config does', async () => {
    const result = await lintFluidJs(`${header}\nunit("Inches");\n`);
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects unit() in an assembly file, wherever it sits', async () => {
    const result = await lintFluidJs(
      `${header}\nunit('in');\n`,
      { filePath: '/ws/rig.assembly.js' },
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('not allowed in assembly files');
    expect(result.diagnostics[0].line).toBe(1);
  });

  it('rejects unit() inside a part() callback', async () => {
    const result = await lintFluidJs(
      `${header}\npart('a', () => {\n  unit('in');\n  sketch('xy', () => { rect(1, 1); });\n});\n`,
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('top level');
    expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 2 });
  });

  it('rejects unit() after geometry', async () => {
    const result = await lintFluidJs(
      `${header}\nsketch('xy', () => { rect(1, 1); });\nunit('in');\n`,
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('before any geometry');
    expect(result.diagnostics[0].line).toBe(2);
  });

  it('does not count value declarations or breakpoint() as geometry', async () => {
    const result = await lintFluidJs(
      `${header}\nimport { param, breakpoint } from 'fluidcad/core';\nconst w = param('w', 4);\nbreakpoint();\nunit('in');\n`,
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects a second top-level unit()', async () => {
    const result = await lintFluidJs(`${header}\nunit('in');\nunit('mm');\n`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('already called');
    expect(result.diagnostics[0].line).toBe(2);
  });

  it('rejects a non-literal or missing argument', async () => {
    const result = await lintFluidJs(`${header}\nconst u = 'in';\nunit(u);\n`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain('string literal');

    const none = await lintFluidJs(`${header}\nunit();\n`);
    expect(none.diagnostics[0].message).toContain('string literal');
  });

  it('rejects an unknown unit literal with the accepted list', async () => {
    const result = await lintFluidJs(`${header}\nunit('yd');\n`);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toBe("Unknown length unit 'yd'. Use one of: mm, cm, m, in, ft.");
  });

  it("leaves a user's own unit binding alone", async () => {
    const result = await lintFluidJs(
      `import { extrude } from 'fluidcad/core';\nfunction unit(v) { return v; }\nextrude(5);\nunit('whatever');\nunit(3);\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
