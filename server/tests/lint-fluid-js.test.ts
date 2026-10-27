import { describe, it, expect } from 'vitest';
import { CONFIGURATIONS_AFTER_PARAM_MESSAGE, lintFluidJs } from '../src/lint-fluid-js.ts';
import { CONFIGURATIONS_IN_PARAMS_FILE_MESSAGE } from '../src/global-params/lint.ts';
import { PartRules } from '../../lib/dist/index.js';

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

  it('neither flags a .name() chain nor requires one — names are optional for MCP writers', async () => {
    const named = [
      'import { sketch, circle, extrude } from "fluidcad/core";',
      '',
      'sketch("xy", () => circle(50)).name("Profile");',
      'extrude(20).name("Base");',
      '',
    ].join('\n');
    const unnamed = named.replace('.name("Profile")', '').replace('.name("Base")', '');
    for (const code of [named, unnamed]) {
      const result = await lintFluidJs(code);
      expect(result.missing).toEqual([]);
      expect(result.diagnostics ?? []).toEqual([]);
    }
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

  it('treats a name declared in a callback as a binding there, and only there', async () => {
    const code = [
      'import { part, sketch, point } from "fluidcad/core";',
      'part("Wheel", () => {',
      '  const axis = sketch("xy", () => { point([0, 0]); });',
      '  console.log(axis.geometries);',
      '});',
      'part("Other", (plane) => {',
      '  for (const [i, { edge }] of []) { edge(i); }',
      '  try { plane(); } catch (extrude) { extrude(); }',
      '  return axis;',
      '});',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    // `axis` on line 3 is the callback's own; on line 8 it is the FluidCAD one.
    expect(result.missing).toEqual([{ symbol: 'axis', module: 'fluidcad/core', line: 8, column: 9 }]);
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
      `${header}\nexport const a = part('a', () => {\n  unit('in');\n  sketch('xy', () => { rect(1, 1); });\n});\n`,
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

describe('lintFluidJs — sketch curve symbols', () => {
  it('knows spline() as a fluidcad/core symbol alongside bezier()', async () => {
    const code = [
      'sketch("xy", () => { spline([0, 0], [10, 10], [20, 0]); bezier([0, 0], [10, 10]); });',
      '',
    ].join('\n');
    const result = await lintFluidJs(code);
    expect(result.missing.map((m) => m.symbol).sort()).toEqual(['bezier', 'sketch', 'spline']);
    expect(result.suggestion).toBe('import { bezier, sketch, spline } from "fluidcad/core";');
  });
});

describe('lintFluidJs — configurations() rules', () => {
  const header = `import { assembly, part, param, configurations, sketch, circle } from 'fluidcad/core';`;

  it('is clean for a table declared first in the body', async () => {
    const result = await lintFluidJs(
      `${header}\nexport const f = assembly('f', () => {\n  const c = configurations({ Wide: { Width: 1 } });\n  const w = param('Width', 1);\n});\n`,
      { filePath: '/ws/f.assembly.js' },
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('rejects a table after a param() of the same body, with the fix', async () => {
    const result = await lintFluidJs(
      `${header}\nexport const f = part('f', () => {\n  const w = param('Width', 1);\n  configurations({ Wide: { Width: 2 } });\n});\n`,
      { filePath: '/ws/f.part.js' },
    );
    expect(result.diagnostics).toEqual([{ message: CONFIGURATIONS_AFTER_PARAM_MESSAGE, line: 3, column: 2 }]);
  });

  it('counts a param() nested in an earlier statement, but not one in another body', async () => {
    const nested = await lintFluidJs(
      `${header}\nexport const f = part('f', () => {\n  sketch('xy', () => { circle(param('R', 5)); });\n  configurations({});\n});\n`,
    );
    expect(nested.diagnostics.map((d) => d.message)).toEqual([CONFIGURATIONS_AFTER_PARAM_MESSAGE]);
    // The part() inside the body breaks the export rule, nothing else.
    const other = await lintFluidJs(
      `${header}\nexport const a = assembly('a', () => {\n  const p = part('p', () => { const w = param('W', 1); });\n  configurations({});\n});\n`,
    );
    expect(other.diagnostics.map((d) => d.message)).toEqual([PartRules.nestedMessage('p')]);
  });

  it('checks each part() body of a file on its own', async () => {
    const result = await lintFluidJs(
      `${header}\nexport const a = part('A', () => {\n  configurations({ Wide: { W: 2 } });\n  const w = param('W', 1);\n});\n`
      + `export const b = part('B', () => {\n  configurations({ Wide: { W: 4 } });\n  const w = param('W', 3);\n});\n`
      + `export const c = part('C', () => {\n  const w = param('W', 5);\n  configurations({ Wide: { W: 6 } });\n});\n`,
      { filePath: '/ws/three.part.js' },
    );
    expect(result.diagnostics).toEqual([{ message: CONFIGURATIONS_AFTER_PARAM_MESSAGE, line: 11, column: 2 }]);
  });

  it('rejects configurations() in a params file', async () => {
    const result = await lintFluidJs(
      `import { param, configurations } from 'fluidcad/core';\nexport const w = param('Width', 1);\nconfigurations({ Wide: { Width: 2 } });\n`,
      { filePath: '/ws/project.params.js' },
    );
    expect(result.diagnostics).toEqual([{ message: CONFIGURATIONS_IN_PARAMS_FILE_MESSAGE, line: 2, column: 0 }]);
  });
});

describe('lintFluidJs — part rules', () => {
  const header = `import { assembly, part, param, sketch, extrude } from 'fluidcad/core';`;
  const lint = async (body: string) => (await lintFluidJs(`${header}\n${body}`, { filePath: '/ws/pair.part.js' })).diagnostics;

  it('accepts every exported shape: export const, a chain, an export clause, a factory', async () => {
    expect(await lint([
      "export const plate = part('Plate', () => {});",
      "export const lid = part('Lid', () => {}).name('Lid').material('fluidcad-steel-1020');",
      "const base = part('Base', () => {});",
      "const rib = part('Rib', () => {});",
      "export { base, rib as stiffener };",
      "export const bolt = (length = 10) => part('Bolt', () => {});",
      "export function nut() {\n  return part('Nut', () => {});\n}",
      "export const washer = () => {\n  const w = part('Washer', () => {});\n  return w;\n};",
      '',
    ].join('\n'))).toEqual([]);
  });

  it('refuses a part nothing exports, at its part() call', async () => {
    expect(await lint("part('Plate', () => {});\nconst lid = part('Lid', () => {});\n")).toEqual([
      { message: PartRules.unexportedMessage('Plate'), line: 1, column: 0, rule: 'part-export' },
      { message: PartRules.unexportedMessage('Lid', 'lid'), line: 2, column: 12, rule: 'part-export' },
    ]);
  });

  it('refuses a default export, an export as default, and a part made in a loop', async () => {
    const diagnostics = await lint([
      "export default part('Plate', () => {});",
      "const lid = part('Lid', () => {});",
      "export { lid as default };",
      "for (const n of [1, 2]) {\n  part(`Rib ${n}`, () => {});\n}",
      "function helper() {\n  return part('Helper', () => {});\n}",
      '',
    ].join('\n'));
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [1, PartRules.unexportedMessage('Plate')],
      [2, PartRules.unexportedMessage('Lid', 'lid')],
      [5, PartRules.unexportedMessage('`Rib ${n}`')],
      [8, PartRules.unexportedMessage('Helper')],
    ]);
  });

  it('refuses a part() inside another part or assembly body, and only with that message', async () => {
    const diagnostics = await lint([
      "export const plate = part('Plate', () => {",
      "  const inner = part('Plate', () => {});",
      '});',
      "export const rig = assembly('Rig', () => {",
      "  part('Loose', () => {});",
      '});',
      '',
    ].join('\n'));
    expect(diagnostics).toEqual([
      { message: PartRules.nestedMessage('Plate'), line: 2, column: 16, rule: 'part-export' },
      { message: PartRules.nestedMessage('Loose'), line: 5, column: 2, rule: 'part-export' },
    ]);
  });

  it('refuses a second part of a name, and keeps the first', async () => {
    const diagnostics = await lint([
      "export const plate = part('Plate', () => {});",
      "export const lid = part('Lid', () => {});",
      "export const cover = part('Plate', () => {});",
      "const spare = part('Plate', () => {});",
      '',
    ].join('\n'));
    expect(diagnostics).toEqual([
      { message: PartRules.duplicateMessage('Plate'), line: 3, column: 21, rule: 'part-name' },
      { message: PartRules.unexportedMessage('Plate', 'spare'), line: 4, column: 14, rule: 'part-export' },
      { message: PartRules.duplicateMessage('Plate'), line: 4, column: 14, rule: 'part-name' },
    ]);
  });

  it('leaves a file without part() alone', async () => {
    expect(await lint("sketch('xy', () => {});\nextrude(5);\n")).toEqual([]);
  });
});
