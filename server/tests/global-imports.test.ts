// Writing the import a dialog expression needs to read a project parameter
// (`docs/global-parameters-plan.md` §2.8): `GlobalImports.ensure` on its own,
// and the paths that run it — the apply-feature-edit dispatcher, the sketch
// dimension and geometry routes — plus the suggestions `/scope-variables`
// appends.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GlobalParamCatalog } from '../src/global-params/catalog.ts';
import { GlobalImports } from '../src/apply-feature-edit/global-imports.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';
import { extractVariablesInPart, extractVariablesInScope } from '../src/code-editor/index.ts';
import { createSketchEditsRouter } from '../src/routes/sketch-edits.ts';
import { normalizePath } from '../src/normalize-path.ts';

const PROJECT = [
  `import { param } from 'fluidcad/core';`,
  ``,
  `export const wall = param('Wall thickness', 3, 'slider', { min: 1, max: 10, step: 0.5 });`,
  `export const bolt = param('Bolt', 'M4', 'select', { options: [{ label: 'M3', value: 'M3' }, { label: 'M4', value: 'M4' }] });`,
  `export const width = param('Width', 120);`,
  `export const rounded = param('Rounded', true);`,
  `export const innerWidth = width - 2 * wall;`,
  ``,
].join('\n');

const TOLERANCES = [
  `import { param } from 'fluidcad/core';`,
  ``,
  `export const clearance = param('Clearance', 0.2);`,
  ``,
].join('\n');

let ws: string;
let catalog: GlobalParamCatalog;

function write(rel: string, contents: string): string {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
  return normalizePath(abs);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-global-imports-')));
  write('project.params.js', PROJECT);
  write('shared/tolerances.params.js', TOLERANCES);
  catalog = new GlobalParamCatalog({ workspacePath: ws, projectUnit: () => 'mm' });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const BRACKET = [
  `import { part, sketch, circle, extrude } from 'fluidcad/core';`,
  ``,
  `export const bracket = part('Bracket', () => {`,
  `  const s = sketch('xy', () => {`,
  `    circle([0, 0], 50);`,
  `  });`,
  `  extrude(10, s);`,
  `});`,
  ``,
].join('\n');

describe('GlobalImports.ensure', () => {
  it('adds a ./ import for a free name the catalog exports', async () => {
    const out = await GlobalImports.ensure(BRACKET, join(ws, 'bracket.part.js'), ['wall * 2'], catalog);
    expect(out).toContain(`import { wall } from './project.params.js';`);
    expect(out.indexOf(`from './project.params.js'`)).toBeGreaterThan(out.indexOf(`from 'fluidcad/core'`));
  });

  it('computes a ../ specifier from a subfolder, one import per params file', async () => {
    const out = await GlobalImports.ensure(
      BRACKET, join(ws, 'parts', 'arm', 'arm.part.js'), ['wall + clearance', 'width'], catalog,
    );
    expect(out).toContain(`import { width, wall } from '../../project.params.js';`);
    expect(out).toContain(`import { clearance } from '../../shared/tolerances.params.js';`);
  });

  it('leaves an aliased import of the params file alone', async () => {
    const code = `import { wall as w } from './project.params.js';\n${BRACKET}`;
    const out = await GlobalImports.ensure(code, join(ws, 'bracket.part.js'), ['w * 2'], catalog);
    expect(out).toBe(code);
  });

  it('leaves an existing import under the exported name alone', async () => {
    const code = `import { wall } from './project.params.js';\n${BRACKET}`;
    const out = await GlobalImports.ensure(code, join(ws, 'bracket.part.js'), ['wall'], catalog);
    expect(out).toBe(code);
  });

  it('ignores a name the file binds itself, at the top level or inside a body', async () => {
    const top = `const wall = 5;\n${BRACKET}`;
    expect(await GlobalImports.ensure(top, join(ws, 'bracket.part.js'), ['wall'], catalog)).toBe(top);
    const nested = BRACKET.replace(`  const s = sketch`, `  const width = 40;\n  const s = sketch`);
    expect(await GlobalImports.ensure(nested, join(ws, 'bracket.part.js'), ['width / 2'], catalog)).toBe(nested);
  });

  it('ignores numbers, unknown names and text that is no expression', async () => {
    const out = await GlobalImports.ensure(
      BRACKET, join(ws, 'bracket.part.js'), [10, 'height * 2', null, undefined, 'a; b'], catalog,
    );
    expect(out).toBe(BRACKET);
  });

  it('collects the expressions of a spec, skipping numbers and name-like fields', () => {
    const expressions = GlobalImports.expressionsOf({
      feature: 'extrude',
      filePath: '/ws/wall.part.js',
      extrude: { op: 'add', distance: 'wall', distance2: null, thin: ['clearance', 2] },
      newVariables: [{ name: 'wall', initializer: 'width / 2' }],
      insertPart: { inserts: [{ exportName: 'bolt', importFrom: './bolt.part.js', params: { Size: { expr: 'bolt' } } }] },
    });
    expect(expressions).toEqual(['wall', 'clearance', 'width / 2', 'bolt']);
  });
});

describe('the transform paths write the import', () => {
  it('an extrude edit with distance: wall ends with the import in the file', async () => {
    const edited = await applyFeatureEdit(BRACKET, {
      feature: 'extrude',
      filePath: join(ws, 'bracket.part.js'),
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 7, column: 2, expectedStatement: 'extrude(10, s)',
        extrude: {
          op: 'add', distance: 'wall', distance2: null, symmetric: false, draft: null, endOffset: null,
          drill: true, thin: null,
        },
      },
    }, { globals: catalog });
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`import { wall } from './project.params.js';`);
    expect(edited.newCode).toContain(`extrude(wall, s)`);
  });

  it('runs no import pass without a catalog', async () => {
    const edited = await applyFeatureEdit(BRACKET, {
      feature: 'extrude',
      filePath: join(ws, 'bracket.part.js'),
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 7, column: 2, expectedStatement: 'extrude(10, s)',
        extrude: {
          op: 'add', distance: 'wall', distance2: null, symmetric: false, draft: null, endOffset: null,
          drill: true, thin: null,
        },
      },
    });
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).not.toContain('params.js');
  });
});

describe('the sketch-edits router', () => {
  let server: http.Server;
  let baseUrl: string;
  let current: string;
  const fakeServer = {
    getCurrentFileName: () => join(ws, 'bracket.part.js'),
    getCurrentCode: () => current,
    getRenderedInstances: () => [],
    getRenderedParts: () => [],
    getParamDefinitions: () => [],
  };

  beforeEach(async () => {
    current = BRACKET;
    const app = express();
    app.use(express.json());
    app.use('/api', createSketchEditsRouter(fakeServer as any, () => {}, ws, undefined, catalog));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  it('update-dimension-expression writes the import the expression needs', async () => {
    const body = await post('/code/update-dimension-expression', {
      code: BRACKET, sourceLine: 5, expression: 'wall * 2', sketchSourceLine: 4,
    });
    expect(body.error).toBeUndefined();
    expect(body.newCode).toContain(`import { wall } from './project.params.js';`);
    expect(body.newCode).toContain(`circle([0, 0], wall * 2);`);
  });

  it('insert-geometry writes the import a new variable initializer needs', async () => {
    const body = await post('/code/insert-geometry', {
      code: BRACKET, sketchSourceLine: 4, statement: 'circle([0, 0], r);',
      newVariable: { name: 'r', initializer: 'innerWidth / 2' },
    });
    expect(body.error).toBeUndefined();
    expect(body.newCode).toContain(`import { innerWidth } from './project.params.js';`);
    expect(body.newCode).toContain(`const r = innerWidth / 2;`);
  });

  it('scope-variables appends the globals with literal initializers after the file\'s own', async () => {
    const body = await post('/scope-variables', { part: { line: 3 } });
    const names = body.variables.map((v: any) => v.name);
    expect(names.slice(0, names.indexOf('wall'))).not.toContain('bolt');
    expect(body.variables.find((v: any) => v.name === 'wall')).toEqual({
      name: 'wall', initializer: '3', numeric: true, value: 3,
      global: { file: 'project.params.js', label: 'Wall thickness', unit: 'mm', imported: false },
    });
    expect(body.variables.find((v: any) => v.name === 'bolt')).toEqual({
      name: 'bolt', initializer: `'M4'`, numeric: false, value: 'M4',
      global: { file: 'project.params.js', label: 'Bolt', imported: false },
    });
    expect(body.variables.find((v: any) => v.name === 'rounded')).toMatchObject({ initializer: 'true', numeric: false });
    expect(body.variables.find((v: any) => v.name === 'innerWidth')).toMatchObject({
      initializer: '114', numeric: true, global: { label: 'innerWidth', unit: 'mm' },
    });
    expect(body.variables.find((v: any) => v.name === 'clearance')).toMatchObject({
      global: { file: 'shared/tolerances.params.js' },
    });
  });
});

describe('collectVariablesInScope with globals', () => {
  async function scopeGlobals() {
    const snapshot = await catalog.snapshot();
    return {
      params: snapshot.files.flatMap((f) => f.params),
      filePath: join(ws, 'bracket.part.js'),
      projectUnit: snapshot.projectUnit,
    };
  }

  it('offers an aliased import under its alias, marked imported', async () => {
    const code = `import { wall as w, bolt } from './project.params.js';\n${BRACKET}`;
    const variables = await extractVariablesInPart(code, 4, undefined, await scopeGlobals());
    expect(variables.filter((v) => v.name === 'w')).toEqual([{
      name: 'w', initializer: '3', numeric: true, value: 3,
      global: { file: 'project.params.js', label: 'Wall thickness', unit: 'mm', imported: true, alias: 'w' },
    }]);
    expect(variables.filter((v) => v.name === 'bolt')).toEqual([{
      name: 'bolt', initializer: `'M4'`, numeric: false, value: 'M4',
      global: { file: 'project.params.js', label: 'Bolt', imported: true },
    }]);
    expect(variables.some((v) => v.name === 'wall')).toBe(false);
  });

  it('hides a global whose name the file binds to something else', async () => {
    const code = BRACKET.replace(`  const s = sketch`, `  const wall = 5;\n  const s = sketch`);
    const variables = await extractVariablesInScope(code, 4, undefined, await scopeGlobals());
    const walls = variables.filter((v) => v.name === 'wall');
    expect(walls).toHaveLength(1);
    expect(walls[0].global).toBeUndefined();
    expect(walls[0].initializer).toBe('5');
    const top = `const width = 40;\n${BRACKET}`;
    const widths = (await extractVariablesInScope(top, 5, undefined, await scopeGlobals())).filter((v) => v.name === 'width');
    expect(widths).toHaveLength(1);
    expect(widths[0].global).toBeUndefined();
  });
});
