// The unit warning on a project parameter read across a unit boundary
// (`docs/global-parameters-plan.md` §2.7): a numeric global read in a file
// whose `unit()` differs from the project unit is reported with the
// "wrap it in mm(...)" fix; a read already inside a converter, a
// non-numeric global, a shadowed name, or a file in the project unit is not.

import { describe, it, expect } from 'vitest';
import { getJavaScriptParser } from '../src/code-editor/index.ts';
import { globalUnitMessage, lintGlobalParamUnits, type NumericGlobal } from '../src/unit-lint.ts';

const GLOBALS: NumericGlobal[] = [
  { file: '/ws/project.params.js', name: 'wall', numeric: true },
  { file: '/ws/project.params.js', name: 'bolt', numeric: false },
  { file: '/ws/shared/tolerances.params.js', name: 'clearance', numeric: true },
];

async function lint(code: string, filePath = '/ws/parts/bracket.part.js', fileUnit: 'in' | 'mm' | null = 'in') {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  return lintGlobalParamUnits(tree.rootNode as any, filePath, { fileUnit, projectUnit: 'mm', globals: GLOBALS });
}

describe('lintGlobalParamUnits', () => {
  it('reports each read of a numeric global in a file of another unit', async () => {
    const code = [
      `import { unit, extrude } from 'fluidcad/core';`,
      `import { wall, bolt } from '../project.params.js';`,
      `import { clearance as c } from '../shared/tolerances.params.js';`,
      `unit('in');`,
      `extrude(wall);`,
      `const gap = c * 2;`,
      `const size = bolt;`,
      ``,
    ].join('\n');
    const diagnostics = await lint(code);
    expect(diagnostics).toEqual([
      { message: globalUnitMessage('wall', 'mm', 'in'), line: 4, column: 8 },
      { message: globalUnitMessage('clearance', 'mm', 'in'), line: 5, column: 12 },
    ]);
    expect(diagnostics[0].message).toBe('`wall` is a project parameter in mm; this file is in in — wrap it in mm(...)');
  });

  it('passes a read inside a unit converter, arithmetic around it included', async () => {
    const code = [
      `import { wall } from '../project.params.js';`,
      `import { mm } from 'fluidcad/units';`,
      `const a = mm(wall);`,
      `const b = mm(wall * 2 + 1);`,
      `const c = mm((wall));`,
      `const d = Math.max(wall, 2);`,
      ``,
    ].join('\n');
    const diagnostics = await lint(code);
    expect(diagnostics.map((d) => d.line)).toEqual([5]);
  });

  it('ignores a name a nested scope shadows', async () => {
    const code = [
      `import { wall } from '../project.params.js';`,
      `const f = (wall) => wall * 2;`,
      `const g = () => { const wall = 1; return wall; };`,
      `const h = wall;`,
      ``,
    ].join('\n');
    const diagnostics = await lint(code);
    expect(diagnostics.map((d) => d.line)).toEqual([3]);
  });

  it('reports nothing when the file reads in the project unit, declares none, or imports no params file', async () => {
    const code = `import { wall } from '../project.params.js';\nconst h = wall;\n`;
    expect(await lint(code, '/ws/parts/bracket.part.js', 'mm')).toEqual([]);
    expect(await lint(code, '/ws/parts/bracket.part.js', null)).toEqual([]);
    expect(await lint(`import { wall } from './other.part.js';\nconst h = wall;\n`)).toEqual([]);
    // The import resolves to another path than the catalog's file: not a known global.
    expect(await lint(code, '/ws/bracket.part.js')).toEqual([]);
  });
});

describe('lintFluidJs with globalUnits', () => {
  it('appends the unit warning to the unit-order diagnostics of a model file', async () => {
    const { lintFluidJs } = await import('../src/lint-fluid-js.ts');
    const code = [
      `import { unit, extrude } from 'fluidcad/core';`,
      `import { wall } from './project.params.js';`,
      `unit('in');`,
      `extrude(wall);`,
      ``,
    ].join('\n');
    const result = await lintFluidJs(code, {
      filePath: '/ws/bracket.part.js',
      globalUnits: { fileUnit: 'in', projectUnit: 'mm', globals: GLOBALS },
    });
    expect(result.diagnostics.map((d) => d.message)).toEqual([globalUnitMessage('wall', 'mm', 'in')]);
    const bare = await lintFluidJs(code, { filePath: '/ws/bracket.part.js' });
    expect(bare.diagnostics).toEqual([]);
  });
});
