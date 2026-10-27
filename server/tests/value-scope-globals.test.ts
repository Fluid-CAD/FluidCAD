// The ghost's value scope reads an imported project parameter off the
// catalog (`docs/global-parameters-plan.md` §2.8): `wall * 2` previews as 6
// when `import { wall } from './project.params.js'` binds a numeric global;
// a non-numeric global and an import of anything else still resolve to null.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GlobalParamCatalog } from '../src/global-params/catalog.ts';
import { ValueScope } from '../src/routes/feature-ghost/value-scope.ts';

let ws: string;
let catalog: GlobalParamCatalog;

function write(rel: string, contents: string): void {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'fluidcad-ghost-globals-')));
  write('project.params.js', [
    `import { param } from 'fluidcad/core';`,
    `export const wall = param('Wall', 3);`,
    `export const bolt = param('Bolt', 'M4');`,
    `export const innerWidth = 120 - 2 * wall;`,
    ``,
  ].join('\n'));
  write('shared/tolerances.params.js', [
    `import { param } from 'fluidcad/core';`,
    `export const clearance = param('Clearance', 0.25);`,
    ``,
  ].join('\n'));
  catalog = new GlobalParamCatalog({ workspacePath: ws });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

async function open(code: string, filePath = join(ws, 'parts', 'bracket.part.js'), globals: GlobalParamCatalog | null = catalog) {
  return ValueScope.open({ code, filePath, definitions: [], ...(globals ? { globals } : {}) }, null);
}

describe('ValueScope with project parameters', () => {
  it('resolves an expression over an imported numeric global', async () => {
    const scope = await open([
      `import { part, extrude } from 'fluidcad/core';`,
      `import { wall, innerWidth } from '../project.params.js';`,
      `import { clearance as c } from '../shared/tolerances.params.js';`,
      `const half = innerWidth / 2;`,
      ``,
    ].join('\n'));
    expect(scope.resolve('wall * 2')).toBe(6);
    expect(scope.resolve('half')).toBe(57);
    expect(scope.resolve('c + wall')).toBe(3.25);
  });

  it('resolves nothing for a non-numeric global, an unknown export, or an import of another module', async () => {
    const scope = await open([
      `import { wall, bolt, missing } from '../project.params.js';`,
      `import { depth } from '../other.part.js';`,
      ``,
    ].join('\n'));
    expect(scope.resolve('bolt')).toBeNull();
    expect(scope.resolve('missing')).toBeNull();
    expect(scope.resolve('depth')).toBeNull();
    expect(scope.resolve('wall')).toBe(3);
  });

  it('resolves nothing for an imported global without a catalog', async () => {
    const scope = await open(`import { wall } from '../project.params.js';\n`, undefined, null);
    expect(scope.resolve('wall')).toBeNull();
  });

  it("reads a global's string or number as a choice's literal, and nothing for an unknown export or another module", async () => {
    const scope = await open([
      `import { wall, bolt, missing } from '../project.params.js';`,
      `import { depth } from '../other.part.js';`,
      ``,
    ].join('\n'));
    expect(scope.literal('bolt')).toBe('M4');
    expect(scope.literal('wall')).toBe(3);
    expect(scope.literal('missing')).toBeNull();
    expect(scope.literal('depth')).toBeNull();
    const bare = await open(`import { bolt } from '../project.params.js';\n`, undefined, null);
    expect(bare.literal('bolt')).toBeNull();
  });
});
