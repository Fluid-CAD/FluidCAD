import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import { createApplyFeatureRouter } from '../../src/routes/apply-feature/index.ts';
import { createFeatureCatalogRouter } from '../../src/routes/feature-catalog.ts';
import { FeatureCatalog, type FeatureCatalogEntry } from '../../src/feature-catalog/catalog.ts';
import { applyFeatureEdit, FeatureCallees, type ApplyFeatureEditSpec } from '../../src/apply-feature-edit/index.ts';
import { getJavaScriptParser } from '../../src/code-editor/index.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import { PackageProject } from '../packages/package-project.ts';

// Stage P6: the feature catalog lists installed packages' features — the
// pinned ones, and the library's newest version of each one the project
// doesn't pin (K7) — from their manifests' snapshots, at their declaring
// modules. A dialog's create writes `import { standoff } from '@acme/kit'`,
// a statement calling the package's builder parses back through the
// catalog, and using a library feature pins its package first. The scene
// is faked, as in the custom feature route tests; the packages are real
// directories in a temp library (`FLUIDCAD_PACKAGES`).

const PLATE = [
  `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
  ``,
  `const s = sketch('xz', () => { rect(10, 10) })`,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const p = part('Body', () => {})`,
  ``,
].join('\n');

const PLACED = [
  `import { sketch, rect, extrude } from 'fluidcad/core'`,
  `import { standoff as so } from '@acme/kit'`,
  ``,
  `sketch('xy', () => { rect(40, 40) })`,
  `const e = extrude(10)`,
  `const s = so(e.endFaces(), { height: 12, outer: 2 * r }).new().name('boss')`,
  ``,
].join('\n');

const FACE_PICK = { shapeId: 'shape-1', sub: { type: 'face', index: 4 } };

let project: PackageProject;
let model: string;
let currentCode: string;
let slotAnswer: any;
let relayed: any[];
/** What `fluidcad.json` held when each edit reached the editor. */
let configAtSend: unknown[];
let server: http.Server | null = null;

/** `e.endFaces()` for the face slot: one part on the extrude at line 5. */
function faceAnswer(): any {
  return {
    ok: true,
    filePath: model,
    producers: [{ line: 5, column: 10, featureType: 'extrude', nameHint: 'e', bind: true }],
    parts: [{ producer: 0, accessor: 'endFaces', indices: null, filterArgs: null, refs: null }],
    imports: [],
    slots: { face: { parts: [0], args: ['e.endFaces()'], wrap: null } },
  };
}

/** The catalog over the temp project: no workspace module evaluates, so every entry comes from a package. */
function catalog(): FeatureCatalog {
  return new FeatureCatalog({
    workspacePath: project.root,
    scan: async (absPath) => ({ file: absPath, features: [], error: `cannot load ${absPath}`, deps: [] }),
    builtIns: async () => ({}),
  });
}

async function serve(features = catalog()): Promise<string> {
  const fakeServer = {
    getCurrentCode: () => currentCode,
    getCurrentFileName: () => model,
    getParamDefinitions: () => [],
    synthesizeFeatureSlots: () => slotAnswer,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApplyFeatureRouter(fakeServer as any, (msg: any) => {
    relayed.push(msg);
    configAtSend.push(readProjectConfig(project.root).dependencies ?? null);
  }, { callees: features, catalog: features }));
  app.use('/api', createFeatureCatalogRouter(features, project.root));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A standoff create on the plate's top face. */
function standoffBody(extra: Record<string, unknown> = {}) {
  return {
    feature: 'custom',
    custom: { id: '@acme/kit:acme.standoff', values: { height: 12 }, picks: { face: [{ kind: 'entities', entities: [FACE_PICK] }] } },
    ...extra,
  };
}

/** Install `@acme/kit` `version` and pin it. */
async function pinKit(version = '0.1.0'): Promise<string> {
  const { dir, integrity } = await project.install('@acme/kit', version);
  project.config({ '@acme/kit': { version, integrity } });
  return dir;
}

async function list(features = catalog()): Promise<FeatureCatalogEntry[]> {
  const entries = await features.list();
  expect(entries).not.toBeNull();
  return entries!;
}

beforeEach(() => {
  project = new PackageProject('fluidcad-package-features-');
  model = project.at('model.part.js');
  PackageManifests.forget();
  currentCode = PLATE;
  slotAnswer = faceAnswer();
  relayed = [];
  configAtSend = [];
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  project.dispose();
});

describe('the feature catalog lists packages', () => {
  it('lists a pinned package’s features from its manifest, at the declaring module', async () => {
    const dir = await pinKit();
    const [entry] = await list();
    expect(entry).toMatchObject({
      id: '@acme/kit:acme.standoff',
      exportName: 'standoff',
      modulePath: `${dir}/standoff.feature.js`,
      builtIn: false,
      package: { name: '@acme/kit', version: '0.1.0', availability: 'dependency' },
    });
    // The manifest's snapshot, keyed by the package it is installed as (the manifest keeps the plain id).
    const snapshot = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8')).features[0].meta;
    expect(snapshot.id).toBe('acme.standoff');
    expect(entry.meta).toEqual({ ...snapshot, id: '@acme/kit:acme.standoff' });
    expect(entry.error).toBeUndefined();
  });

  it('offers the library’s newest version of a package the project does not pin, and only the pinned one of one it does', async () => {
    await project.install('@acme/kit', '0.1.0');
    const newer = await project.install('@acme/kit', '0.2.0');
    project.config(null);
    expect((await list()).map(e => [e.modulePath, e.package])).toEqual([
      [`${newer.dir}/standoff.feature.js`, { name: '@acme/kit', version: '0.2.0', availability: 'library' }],
    ]);

    const pinned = project.packageDir('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity: TreeHash.ofDirectorySync(pinned) } });
    expect((await list()).map(e => [e.modulePath, e.package])).toEqual([
      [`${pinned}/standoff.feature.js`, { name: '@acme/kit', version: '0.1.0', availability: 'dependency' }],
    ]);
  });

  it('ignores an older manifest\'s usesOcct: a kernel trap\'s disclosure reads the installed source', async () => {
    await project.install('@acme/kit', '0.1.0', {
      edit: (dir) => {
        const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, 'utf8'));
        manifest.features[0].usesOcct = true;
        fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest));
      },
    });
    project.config(null);
    const features = catalog();
    const [entry] = await list(features);
    expect(entry).not.toHaveProperty('usesOcct');
    expect(await features.disclosure(entry.id!)).toEqual({ label: 'Standoff', usesOcct: false });
  });

  it('names raw OpenCascade in a trap\'s disclosure when the installed module reaches it', async () => {
    await project.install('@acme/kit', '0.1.0', {
      edit: (dir) => {
        const source = fs.readFileSync(`${dir}/standoff.feature.js`, 'utf8');
        fs.writeFileSync(`${dir}/standoff.feature.js`, `import { getOC } from 'fluidcad/sdk/occt';\n${source}`);
      },
    });
    project.config(null);
    const features = catalog();
    const [entry] = await list(features);
    expect(await features.disclosure(entry.id!)).toEqual({ label: 'Standoff', usesOcct: true });
    expect(await features.disclosure('@acme/kit:nothing')).toBeNull();
  });

  it('gives a pinned package it can’t load as error entries with the render’s sentence, and a missing one as nothing', async () => {
    const { integrity } = await project.install('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity: integrity.replace(/.=$/, 'A=') } });
    const [entry] = await list();
    expect(entry).toMatchObject({ id: '@acme/kit:acme.standoff', package: { availability: 'dependency' } });
    expect(entry.error).toBe('The installed `@acme/kit` 0.1.0 differs from the one this project was built with.');

    project.config({ '@acme/kit': { version: '0.3.0', integrity } });
    expect(await list()).toEqual([]);
  });

  it('leaves out the package the workspace is itself, by its bare name, whoever published it', async () => {
    const acme = await project.install('@acme/kit', '0.1.0');
    project.config(null, { package: { name: 'kit', version: '0.3.0' } });
    expect(await list()).toEqual([]);

    // Another publisher's package of the same name is left out in that author's workspace too.
    fs.cpSync(acme.dir, project.packageDir('@bea-tools/kit', '0.1.0'), { recursive: true });
    expect(await list()).toEqual([]);

    // Any other workspace is offered both, keyed apart.
    project.config(null, { package: { name: 'gears', version: '0.1.0' } });
    expect((await list()).map(e => [e.id, e.error])).toEqual([
      ['@acme/kit:acme.standoff', undefined], ['@bea-tools/kit:acme.standoff', undefined],
    ]);
  });

  it('offers a library feature beside the workspace\'s own feature of the same plain id: their keys differ', async () => {
    await project.install('@acme/kit', '0.1.0');
    project.config(null);
    project.write('standoff.feature.js', '// scanned by the fake\n');
    const own = project.at('standoff.feature.js');
    const features = new FeatureCatalog({
      workspacePath: project.root,
      scan: async (absPath) => ({ file: absPath, features: [{ exportName: 'standoff', meta: { id: 'acme.standoff', label: 'Mine' } as any }], deps: [] }),
      builtIns: async () => ({}),
    });
    const entries = await list(features);
    expect(entries.find(e => e.modulePath === own)).toMatchObject({ id: 'acme.standoff' });
    expect(entries.find(e => e.id === '@acme/kit:acme.standoff')).toMatchObject({ package: { name: '@acme/kit', availability: 'library' } });
    expect(entries.every(e => e.error === undefined)).toBe(true);
  });

  it('says the catalog may have changed when the project’s fluidcad.json does', () => {
    const features = catalog();
    expect(features.noteFileChange(project.at('fluidcad.json'))).toBe(true);
    expect(features.noteFileChange(project.at('notes/fluidcad.json'))).toBe(false);
  });

  it('follows a pinned bare import, alias included, to the feature it names', async () => {
    await pinKit();
    const features = catalog();
    const callees = await features.calleesFor(PLACED, model);
    expect(callees.feature('so')).toMatchObject({ id: '@acme/kit:acme.standoff', kind: 'tool' });
    expect(callees.feature('so')?.shape?.call).toEqual(['face', { height: 'height', outer: 'outer', hole: 'hole' }]);
    const tree = (await getJavaScriptParser()).parse(PLACED);
    expect((await features.resolveCallee(tree, 'so', model))?.id).toBe('@acme/kit:acme.standoff');

    // Unpinned, the import names nothing the catalog follows (the render refuses it).
    project.config(null);
    expect(await catalog().calleesFor(PLACED, model)).toBe(FeatureCallees.BUILT_IN);
  });
});

describe('a package feature’s images', () => {
  it('serves its icon from beside its declaring module', async () => {
    const dir = await pinKit();
    const base = await serve();
    const res = await fetch(`${base}/features/asset?id=${encodeURIComponent('@acme/kit:acme.standoff')}&path=${encodeURIComponent('./standoff.svg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(await res.text()).toBe(fs.readFileSync(`${dir}/standoff.svg`, 'utf8'));
  });

  it('refuses a path the metadata does not declare, and a declared one that leads outside the module’s directory', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0', {
      edit: (copy) => {
        // A hand-edited manifest declares an icon one level up, where a file waits.
        const manifest = JSON.parse(fs.readFileSync(`${copy}/manifest.json`, 'utf8'));
        manifest.features[0].meta.icon = '../outside.svg';
        fs.writeFileSync(`${copy}/manifest.json`, JSON.stringify(manifest));
      },
    });
    fs.writeFileSync(`${dir}/../outside.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    const base = await serve();
    const undeclared = await fetch(`${base}/features/asset?id=${encodeURIComponent('@acme/kit:acme.standoff')}&path=${encodeURIComponent('../../../etc/passwd')}`);
    expect(undeclared.status).toBe(404);
    const escaping = await fetch(`${base}/features/asset?id=${encodeURIComponent('@acme/kit:acme.standoff')}&path=${encodeURIComponent('../outside.svg')}`);
    expect(escaping.status).toBe(403);
    expect((await escaping.json()).error).toContain('leads outside its module');
  });
});

describe('creating with a package feature', () => {
  it('writes the import with the package’s bare name, and pins nothing for a pinned package', async () => {
    const dir = await pinKit();
    const before = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    const base = await serve();
    const preview = await post(`${base}/apply-feature`, standoffBody({ preview: true }));
    expect(preview.body).toEqual({ success: true, preview: 'standoff(e.endFaces(), { height: 12 })', args: { face: ['e.endFaces()'] } });

    const applied = await post(`${base}/apply-feature`, standoffBody());
    expect(applied.status).toBe(200);
    const spec = relayed[0].spec;
    expect(spec.custom).toMatchObject({ exportName: 'standoff', modulePath: `${dir}/standoff.feature.js`, importFrom: '@acme/kit' });
    const written = await post(`${base}/code/apply-feature`, { code: PLATE, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`import { standoff } from '@acme/kit';`);
    expect(written.body.newCode).toContain(`const p = part('Body', () => {})\nstandoff(e.endFaces(), { height: 12 })\n`);
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(before);
  });

  it('finds each of two publishers\' same-named features by its key, and writes the import from its own package (HD29)', async () => {
    const acme = await project.install('@acme/kit', '0.1.0');
    const beaDir = project.packageDir('@bea-tools/kit', '0.1.0');
    fs.cpSync(acme.dir, beaDir, { recursive: true });
    project.config({
      '@acme/kit': { version: '0.1.0', integrity: acme.integrity },
      '@bea-tools/kit': { version: '0.1.0', integrity: TreeHash.ofDirectorySync(beaDir) },
    });
    expect((await list()).map(e => [e.id, e.error])).toEqual([
      ['@acme/kit:acme.standoff', undefined], ['@bea-tools/kit:acme.standoff', undefined],
    ]);
    const base = await serve();
    const applied = await post(`${base}/apply-feature`, {
      ...standoffBody(), custom: { ...standoffBody().custom, id: '@bea-tools/kit:acme.standoff' },
    });
    expect(applied.status).toBe(200);
    const spec = relayed[0].spec;
    expect(spec.custom).toMatchObject({ exportName: 'standoff', modulePath: `${beaDir}/standoff.feature.js`, importFrom: '@bea-tools/kit' });
    const written = await post(`${base}/code/apply-feature`, { code: PLATE, spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode).toContain(`import { standoff } from '@bea-tools/kit';`);
    expect(written.body.newCode).not.toMatch(/kit:/);
  });

  it('calls the builder by the alias an existing import of the package gives it', async () => {
    await pinKit();
    currentCode = PLACED.replace(`const s = so(e.endFaces(), { height: 12, outer: 2 * r }).new().name('boss')\n`, '');
    const base = await serve();
    const applied = await post(`${base}/apply-feature`, standoffBody());
    expect(applied.body.preview).toBe('so(e.endFaces(), { height: 12 })');
    const written = await post(`${base}/code/apply-feature`, { code: currentCode, spec: relayed[0].spec });
    expect(written.body.error).toBeUndefined();
    expect(written.body.newCode.match(/from '@acme\/kit'/g)).toHaveLength(1);
    expect(written.body.newCode).toContain(`so(e.endFaces(), { height: 12 })`);
  });

  it('pins a library package before the statement reaches the editor, and copies no files', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const base = await serve();
    // A preview pins nothing.
    expect((await post(`${base}/apply-feature`, standoffBody({ preview: true }))).status).toBe(200);
    expect(readProjectConfig(project.root).dependencies ?? null).toBeNull();

    const applied = await post(`${base}/apply-feature`, standoffBody());
    expect(applied.status).toBe(200);
    // The pin was on disk when the edit was sent, and is the version and hash the library holds.
    expect(configAtSend).toEqual([{ '@acme/kit': { version: '0.1.0', integrity } }]);
    expect(relayed[0].spec.custom).toMatchObject({ modulePath: `${dir}/standoff.feature.js`, importFrom: '@acme/kit' });
    expect(fs.existsSync(project.at('packages'))).toBe(false);
    const written = await post(`${base}/code/apply-feature`, { code: PLATE, spec: relayed[0].spec });
    expect(written.body.newCode).toContain(`import { standoff } from '@acme/kit';`);
    // The next listing has it as a dependency.
    expect((await list())[0].package).toEqual({ name: '@acme/kit', version: '0.1.0', availability: 'dependency' });
  });

  it('refuses the create, and sends nothing, when the pin can’t be written', async () => {
    await project.install('@acme/kit', '0.1.0');
    project.config(null, { dependencies: { '@acme/kit': 'latest' } });
    const before = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    const base = await serve();
    const applied = await post(`${base}/apply-feature`, standoffBody());
    expect(applied.status).toBe(422);
    expect(applied.body.reason).toContain('Fix it first.');
    expect(relayed).toEqual([]);
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(before);
  });
});

describe('editing a package feature’s statement', () => {
  beforeEach(() => {
    currentCode = PLACED;
  });

  it('reads the statement back through the catalog, and previews an edit', async () => {
    await pinKit();
    const base = await serve();
    const parsed = await post(`${base}/feature/parse`, { line: 6, filePath: model });
    expect(parsed.status).toBe(200);
    expect(parsed.body.parsed).toMatchObject({ feature: 'custom', id: '@acme/kit:acme.standoff', callee: 'so', values: { height: 12, outer: '2 * r' }, operation: 'new' });

    const preview = await post(`${base}/apply-feature`, {
      feature: 'custom',
      edit: { filePath: model, line: 6, column: 10 },
      custom: { id: '@acme/kit:acme.standoff', values: { height: 20 } },
      preview: true,
      expectedStatement: `so(e.endFaces(), { height: 12, outer: 2 * r }).new()`,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(`so(e.endFaces(), { height: 20, outer: 2 * r }).new()`);
  });

  it('is not read as the feature while the project does not pin the package', async () => {
    await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const base = await serve();
    const parsed = await post(`${base}/feature/parse`, { line: 6, filePath: model });
    expect(parsed.body.parsed?.feature).not.toBe('custom');
  });
});

describe('producer gates through a package import', () => {
  /** A fillet on the end edges of the standoff statement at line 6. */
  const filletSpec = (): ApplyFeatureEditSpec => ({
    feature: 'fillet',
    value: 0.5,
    filePath: model,
    producers: [{ line: 6, column: 0, featureType: '@acme/kit:acme.standoff', nameHint: 'f', bind: true }],
    parts: [{ producer: 0, accessor: 'endEdges', indices: null, filterArgs: null }],
    imports: [],
  });

  it('binds a fillet to the standoff statement with the catalog, and refuses it without', async () => {
    await pinKit();
    const refused = await applyFeatureEdit(PLACED, filletSpec());
    expect(refused.error).toContain('expected a @acme/kit:acme.standoff()-producing call');
    const bound = await applyFeatureEdit(PLACED, filletSpec(), { callees: catalog() });
    expect(bound.error).toBeUndefined();
    expect(bound.newCode).toContain(`const s = so(e.endFaces(), { height: 12, outer: 2 * r }).new().name('boss')\nfillet(0.5, s.endEdges())`);
  });
});
