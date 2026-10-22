// The global-parameters catalog (`docs/global-parameters-plan.md` §2.6): a
// static scan of every `*.params.js` file in the workspace — rows read off
// `param()` literals, derived exports evaluated across files, the §2.2 rules
// as problems — cached until a file changes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GlobalParamCatalog, lintParamsFile } from '../src/global-params/catalog.ts';
import { normalizePath } from '../src/normalize-path.ts';

let ws: string;

function write(rel: string, contents: string): string {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
  return normalizePath(abs);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-globals-')));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const PROJECT = [
  `import { param } from 'fluidcad/core';`,
  ``,
  `export const wall = param('Wall thickness', 3, 'slider', { min: 1, max: 10, step: 0.5, group: 'Shell' });`,
  `export const boltSize = param('Bolt', 'M4', 'select', { options: [{ label: 'M3', value: 'M3' }, { label: 'M4', value: 'M4' }] });`,
  `export const width = param('Width', 120);`,
  `export const rounded = param('Rounded', true);`,
  `export const innerWidth = width - 2 * wall;`,
  `const sizes = param('Sizes', [1, 2], 'select', { options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }], multi: true });`,
  `export { sizes };`,
  ``,
].join('\n');

describe('GlobalParamCatalog — scan', () => {
  it('lists every exported declaration of a params file with its literals, and evaluates a derived export', async () => {
    const file = write('project.params.js', PROJECT);
    const catalog = new GlobalParamCatalog({ workspacePath: ws, projectUnit: () => 'cm' });
    const snapshot = await catalog.snapshot();

    expect(snapshot.projectUnit).toBe('cm');
    expect(snapshot.files).toHaveLength(1);
    const [listed] = snapshot.files;
    expect(listed.file).toBe(file);
    expect(listed.relPath).toBe('project.params.js');
    expect(listed.problems).toEqual([]);
    expect(listed.params.map((p) => p.name)).toEqual(['wall', 'boltSize', 'width', 'rounded', 'innerWidth', 'sizes']);

    const [wall, bolt, width, rounded, inner, sizes] = listed.params;
    expect(wall).toMatchObject({
      label: 'Wall thickness', controlType: 'slider', defaultValue: 3, value: 3, derived: false, numeric: true,
      min: 1, max: 10, step: 0.5, group: 'Shell', line: 3, column: 20, relPath: 'project.params.js',
    });
    expect(wall.problems).toBeUndefined();
    expect(bolt).toMatchObject({
      label: 'Bolt', controlType: 'select', defaultValue: 'M4', value: 'M4', numeric: false,
      options: [{ label: 'M3', value: 'M3' }, { label: 'M4', value: 'M4' }],
    });
    expect(width).toMatchObject({ label: 'Width', controlType: 'number', defaultValue: 120, value: 120, line: 5 });
    expect(rounded).toMatchObject({ label: 'Rounded', controlType: 'checkbox', defaultValue: true, value: true, numeric: false });
    expect(inner).toMatchObject({
      name: 'innerWidth', label: 'innerWidth', derived: true, expression: 'width - 2 * wall',
      value: 114, defaultValue: 114, numeric: true, controlType: 'number', line: 7, column: 26,
    });
    // Exported through a specifier rather than inline: still a global.
    expect(sizes).toMatchObject({ name: 'sizes', label: 'Sizes', defaultValue: [1, 2], multi: true, controlType: 'select' });
  });

  it('reports a derived export it cannot evaluate as computed at render', async () => {
    write('p.params.js', [
      `import { param } from 'fluidcad/core';`,
      `export const name = param('Name', 'box');`,
      `export const title = name + '-v2';`,
      `export const half = param('Width', 10) / 2;`,
    ].join('\n'));
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    const [title, half] = (await catalog.list()).filter((p) => p.derived);
    expect(title).toMatchObject({ name: 'title', value: null, defaultValue: `name + '-v2'`, numeric: false, controlType: 'text' });
    expect(half).toMatchObject({ name: 'half', value: 5, numeric: true });
  });

  it('resolves a derived export through another params file', async () => {
    write('base.params.js', `import { param } from 'fluidcad/core';\nexport const wall = param('Wall', 2);\n`);
    write('sub/derived.params.js', [
      `import { wall } from '../base.params.js';`,
      `export const doubleWall = wall * 2;`,
    ].join('\n'));
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    expect(await catalog.valueOf(join(ws, 'sub/derived.params.js'), 'doubleWall')).toBe(4);
    expect(await catalog.valueOf(join(ws, 'base.params.js'), 'wall')).toBe(2);
    expect(await catalog.valueOf(join(ws, 'base.params.js'), 'nope')).toBeNull();
    expect(await catalog.valueOf(join(ws, 'missing.params.js'), 'wall')).toBeNull();
  });

  it('attaches the §2.2 problems to the row or the file they concern', async () => {
    write('bad.params.js', [
      `import { param, extrude } from 'fluidcad/core';`,
      `import { bracket } from './bracket.part.js';`,
      `const hidden = param('Hidden', 1);`,
      `export const wall = param('Wall', 3);`,
      `export const again = param('Wall', 4);`,
      `export const made = extrude(wall);`,
      `unit('mm');`,
      `param('Loose', 5);`,
    ].join('\n'));
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    const [file] = (await catalog.snapshot()).files;

    expect(file.problems).toEqual([
      expect.stringMatching(/^line 2: importing the model file ".\/bracket.part.js" from a params file creates a cycle/),
      'line 3: param("Hidden") is not exported — write `export const hidden` so other files can import it',
      'line 7: unit() is not allowed in a params file — its numbers are in the project unit',
      'line 8: param("Loose") must be the initializer of an `export const` — `export const <name> = param(…)`',
    ]);
    const byName = Object.fromEntries(file.params.map((p) => [p.name, p]));
    expect(byName.wall.problems).toBeUndefined();
    expect(byName.again.problems).toEqual(['line 5: the label "Wall" is declared twice — labels are unique within a params file']);
    expect(byName.made.problems).toEqual(['line 6: extrude() is not allowed in a params file — it holds values, not geometry']);
  });

  it('skips gitignored and node_modules params files', async () => {
    write('.gitignore', 'build/\n');
    write('build/gen.params.js', `export const x = 1;`);
    write('node_modules/dep/dep.params.js', `export const y = 1;`);
    write('keep.params.js', `export const z = 1;`);
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    expect(await catalog.listFiles()).toEqual([normalizePath(join(ws, 'keep.params.js'))]);
  });
});

describe('GlobalParamCatalog — cache', () => {
  it('serves the cached scan until a file changes, and rescans after noteFileChange', async () => {
    const file = write('p.params.js', `import { param } from 'fluidcad/core';\nexport const w = param('W', 1);\n`);
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    const first = await catalog.snapshot();
    expect(first.files[0].params[0].value).toBe(1);
    const again = await catalog.snapshot();
    // Nothing changed: the same scanned rows, not a fresh scan.
    expect(again.files[0]).toBe(first.files[0]);

    write('p.params.js', `import { param } from 'fluidcad/core';\nexport const w = param('W', 2);\n`);
    expect(catalog.noteFileChange(file)).toBe(true);
    expect(catalog.noteFileChange(join(ws, 'other.part.js'))).toBe(false);
    const after = await catalog.snapshot();
    expect(after.files[0].params[0].value).toBe(2);
  });

  it('reads the live buffer over the disk and follows the buffer as it changes', async () => {
    const file = write('p.params.js', `import { param } from 'fluidcad/core';\nexport const w = param('W', 1);\n`);
    let buffer: string | null = null;
    const catalog = new GlobalParamCatalog({ workspacePath: ws, readBuffer: (abs) => (abs === file ? buffer : null) });
    expect((await catalog.list())[0].value).toBe(1);

    buffer = `import { param } from 'fluidcad/core';\nexport const w = param('W', 7);\n`;
    expect((await catalog.list())[0].value).toBe(7);
    buffer = `import { param } from 'fluidcad/core';\nexport const w = param('W', 8);\n`;
    expect((await catalog.list())[0].value).toBe(8);
    buffer = null;
    expect((await catalog.list())[0].value).toBe(1);
  });

  it('overlays a rendered runtime value only where the scan could read none', async () => {
    const file = write('p.params.js', [
      `import { param } from 'fluidcad/core';`,
      `const base = Number('2');`,
      `export const w = param('W', 1);`,
      `export const odd = param('Odd', base);`,
    ].join('\n'));
    const catalog = new GlobalParamCatalog({ workspacePath: ws });
    catalog.noteRendered([
      { label: 'W', currentValue: 99, sourceLocation: { filePath: `virtual:live-render:${file}`, line: 3, column: 0 } },
      { label: 'Odd', currentValue: 2, sourceLocation: { filePath: file, line: 4, column: 0 } },
    ]);
    const [w, odd] = (await catalog.snapshot()).files[0].params;
    expect(w.value).toBe(1);
    expect(odd.value).toBe(2);
    expect(odd.problems).toEqual([expect.stringContaining('not a literal the panel can edit')]);
  });
});

describe('lintParamsFile', () => {
  it('passes a well-formed file and flags the rules of §2.2', async () => {
    expect((await lintParamsFile(PROJECT, '/ws/project.params.js')).problems).toEqual([]);
    const { problems } = await lintParamsFile([
      `import { param } from 'fluidcad/core';`,
      `import { mm } from 'fluidcad/units';`,
      `import { other } from './other.params.js';`,
      `import helper from './helper.js';`,
      `export const a = param('A', mm(1));`,
      `export let b = 2;`,
      `export default 3;`,
      `function f() { return param('Inner', 1); }`,
      `export const { c } = { c: 1 };`,
    ].join('\n'), '/ws/x.params.js');
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [3, 'a params file may only import fluidcad/core, fluidcad/units and other *.params.js files, not "./helper.js"'],
      [5, 'a params file exports values with `export const` — functions, classes, `let` and `var` do not belong here'],
      [6, '`export default` is not a global parameter — write `export const <name> = param(…)` instead'],
      [7, 'only imports and `export const` declarations belong at the top level of a params file'],
      [7, 'param("Inner") must be the initializer of an `export const` — `export const <name> = param(…)`'],
      [8, 'export a plain identifier, not a destructuring pattern — other files import a global by its name'],
    ]);
  });
});

describe('lintFluidJs on a params file', () => {
  it('reports the §2.2 rules as diagnostics beside the missing imports', async () => {
    const { lintFluidJs } = await import('../src/lint-fluid-js.ts');
    const result = await lintFluidJs(`export const wall = param('Wall', 3);\nunit('mm');\n`, { filePath: '/ws/p.params.js' });
    expect(result.missing.map((m) => m.symbol)).toEqual(['unit']);
    expect(result.diagnostics).toEqual([
      { line: 1, column: 0, message: 'unit() is not allowed in a params file — its numbers are in the project unit' },
    ]);
    expect((await lintFluidJs(PROJECT, { filePath: '/ws/p.params.js' })).diagnostics).toEqual([]);
  });
});
