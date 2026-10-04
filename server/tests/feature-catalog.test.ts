import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { LocalSceneHost } from '../src/host/local-scene-host.ts';
import { getJavaScriptParser } from '../src/code-editor/index.ts';
import { FeatureCatalog, type FeatureCatalogEntry } from '../src/feature-catalog/catalog.ts';
import { FeatureScanner, type FeatureScanSceneManager } from '../src/feature-catalog/scan.ts';
import { FeatureModules } from '../src/feature-catalog/walk.ts';
import { createFeatureCatalogRouter } from '../src/routes/feature-catalog.ts';
import { getFeatureMeta } from '../../lib/dist/index.js';

// The feature catalog over a real workspace: the JS standoff fixture and a
// few small modules, evaluated through the Vite host the engine renders
// with. The workspace sits under the tmpdir's real path — macOS's /var is a
// link, and the host keys modules by real paths.

const FIXTURES = path.resolve(__dirname, 'fixtures/custom-features');

/** A minimal tool feature module: the class, its metadata and the builder. */
function featureModule(options: { id: string; exportName: string; icon?: string; header?: string; label?: string }): string {
  return [
    `import { Feature, parseCall, registerBuilder } from 'fluidcad/sdk';`,
    options.header ?? '',
    `class F extends Feature {`,
    `  static id = '${options.id}';`,
    `  buildTool() { return []; }`,
    `}`,
    `const meta = {`,
    `  class: F, label: ${options.label ?? `'${options.exportName}'`}, group: 'create', kind: 'tool',`,
    options.icon ? `  icon: '${options.icon}',` : '',
    `  params: { size: { type: 'length', default: 4 } },`,
    `  call: ['size'],`,
    `};`,
    `export const ${options.exportName} = registerBuilder(`,
    `  context => (...args) => new F(parseCall(meta, args)).addTo(context),`,
    `  { feature: meta },`,
    `);`,
    ``,
  ].join('\n');
}

/** A scene manager stand-in: a feature scan only needs a scene to swap in and out. */
function sceneManager(): FeatureScanSceneManager & { currentScene?: unknown; currentFile?: string } {
  return {
    currentScene: { marker: 'live' },
    currentFile: '/ws/live.part.js',
    startScene: () => ({ marker: 'scan' }),
    setCurrentFile(filePath: string) {
      this.currentFile = filePath;
    },
    disposeScene: () => {},
  };
}

let root: string;
let workspace: string;
let host: LocalSceneHost;
let scans: string[];
let engineUp: boolean;
let catalog: FeatureCatalog;
let manager: ReturnType<typeof sceneManager>;

const at = (rel: string) => path.join(workspace, rel).replace(/\\/g, '/');

/** Write a file and move its mtime forward, so a same-tick rewrite still reads as changed. */
function write(rel: string, content: string): void {
  const file = at(rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 2000 + Math.random() * 1000);
  fs.utimesSync(file, later, later);
}

function remove(rel: string): void {
  fs.rmSync(at(rel), { force: true });
}

async function list(): Promise<FeatureCatalogEntry[]> {
  const entries = await catalog.list();
  expect(entries).not.toBeNull();
  return entries!;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-features-'));
  workspace = path.join(root, 'ws');
  fs.mkdirSync(workspace);
  fs.copyFileSync(path.join(FIXTURES, 'standoff.feature.js'), at('standoff.feature.js'));
  fs.copyFileSync(path.join(FIXTURES, 'standoff.svg'), at('standoff.svg'));
  write('plate-defaults.js', `export const PLATE_LABEL = 'Plate';\n`);
  write('parts/plate.feature.js', featureModule({
    id: 'acme.plate', exportName: 'plate', label: 'PLATE_LABEL',
    header: `import { PLATE_LABEL } from '../plate-defaults.js';`,
  }));
  write('broken.feature.js', featureModule({ id: 'broken', exportName: 'broken' }));
  write('helpers.feature.js', `export const helper = () => 1;\n`);
  write('.gitignore', 'ignored/\n');
  write('ignored/hidden.feature.js', featureModule({ id: 'acme.hidden', exportName: 'hidden' }));
  write('model.part.js', [
    `import { sketch } from 'fluidcad/core';`,
    `import { standoff as so } from './standoff.feature.js';`,
    `import { plate } from './parts/plate.feature.js';`,
    `import { helper } from './helpers.feature.js';`,
    ``,
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  host = new LocalSceneHost();
  await host.init(workspace);
  scans = [];
  engineUp = true;
  manager = sceneManager();
  catalog = new FeatureCatalog({
    workspacePath: workspace,
    scan: async (absPath) => {
      if (!engineUp) {
        return null;
      }
      scans.push(path.relative(workspace, absPath));
      return FeatureScanner.scanFile(host, manager, absPath);
    },
    builtIns: async () => ({}),
  });
});

afterAll(async () => {
  await host?.server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the feature catalog over a workspace', () => {
  it('lists the standoff from its module, as metadata only', async () => {
    const entries = await list();
    const standoff = entries.find(entry => entry.id === 'acme.standoff');
    expect(standoff).toMatchObject({
      exportName: 'standoff',
      modulePath: at('standoff.feature.js'),
      builtIn: false,
      meta: {
        id: 'acme.standoff',
        label: 'Standoff',
        icon: './standoff.svg',
        group: 'create',
        kind: 'tool',
        operations: ['add', 'new'],
        call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
        hasOnChange: false,
        ghost: true,
        contexts: ['part'],
      },
    });
    expect(standoff!.error).toBeUndefined();
    expect(standoff!.meta!.params.face).toEqual({ picker: 'face', label: 'On face', surface: 'planar' });
    expect(standoff!.meta!.params.height).toEqual({ type: 'length', default: 10, min: 0, label: 'Height' });
    // Plain JSON: what reaches the UI runs no feature code.
    expect(JSON.parse(JSON.stringify(standoff))).toEqual(standoff);
    expect(manager.currentFile).toBe('/ws/live.part.js');
    expect(manager.currentScene).toEqual({ marker: 'live' });
  });

  it('turns a module that does not load into an error entry, and keeps listing the rest', async () => {
    const entries = await list();
    expect(entries.find(entry => entry.modulePath === at('broken.feature.js'))).toMatchObject({
      id: null, exportName: null, meta: null, builtIn: false,
      error: expect.stringContaining(`the id 'broken' needs a namespace`),
    });
    expect(entries.find(entry => entry.modulePath === at('helpers.feature.js'))).toMatchObject({
      id: null, error: expect.stringContaining('exports no feature'),
    });
    expect(entries.find(entry => entry.id === 'acme.plate')).toMatchObject({
      exportName: 'plate', modulePath: at('parts/plate.feature.js'), meta: { label: 'Plate' },
    });
  });

  it('walks like the part catalog: gitignored and node_modules modules stay out', async () => {
    const modules = await FeatureModules.list(workspace);
    expect(modules.map(file => path.relative(workspace, file)).sort()).toEqual([
      'broken.feature.js', 'helpers.feature.js', 'parts/plate.feature.js', 'standoff.feature.js',
    ]);
    expect((await list()).some(entry => entry.id === 'acme.hidden')).toBe(false);
  });

  it('serves a module from the cache until it or a file it imports changes', async () => {
    await list();
    scans.length = 0;
    await list();
    // Only the module that never loaded is scanned again: a failed scan is never cached.
    expect(scans).toEqual(['broken.feature.js']);

    write('standoff.feature.js', fs.readFileSync(at('standoff.feature.js'), 'utf8')
      .replace(`height: { type: 'length', default: 10, min: 0 }`, `height: { type: 'length', default: 12, min: 0 }`));
    scans.length = 0;
    const edited = (await list()).find(entry => entry.id === 'acme.standoff');
    expect(edited!.meta!.params.height).toMatchObject({ default: 12 });
    expect(scans).toEqual(['broken.feature.js', 'standoff.feature.js']);

    write('plate-defaults.js', `export const PLATE_LABEL = 'Base plate';\n`);
    scans.length = 0;
    const plate = (await list()).find(entry => entry.id === 'acme.plate');
    expect(plate!.meta!.label).toBe('Base plate');
    expect(scans).toEqual(['broken.feature.js', 'parts/plate.feature.js']);
  });

  it('says which file changes reach the catalog', async () => {
    await list();
    expect(catalog.noteFileChange(at('standoff.feature.js'))).toBe(true);
    expect(catalog.noteFileChange(at('plate-defaults.js'))).toBe(true);
    expect(catalog.noteFileChange(at('model.part.js'))).toBe(false);
    // A removed module is a change too, though nothing caches it any more.
    expect(catalog.noteFileChange(at('gone.feature.js'))).toBe(true);
    scans.length = 0;
    await list();
    expect(scans).toEqual(['broken.feature.js', 'parts/plate.feature.js', 'standoff.feature.js']);
  });

  it('refuses an id two builders share, on both entries', async () => {
    write('copy.feature.js', fs.readFileSync(at('standoff.feature.js'), 'utf8'));
    try {
      const sharing = (await list()).filter(entry => entry.id === 'acme.standoff');
      expect(sharing).toHaveLength(2);
      for (const entry of sharing) {
        expect(entry.error).toContain(`the feature id 'acme.standoff' is used by more than one builder`);
        expect(entry.error).toContain('standoff (copy.feature.js)');
        expect(entry.error).toContain('standoff (standoff.feature.js)');
      }
    } finally {
      remove('copy.feature.js');
    }
    expect((await list()).find(entry => entry.id === 'acme.standoff')!.error).toBeUndefined();
  });

  it('answers null while the engine is not up', async () => {
    engineUp = false;
    try {
      catalog.noteFileChange(at('standoff.feature.js'));
      expect(await catalog.list()).toBeNull();
    } finally {
      engineUp = true;
    }
  });
});

describe('FeatureScanner.loadBuilder', () => {
  it('loads the builder a ghost constructs the feature from, from the loader\'s cache when the module is evaluated', async () => {
    host.invalidateModule();
    const first = await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'standoff');
    expect(typeof first).toBe('function');
    expect(getFeatureMeta(first)).toMatchObject({ id: 'acme.standoff', label: 'Standoff', ghost: true, kind: 'tool' });
    // Evaluated in a throwaway scene, the live one restored.
    expect(manager.currentFile).toBe('/ws/live.part.js');
    expect(manager.currentScene).toEqual({ marker: 'live' });

    // Nothing invalidated in between: the same evaluation, the same builder.
    expect(await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'standoff')).toBe(first);
    // A render (or a scan) re-evaluates the module: a builder of its own.
    host.invalidateModule();
    const again = await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'standoff');
    expect(again).not.toBe(first);
    expect(getFeatureMeta(again)!.id).toBe('acme.standoff');
  });

  it('says why a builder cannot be loaded', async () => {
    expect(await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'nope'))
      .toEqual({ error: `${at('standoff.feature.js')} exports no 'nope'` });
    const broken = await FeatureScanner.loadBuilder(host, manager, at('broken.feature.js'), 'broken');
    expect(broken).toEqual({ error: expect.stringContaining(`the id 'broken' needs a namespace`) });
    expect(manager.currentScene).toEqual({ marker: 'live' });
  });
});

describe('resolveCallee', () => {
  async function tree(code: string) {
    return (await getJavaScriptParser()).parse(code);
  }

  it('follows the file’s import of a name to the feature, aliases included', async () => {
    const code = fs.readFileSync(at('model.part.js'), 'utf8');
    const parsed = await tree(code);
    expect(await catalog.resolveCallee(parsed, 'so', at('model.part.js'))).toMatchObject({
      id: 'acme.standoff', exportName: 'standoff', modulePath: at('standoff.feature.js'),
    });
    expect(await catalog.resolveCallee(parsed, 'plate', at('model.part.js'))).toMatchObject({ id: 'acme.plate' });
    // The export's own name is not bound here; nor is a helper, or a core builder without metadata.
    expect(await catalog.resolveCallee(parsed, 'standoff', at('model.part.js'))).toBeNull();
    expect(await catalog.resolveCallee(parsed, 'helper', at('model.part.js'))).toBeNull();
    expect(await catalog.resolveCallee(parsed, 'sketch', at('model.part.js'))).toBeNull();
  });

  it('resolves the specifier from the importing file’s own directory', async () => {
    const parsed = await tree(`import { standoff } from '../standoff.feature.js';\n`);
    expect(await catalog.resolveCallee(parsed, 'standoff', at('parts/model.part.js'))).toMatchObject({ id: 'acme.standoff' });
    expect(await catalog.resolveCallee(parsed, 'standoff', at('model.part.js'))).toBeNull();
  });

  it('turns a file’s imports into the callees its producer gates read', async () => {
    const callees = await catalog.calleesFor(fs.readFileSync(at('model.part.js'), 'utf8'), at('model.part.js'));
    expect(callees.feature('so')).toEqual({
      id: 'acme.standoff',
      kind: 'tool',
      // The shape the edit dialog reads and writes the call by, with the
      // defaults a value left out ahead of a later argument writes.
      shape: {
        call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
        operations: ['add', 'new'],
        params: {
          face: { picker: 'face', list: false },
          height: { type: 'length', list: false, default: 12 },
          outer: { type: 'length', list: false, default: 6 },
          hole: { type: 'length', list: false, default: 3 },
        },
      },
    });
    expect(callees.feature('plate')).toMatchObject({ id: 'acme.plate', kind: 'tool' });
    expect(callees.feature('helper')).toBeNull();
    expect(callees.produces('acme.standoff', 'so')).toBe(true);
  });
});

describe('the feature catalog routes', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api', createFeatureCatalogRouter(catalog, workspace));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}/api`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('lists the catalog', async () => {
    const res = await fetch(`${baseUrl}/features/catalog`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspacePath).toBe(workspace);
    expect(body.features.map((entry: FeatureCatalogEntry) => entry.id)).toContain('acme.standoff');
  });

  it('serves a feature’s declared icon from its module’s directory', async () => {
    const res = await fetch(`${baseUrl}/features/asset?id=acme.standoff&path=${encodeURIComponent('./standoff.svg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(fs.readFileSync(path.join(FIXTURES, 'standoff.svg'), 'utf8'));
  });

  it('refuses every path the feature does not declare', async () => {
    for (const asked of ['../secret.svg', './model.part.js', 'standoff.svg', '/etc/passwd', './standoff.feature.js']) {
      const res = await fetch(`${baseUrl}/features/asset?id=acme.standoff&path=${encodeURIComponent(asked)}`);
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${baseUrl}/features/asset?id=acme.nothing&path=./standoff.svg`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/features/asset?id=acme.standoff`)).status).toBe(400);
  });

  it('refuses a declared icon that links outside the module’s directory', async () => {
    write('gear.feature.js', featureModule({ id: 'acme.gear', exportName: 'gear', icon: './gear.svg' }));
    fs.symlinkSync(path.join(root, 'secret.svg'), at('gear.svg'));
    try {
      const res = await fetch(`${baseUrl}/features/asset?id=acme.gear&path=${encodeURIComponent('./gear.svg')}`);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toContain('outside');
    } finally {
      remove('gear.feature.js');
      remove('gear.svg');
    }
  });

  it('answers 503 while the engine is not up', async () => {
    engineUp = false;
    try {
      catalog.noteFileChange(at('standoff.feature.js'));
      expect((await fetch(`${baseUrl}/features/catalog`)).status).toBe(503);
      expect((await fetch(`${baseUrl}/features/asset?id=acme.standoff&path=./standoff.svg`)).status).toBe(503);
    } finally {
      engineUp = true;
    }
  });
});
