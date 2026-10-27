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
import { newFeatureFileContent } from '../src/file-kind.ts';
import { getFeatureMeta } from '../../lib/dist/index.js';

// The feature catalog over a real workspace: the JS standoff fixture and a
// few small modules, evaluated through the Vite host the engine renders
// with. The workspace sits under the tmpdir's real path — macOS's /var is a
// link, and the host keys modules by real paths.

const FIXTURES = path.resolve(__dirname, 'fixtures/custom-features');

/** A minimal tool feature module: the class, its metadata and the builder. */
function featureModule(options: { id: string; exportName: string; icon?: string; header?: string; label?: string; field?: string; params?: string }): string {
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
    options.field ? `  ${options.field},` : '',
    `  params: ${options.params ?? `{ size: { type: 'length', default: 4 } }`},`,
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
  fs.copyFileSync(path.join(FIXTURES, 'fastener.feature.js'), at('fastener.feature.js'));
  fs.copyFileSync(path.join(FIXTURES, 'fastener.svg'), at('fastener.svg'));
  fs.cpSync(path.join(FIXTURES, 'fastener'), at('fastener'), { recursive: true });
  // An image beside the declared ones that no option names.
  write('fastener/spare.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write('plate-defaults.js', `export const PLATE_LABEL = 'Plate';\n`);
  write('parts/plate.feature.js', featureModule({
    id: 'acme.plate', exportName: 'plate', label: 'PLATE_LABEL',
    header: `import { PLATE_LABEL } from '../plate-defaults.js';`,
  }));
  write('broken.feature.js', featureModule({ id: 'extrude', exportName: 'broken' }));
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
    const standoff = entries.find(entry => entry.id === 'standoff');
    expect(standoff).toMatchObject({
      exportName: 'standoff',
      modulePath: at('standoff.feature.js'),
      builtIn: false,
      meta: {
        id: 'standoff',
        label: 'Standoff',
        icon: './standoff.svg',
        group: 'create',
        kind: 'tool',
        operations: ['add', 'new'],
        call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
        ghost: true,
        contexts: ['part'],
      },
    });
    expect(standoff!.error).toBeUndefined();
    expect(standoff!.meta!.params.face).toEqual({
      picker: 'face', label: 'On face', surface: 'planar',
      description: expect.stringMatching(/^Exactly one planar face to stand on\./),
    });
    expect(standoff!.meta!.params.height).toEqual({
      type: 'length', default: 10, min: 0, label: 'Height',
      description: expect.stringMatching(/^How far the standoff rises from the face/),
    });
    // Plain JSON: what reaches the UI runs no feature code.
    expect(JSON.parse(JSON.stringify(standoff))).toEqual(standoff);
    expect(manager.currentFile).toBe('/ws/live.part.js');
    expect(manager.currentScene).toEqual({ marker: 'live' });
  });

  it('turns a module that does not load into an error entry, and keeps listing the rest', async () => {
    const entries = await list();
    expect(entries.find(entry => entry.modulePath === at('broken.feature.js'))).toMatchObject({
      id: null, exportName: null, meta: null, builtIn: false,
      error: expect.stringContaining(`'extrude' is one of the engine's own types: give the feature another id`),
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
      'broken.feature.js', 'fastener.feature.js', 'helpers.feature.js', 'parts/plate.feature.js', 'standoff.feature.js',
    ]);
    expect((await list()).some(entry => entry.id === 'acme.hidden')).toBe(false);
  });

  it('serves a module from the cache until it or a file it imports changes', async () => {
    await list();
    scans.length = 0;
    await list();
    // Only the module that never loaded is scanned again: a failed scan is never cached.
    expect(scans).toEqual(['broken.feature.js']);

    const source = fs.readFileSync(at('standoff.feature.js'), 'utf8');
    const heightSpec = `type: 'length', default: 10, min: 0,\n    description: 'How far`;
    expect(source).toContain(heightSpec);
    write('standoff.feature.js', source.replace(heightSpec, heightSpec.replace('default: 10', 'default: 12')));
    scans.length = 0;
    const edited = (await list()).find(entry => entry.id === 'standoff');
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

  it('lists the fastener, its choices and their images as declared', async () => {
    const fastener = (await list()).find(entry => entry.exportName === 'fastener');
    expect(fastener?.error).toBeUndefined();
    expect(fastener).toMatchObject({ modulePath: at('fastener.feature.js'), builtIn: false });
    const params = fastener!.meta!.params as Record<string, any>;
    expect(params.size).toMatchObject({ type: 'select', display: 'grid', columns: 3 });
    expect(params.size.options[0]).toMatchObject({ value: 'm3', image: './fastener/m3.svg', when: { standard: 'iso' } });
    // An option's 'when' reaches the dialog as declared; the value it names is listed ahead of it.
    expect(params.standard).toMatchObject({ type: 'radio', display: 'buttons', default: 'iso' });
    expect(Object.keys(params).indexOf('standard')).toBeLessThan(Object.keys(params).indexOf('size'));
    expect(params.head).toMatchObject({ type: 'radio', display: 'cards' });
    expect(params.head.options.map((option: any) => option.image)).toEqual([
      './fastener/plain.svg', './fastener/counterbore.svg', './fastener/countersink.svg',
    ]);
  });

  it('always lists a layout: the one a feature declares as written, else the one derived from its values', async () => {
    const entries = await list();
    // The standoff declares none, and no group or tab: its values in order.
    const standoff = entries.find(entry => entry.exportName === 'standoff')!.meta as Record<string, any>;
    expect(standoff.layout).toEqual(Object.keys(standoff.params));
    expect('aside' in standoff).toBe(false);
    expect('width' in standoff).toBe(false);

    const fastener = entries.find(entry => entry.exportName === 'fastener')!.meta as Record<string, any>;
    expect(fastener.layout).toEqual([
      'at', 'standard', 'size', 'head',
      { note: 'The recess is sized for the head of the screw.', visibleWhen: { head: ['counterbore', 'countersink'] } },
      'depth',
      { image: './fastener/depth.svg', alt: 'The depth, measured from the surface', height: 64 },
      { section: 'Finish', collapsed: true, items: [{ row: ['marking', 'finishes'] }] },
    ]);
    expect(fastener.aside).toEqual([{ image: './fastener/section.svg', alt: 'A section through the hole' }]);
    // Their images are assets like an option's: a save of one is announced.
    expect(catalog.noteFileChange(at('fastener/depth.svg'))).toBe(true);
    expect(catalog.noteFileChange(at('fastener/section.svg'))).toBe(true);
  });

  it('announces a saved image a feature declares, its metadata left as scanned', async () => {
    await list();
    expect(catalog.noteFileChange(at('fastener/m3.svg'))).toBe(true);
    expect(catalog.noteFileChange(at('fastener.svg'))).toBe(true);
    expect(catalog.noteFileChange(at('standoff.svg'))).toBe(true);
    // An image no feature declares reaches nothing, in the same directory or not.
    expect(catalog.noteFileChange(at('fastener/spare.svg'))).toBe(false);
    expect(catalog.noteFileChange(at('other.svg'))).toBe(false);
    scans.length = 0;
    await list();
    expect(scans).not.toContain('fastener.feature.js');
  });

  it('refuses an id two builders share, on both entries', async () => {
    write('copy.feature.js', fs.readFileSync(at('standoff.feature.js'), 'utf8'));
    try {
      const sharing = (await list()).filter(entry => entry.id === 'standoff');
      expect(sharing).toHaveLength(2);
      for (const entry of sharing) {
        expect(entry.error).toContain(`the feature id 'standoff' is used by more than one builder`);
        expect(entry.error).toContain('standoff (copy.feature.js)');
        expect(entry.error).toContain('standoff (standoff.feature.js)');
      }
    } finally {
      remove('copy.feature.js');
    }
    expect((await list()).find(entry => entry.id === 'standoff')!.error).toBeUndefined();
  });

  it('carries how each feature previews: always, behind the toggle, or not at all', async () => {
    write('eager.feature.js', featureModule({ id: 'acme.eager', exportName: 'eager', field: `ghost: 'always'` }));
    write('lazy.feature.js', featureModule({ id: 'acme.lazy', exportName: 'lazy', field: `ghost: 'toggle'` }));
    write('blind.feature.js', featureModule({ id: 'acme.blind', exportName: 'blind', field: 'ghost: false' }));
    write('wrong.feature.js', featureModule({ id: 'acme.wrong', exportName: 'wrong', field: `ghost: 'sometimes'` }));
    try {
      const entries = await list();
      const meta = (id: string) => entries.find(entry => entry.id === id)!.meta;
      expect(meta('acme.eager')).toMatchObject({ ghost: true, ghostMode: 'always' });
      expect(meta('acme.lazy')).toMatchObject({ ghost: true });
      expect(meta('acme.lazy')).not.toHaveProperty('ghostMode');
      expect(meta('acme.blind')).toMatchObject({ ghost: false });
      expect(entries.find(entry => entry.modulePath === at('wrong.feature.js'))).toMatchObject({
        id: null, meta: null, error: expect.stringContaining("'ghost' must be true, false, 'toggle' or 'always', got 'sometimes'"),
      });
    } finally {
      remove('eager.feature.js');
      remove('lazy.feature.js');
      remove('blind.feature.js');
      remove('wrong.feature.js');
    }
  });

  it('turns a module whose metadata declares an illustration or an onChange hook into an error entry saying why', async () => {
    write('sketchy.feature.js', featureModule({ id: 'acme.sketchy', exportName: 'sketchy', field: `illustration: './sketchy.svg'` }));
    write('hooked.feature.js', featureModule({ id: 'acme.hooked', exportName: 'hooked', field: 'onChange: values => ({ values })' }));
    try {
      const entries = await list();
      expect(entries.find(entry => entry.modulePath === at('sketchy.feature.js'))).toMatchObject({
        id: null, meta: null, error: expect.stringContaining("leave 'illustration' out — illustrations aren't supported (custom controls are planned)"),
      });
      expect(entries.find(entry => entry.modulePath === at('hooked.feature.js'))).toMatchObject({
        id: null, meta: null, error: expect.stringContaining("leave 'onChange' out — onChange hooks aren't supported (custom controls are planned)"),
      });
    } finally {
      remove('sketchy.feature.js');
      remove('hooked.feature.js');
    }
  });

  it('turns a module whose edge value declares tangents into an error entry saying why', async () => {
    write('chained.feature.js', featureModule({
      id: 'acme.chained', exportName: 'chained',
      params: `{ size: { type: 'length', default: 4 }, rims: { picker: 'edge', multiple: true, tangents: true } }`,
    }));
    try {
      expect((await list()).find(entry => entry.modulePath === at('chained.feature.js'))).toMatchObject({
        id: null, meta: null, error: expect.stringContaining("param 'rims': leave 'tangents' out — tangent chains are for fillet and chamfer only"),
      });
    } finally {
      remove('chained.feature.js');
    }
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
    expect(getFeatureMeta(first)).toMatchObject({ id: 'standoff', label: 'Standoff', ghost: true, kind: 'tool' });
    // Evaluated in a throwaway scene, the live one restored.
    expect(manager.currentFile).toBe('/ws/live.part.js');
    expect(manager.currentScene).toEqual({ marker: 'live' });

    // Nothing invalidated in between: the same evaluation, the same builder.
    expect(await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'standoff')).toBe(first);
    // A render (or a scan) re-evaluates the module: a builder of its own.
    host.invalidateModule();
    const again = await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'standoff');
    expect(again).not.toBe(first);
    expect(getFeatureMeta(again)!.id).toBe('standoff');
  });

  it('says why a builder cannot be loaded', async () => {
    expect(await FeatureScanner.loadBuilder(host, manager, at('standoff.feature.js'), 'nope'))
      .toEqual({ error: `${at('standoff.feature.js')} exports no 'nope'` });
    const broken = await FeatureScanner.loadBuilder(host, manager, at('broken.feature.js'), 'broken');
    expect(broken).toEqual({ error: expect.stringContaining(`'extrude' is one of the engine's own types: give the feature another id`) });
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
      id: 'standoff', exportName: 'standoff', modulePath: at('standoff.feature.js'),
    });
    expect(await catalog.resolveCallee(parsed, 'plate', at('model.part.js'))).toMatchObject({ id: 'acme.plate' });
    // The export's own name is not bound here; nor is a helper, or a core builder without metadata.
    expect(await catalog.resolveCallee(parsed, 'standoff', at('model.part.js'))).toBeNull();
    expect(await catalog.resolveCallee(parsed, 'helper', at('model.part.js'))).toBeNull();
    expect(await catalog.resolveCallee(parsed, 'sketch', at('model.part.js'))).toBeNull();
  });

  it('resolves the specifier from the importing file’s own directory', async () => {
    const parsed = await tree(`import { standoff } from '../standoff.feature.js';\n`);
    expect(await catalog.resolveCallee(parsed, 'standoff', at('parts/model.part.js'))).toMatchObject({ id: 'standoff' });
    expect(await catalog.resolveCallee(parsed, 'standoff', at('model.part.js'))).toBeNull();
  });

  it('turns a file’s imports into the callees its producer gates read', async () => {
    const callees = await catalog.calleesFor(fs.readFileSync(at('model.part.js'), 'utf8'), at('model.part.js'));
    expect(callees.feature('so')).toEqual({
      id: 'standoff',
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
    expect(callees.produces('standoff', 'so')).toBe(true);
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
    expect(body.features.map((entry: FeatureCatalogEntry) => entry.id)).toContain('standoff');
    // Raw OpenCascade use stays in the engine (a trap's cause); the page shows no mark for it.
    expect(body.features.every((entry: object) => !('usesOcct' in entry))).toBe(true);
  });

  it('serves a feature’s declared icon from its module’s directory', async () => {
    const res = await fetch(`${baseUrl}/features/asset?id=standoff&path=${encodeURIComponent('./standoff.svg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(fs.readFileSync(path.join(FIXTURES, 'standoff.svg'), 'utf8'));
  });

  it('serves the images a layout and an aside declare', async () => {
    const id = (await list()).find(entry => entry.exportName === 'fastener')!.id!;
    for (const file of ['fastener/depth.svg', 'fastener/section.svg']) {
      const res = await fetch(`${baseUrl}/features/asset?id=${id}&path=${encodeURIComponent(`./${file}`)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/svg+xml');
      expect(await res.text()).toBe(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    }
  });

  it('serves an option’s declared image from a directory beside the module', async () => {
    const id = (await list()).find(entry => entry.exportName === 'fastener')!.id!;
    for (const [asked, file] of [['./fastener/m3.svg', 'fastener/m3.svg'], ['./fastener/countersink.svg', 'fastener/countersink.svg'], ['./fastener.svg', 'fastener.svg']]) {
      const res = await fetch(`${baseUrl}/features/asset?id=${id}&path=${encodeURIComponent(asked)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/svg+xml');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    }
  });

  it('refuses a file beside the declared images that no option names, and a declared one spelled another way', async () => {
    const id = (await list()).find(entry => entry.exportName === 'fastener')!.id!;
    for (const asked of ['./fastener/spare.svg', 'fastener/m3.svg', './fastener/../fastener/m3.svg', './fastener/', './standoff.svg']) {
      const res = await fetch(`${baseUrl}/features/asset?id=${id}&path=${encodeURIComponent(asked)}`);
      expect({ asked, status: res.status }).toEqual({ asked, status: 404 });
      expect((await res.json()).error).toContain(`declares no asset '${asked}'`);
    }
    // Another feature's declared image is not this one's.
    expect((await fetch(`${baseUrl}/features/asset?id=standoff&path=${encodeURIComponent('./fastener/m3.svg')}`)).status).toBe(404);
  });

  it('refuses every path the feature does not declare', async () => {
    for (const asked of ['../secret.svg', './model.part.js', 'standoff.svg', '/etc/passwd', './standoff.feature.js']) {
      const res = await fetch(`${baseUrl}/features/asset?id=standoff&path=${encodeURIComponent(asked)}`);
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${baseUrl}/features/asset?id=acme.nothing&path=./standoff.svg`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/features/asset?id=standoff`)).status).toBe(400);
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
      expect((await fetch(`${baseUrl}/features/asset?id=standoff&path=./standoff.svg`)).status).toBe(503);
    } finally {
      engineUp = true;
    }
  });
});

describe('the starter module the editor’s Create feature row writes', () => {
  it('lists as a working create feature named after its file', async () => {
    write('features/my-boss.feature.js', newFeatureFileContent('features/my-boss.feature.js'));
    try {
      const entries = await list();
      const boss = entries.find(entry => entry.id === 'my-boss');
      expect(boss).toMatchObject({
        exportName: 'myBoss',
        modulePath: at('features/my-boss.feature.js'),
        builtIn: false,
        meta: {
          id: 'my-boss',
          label: 'My boss',
          group: 'create',
          kind: 'tool',
          operations: ['add', 'new'],
          call: ['face', { diameter: 'diameter', height: 'height' }],
        },
      });
      expect(boss!.error).toBeUndefined();
      expect(boss!.meta!.params.face).toMatchObject({ picker: 'face', label: 'On face', surface: 'planar' });
      expect(boss!.meta!.params.diameter).toMatchObject({ type: 'length', default: 6, min: 0 });
      expect(boss!.meta!.params.height).toMatchObject({ type: 'length', default: 10, min: 0 });
    } finally {
      remove('features/my-boss.feature.js');
      catalog.noteFileChange(at('features/my-boss.feature.js'));
    }
  });
});
