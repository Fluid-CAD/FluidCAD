import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectEntryFiles } from '../../src/model-package/entry-files.ts';

let ws: string;

function write(rel: string, contents: string) {
  const abs = join(ws, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'fluidshare-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('collectEntryFiles — the source tree a viewer link carries', () => {
  it('gathers the entry and its transitive workspace imports with their paths', async () => {
    write('main.assembly.js', "import { insert } from 'fluidcad/core';\nimport { leaf } from './parts/leaf.part.js';\ninsert(leaf);\n");
    write('parts/leaf.part.js', "import { hole } from '../lib/hole.js';\nexport const leaf = hole(3);\n");
    write('lib/hole.js', 'export const hole = (d) => d;\n');
    write('parts/unused.part.js', 'export const unused = 1;\n');
    write('README.md', '# not code');

    const files = await collectEntryFiles(join(ws, 'main.assembly.js'), ws);

    expect(Object.keys(files).sort()).toEqual(['lib/hole.js', 'main.assembly.js', 'parts/leaf.part.js']);
    expect(files['parts/leaf.part.js']).toContain('export const leaf');
  });

  it('adds init.js when the workspace has one', async () => {
    write('init.js', "import { init } from 'fluidcad';\nexport default await init();\n");
    write('model.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");

    const files = await collectEntryFiles(join(ws, 'model.fluid.js'), ws);

    expect(Object.keys(files).sort()).toEqual(['init.js', 'model.fluid.js']);
  });

  it('ships only the unit of fluidcad.json, and nothing when the project sets none', async () => {
    write('model.fluid.js', "import { circle } from 'fluidcad/core';\ncircle(1);\n");
    write('fluidcad.json', JSON.stringify({ modelId: 'hub-secret-binding', engine: '0.0.42', unit: 'inches' }));

    const files = await collectEntryFiles(join(ws, 'model.fluid.js'), ws);
    expect(Object.keys(files).sort()).toEqual(['fluidcad.json', 'model.fluid.js']);
    expect(JSON.parse(files['fluidcad.json'])).toEqual({ unit: 'in' });

    write('fluidcad.json', JSON.stringify({ modelId: 'hub-secret-binding' }));
    const noUnit = await collectEntryFiles(join(ws, 'model.fluid.js'), ws);
    expect(Object.keys(noUnit)).toEqual(['model.fluid.js']);

    // package.json's fluidcad.unit is the alternative home; it lands in the same file.
    rmSync(join(ws, 'fluidcad.json'));
    write('package.json', JSON.stringify({ name: 'w', fluidcad: { unit: 'cm' } }));
    const fromPkg = await collectEntryFiles(join(ws, 'model.fluid.js'), ws);
    expect(JSON.parse(fromPkg['fluidcad.json'])).toEqual({ unit: 'cm' });
  });

  it('refuses npm dependencies, Node built-ins, and files outside the workspace', async () => {
    mkdirSync(join(ws, 'node_modules', 'dep'), { recursive: true });
    write('node_modules/dep/index.js', 'export const dep = 1;\n');
    write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'index.js' }));
    write('npm.fluid.js', "import { dep } from 'dep';\nexport { dep };\n");
    await expect(collectEntryFiles(join(ws, 'npm.fluid.js'), ws)).rejects.toThrow(/npm dependency/);

    write('fs.fluid.js', "import { readFileSync } from 'fs';\nexport { readFileSync };\n");
    await expect(collectEntryFiles(join(ws, 'fs.fluid.js'), ws)).rejects.toThrow(/not allowed/);

    const outside = mkdtempSync(join(tmpdir(), 'fluidshare-outside-'));
    try {
      writeFileSync(join(outside, 'helper.js'), 'export const h = 1;\n');
      write('escape.fluid.js', `import { h } from '${join(outside, 'helper.js').replace(/\\\\/g, '/')}';\nexport { h };\n`);
      await expect(collectEntryFiles(join(ws, 'escape.fluid.js'), ws)).rejects.toThrow(/outside the workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
