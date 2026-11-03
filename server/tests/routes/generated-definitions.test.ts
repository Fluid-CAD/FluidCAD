import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'node:http';
import path from 'path';
import { createPartCatalogRouter } from '../../src/routes/part-catalog.ts';
import { createInstancePoseRouter } from '../../src/routes/instance-pose.ts';
import { createTimelineRouter } from '../../src/routes/timeline.ts';
import { createSketchEditsRouter } from '../../src/routes/sketch-edits.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import { PackageEditGuard } from '../../src/packages/package-edit-guard.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { GeneratedRows } from '../../src/generated-rows.ts';
import { GeneratedCatalog } from '../../src/part-catalog/generated.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import type { PartScanResult } from '../../src/part-catalog/scan.ts';
import { PackageProject } from '../packages/package-project.ts';

// The server's side of generated definitions (generators S4), the engine
// faked: the catalog's image route (only a declared image, under the base it
// is declared for, and never beyond the package or workspace that owns its
// module); the insert writer and the Edit-parameters merge keyed by id; and
// the read-only rule (G8) over engine-owned rows, by statement and by row.

const ASSEMBLY = [
  `import { insert } from 'fluidcad/core';`,
  `import { crate } from './assemblies/crate.assembly.js';`,
  ``,
  `const crate1 = insert(crate, { width: 60 }).name('crate1');`,
  ``,
].join('\n');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>\n';

let project: PackageProject;
let assemblyFile: string;
let currentCode: string;
let relayed: any[];
let scans: string[];
let results: Map<string, PartScanResult>;
let rows: GeneratedRows;
let adopted: string[];
let server: http.Server | null = null;
let base: string;

/** A generated entry of a scan: `schema` images under both bases, modules as given. */
function generatedPart(file: string, exportName: string, modules: { definition: string; class: string }, images: { icon?: string; options?: string[] }) {
  const schema = {
    kind: 'part' as const,
    definitionKind: 'generated' as const,
    id: 'gear',
    label: 'Gear',
    ...(images.icon ? { icon: images.icon } : {}),
    params: {
      teeth: { type: 'integer', default: 24, label: 'Teeth' },
      style: {
        type: 'select', default: 'a', label: 'Style',
        options: (images.options ?? []).map((image, i) => ({ label: `Option ${i}`, value: `o${i}`, image })),
      },
    },
    layout: ['teeth', 'style'],
    connectors: ['axis'],
    assetBase: { layout: 'definition' as const },
  };
  return {
    ...GeneratedCatalog.fieldsOf({
      getType: () => 'part-definition',
      generated: { kind: 'part', id: 'gear' },
      getSchema: () => schema,
      assetModules: () => modules,
    }, file, exportName),
    exportName, partName: 'Gear', kind: 'value' as const, rootId: '', objects: [], params: [], configurations: [], assets: [],
  };
}

function scanOf(file: string, parts: any[]): PartScanResult {
  // The module itself is its one dependency: the route's cache keeps the scan while its mtime holds.
  return { file, unit: 'mm', parts, assemblies: [], errors: [], deps: fs.existsSync(file) ? [file] : [], moduleAssets: [] };
}

async function serve(): Promise<void> {
  const backend = {
    getCurrentCode: () => currentCode,
    getCurrentFileName: () => assemblyFile,
    getLiveBuffer: () => null,
    hasLiveBuffer: () => false,
    getProjectMaterials: () => ({}),
    adoptProjectMaterial: (id: string) => {
      adopted.push(id);
      return project.at('fluidcad.json');
    },
    getParamDefinitions: () => [],
    scanPartsInFile: async (file: string) => {
      scans.push(file);
      return results.get(file) ?? scanOf(file, []);
    },
  } as any;
  const guard = new PackageEditGuard(() => project.root, () => assemblyFile, () => rows);
  const send = guard.guardSend((message: any) => {
    relayed.push(message);
    return false;
  });
  const dispatcher = new FeatureEditDispatcher(backend, send, { packages: guard });
  const app = express();
  app.use(express.json());
  app.use('/api', createPartCatalogRouter(backend, project.root, dispatcher));
  app.use('/api', createInstancePoseRouter(backend, dispatcher, project.root));
  app.use('/api', createTimelineRouter(backend, send, () => {}, {
    dispatcher,
    loadGlobalMaterials: async () => ({ 'house-pla': { name: 'House PLA', density: 1.3 } }),
  }));
  app.use('/api', createSketchEditsRouter(backend, send, project.root, dispatcher));
  app.use('/api', PackageEditGuard.errorHandler());
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function asset(url: string): Promise<{ status: number; type: string | null; csp: string | null; body: string }> {
  const res = await fetch(`${base}/${url}`);
  return { status: res.status, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), body: await res.text() };
}

beforeEach(async () => {
  project = new PackageProject('fluidcad-generated-routes-');
  assemblyFile = project.at('shop.assembly.js');
  currentCode = ASSEMBLY;
  relayed = [];
  scans = [];
  adopted = [];
  results = new Map();
  rows = GeneratedRows.NONE;
  PackageManifests.forget();
  project.config(null);
  await serve();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  project.dispose();
});

describe('GET /part-catalog/asset', () => {
  let file: string;

  beforeEach(() => {
    project.write('parts/gear.part.js', 'export {};\n');
    project.write('features/gear.feature.js', 'export {};\n');
    project.write('features/icons/gear.svg', SVG);
    project.write('features/img/a.svg', SVG);
    fs.writeFileSync(path.join(project.scratch, 'outside.svg'), SVG);
    fs.symlinkSync(path.join(project.scratch, 'outside.svg'), project.at('features/img/link.svg'));
    file = project.at('parts/gear.part.js');
    results.set(file, scanOf(file, [generatedPart(file, 'gearPart', {
      definition: file,
      class: project.at('features/gear.feature.js'),
    }, { icon: '../features/icons/gear.svg', options: ['./img/a.svg', './img/link.svg', '../../outside.svg', './img/missing.svg'] })]));
  });

  const url = (exportName: string, which: 'definition' | 'class', declared: string) =>
    GeneratedCatalog.assetUrl(file, exportName, which, declared);

  it('serves a declared icon that climbs out of its module\'s directory, inside the workspace, inert', async () => {
    const icon = await asset(url('gearPart', 'definition', '../features/icons/gear.svg'));
    expect(icon).toMatchObject({ status: 200, type: 'image/svg+xml', body: SVG });
    expect(icon.csp).toContain('sandbox');
    expect((await asset(url('gearPart', 'class', './img/a.svg'))).status).toBe(200);
    expect(scans).toEqual([file]);
  });

  it('serves only a path the schema declares, under the base it declares it for', async () => {
    expect((await asset(url('gearPart', 'definition', './img/a.svg'))).status).toBe(404);
    expect((await asset(url('gearPart', 'class', './img/other.svg'))).status).toBe(404);
    expect((await asset(url('gearPart', 'class', './img/missing.svg'))).status).toBe(404);
    expect((await asset(url('nothing', 'class', './img/a.svg'))).status).toBe(404);
  });

  it('refuses a declared path that leads outside the workspace, by .. or by a link', async () => {
    const climbed = await asset(url('gearPart', 'class', '../../outside.svg'));
    expect(climbed.status).toBe(403);
    expect(JSON.parse(climbed.body).error).toBe(`Gear: the image '../../outside.svg' leads outside its package or workspace (ws)`);
    expect((await asset(url('gearPart', 'class', './img/link.svg'))).status).toBe(403);
  });

  it('refuses a malformed query and a file outside the workspace', async () => {
    expect((await asset(`api/part-catalog/asset?file=${encodeURIComponent(file)}&export=gearPart&base=nope&path=x`)).status).toBe(400);
    const outside = path.join(project.scratch, 'elsewhere.part.js');
    expect((await asset(GeneratedCatalog.assetUrl(outside, 'gearPart', 'definition', 'x.svg'))).status).toBe(400);
  });

  it('confines an installed package\'s definition to the package\'s own directory', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0', {
      edit: (at) => {
        fs.mkdirSync(path.join(at, 'features/icons'), { recursive: true });
        fs.writeFileSync(path.join(at, 'features/icons/gear.svg'), SVG);
      },
    });
    // A file in the library, beside the package but outside it.
    fs.writeFileSync(path.join(project.library, 'beside.svg'), SVG);
    const pkgFile = `${dir}/parts/spacer.part.js`;
    results.set(pkgFile, scanOf(pkgFile, [generatedPart(pkgFile, 'gearPart', { definition: pkgFile, class: pkgFile }, {
      icon: '../features/icons/gear.svg', options: ['../../../../beside.svg'],
    })]));
    expect((await asset(GeneratedCatalog.assetUrl(pkgFile, 'gearPart', 'definition', '../features/icons/gear.svg'))).status).toBe(200);
    expect(fs.existsSync(path.resolve(path.dirname(pkgFile), '../../../../beside.svg'))).toBe(true);
    expect((await asset(GeneratedCatalog.assetUrl(pkgFile, 'gearPart', 'class', '../../../../beside.svg'))).status).toBe(403);
  });
});

describe('GET /part-catalog/generated', () => {
  async function listing(): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/part-catalog/generated`);
    return { status: res.status, body: await res.json() };
  }

  /** A generated sub-assembly's scan entry, like {@link generatedPart}'s. */
  function generatedAssembly(file: string, exportName: string, id: string) {
    const schema = {
      kind: 'assembly' as const, definitionKind: 'generated' as const, id, label: 'Crate',
      params: { width: { type: 'length', default: 40, label: 'Width' } }, layout: ['width'], connectors: [],
      assetBase: { layout: 'definition' as const },
    };
    return {
      ...GeneratedCatalog.fieldsOf({
        getType: () => 'assembly', generated: { kind: 'assembly', id }, getSchema: () => schema,
        assetModules: () => ({ definition: file, class: file }),
      }, file, exportName),
      exportName, kind: 'assembly' as const, exportKind: 'value' as const, assemblyName: 'Crate',
      instances: [], mates: [], connectors: [], objects: [], params: [], configurations: [], assets: [],
    };
  }

  it('lists the generated definitions of the files that call definePart( or defineAssembly(, scanning nothing else', async () => {
    project.write('parts/gear.part.js', `import { definePart } from 'fluidcad/sdk';\nexport const gearPart = definePart(Gear, { label: 'Gear' });\n`);
    project.write('parts/plain.part.js', `import { part } from 'fluidcad/core';\nexport const plate = part('Plate', () => {});\n`);
    project.write('assemblies/crate.assembly.js', `import { defineAssembly } from 'fluidcad/sdk';\nexport const crate = defineAssembly(Crate, { label: 'Crate' });\n`);
    const gear = project.at('parts/gear.part.js');
    const crate = project.at('assemblies/crate.assembly.js');
    results.set(gear, scanOf(gear, [generatedPart(gear, 'gearPart', { definition: gear, class: gear }, { icon: './gear.svg' })]));
    const crateScan = scanOf(crate, []);
    crateScan.assemblies = [generatedAssembly(crate, 'crate', 'crate') as any];
    results.set(crate, crateScan);

    const answer = await listing();
    expect(answer.status).toBe(200);
    expect(scans.sort()).toEqual([crate, gear].sort());
    expect(answer.body.entries.map((entry: any) => [entry.kind, entry.exportName, entry.schema.id, entry.path])).toEqual([
      ['assembly', 'crate', 'crate', 'assemblies/crate.assembly.js'],
      ['part', 'gearPart', 'gear', 'parts/gear.part.js'],
    ]);
    const part = answer.body.entries[1];
    expect(part.file).toBe(gear);
    expect(part.unit).toBe('mm');
    expect(part.assetUrls.definition['./gear.svg']).toBe(GeneratedCatalog.assetUrl(gear, 'gearPart', 'definition', './gear.svg'));
    expect(part.package).toBeUndefined();

    // A second listing answers from the scan cache.
    await listing();
    expect(scans).toHaveLength(2);
  });

  it('lists a library package\'s generated definitions, leaving out one whose id the project already has', async () => {
    project.write('parts/gear.part.js', `export const gearPart = definePart(Gear, { label: 'Gear' });\n`);
    const gear = project.at('parts/gear.part.js');
    results.set(gear, scanOf(gear, [generatedPart(gear, 'gearPart', { definition: gear, class: gear }, {})]));
    const { dir } = await project.install('@acme/kit', '0.1.0', {
      edit: (at) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(at, 'manifest.json'), 'utf8'));
        const schema = (id: string) => ({ kind: 'part', definitionKind: 'generated', id, label: id, params: {}, layout: [], connectors: [], assetBase: { layout: 'definition' } });
        for (const [exportName, id] of [['kitGear', 'gear'], ['kitRack', 'rack']]) {
          manifest.parts.push({
            exportName, module: 'parts/racks.part.js', name: id, kind: 'part', exportKind: 'value', params: [],
            definitionKind: 'generated', schema: schema(id), assetModules: { definition: null, class: null }, images: [],
          });
        }
        fs.writeFileSync(path.join(at, 'manifest.json'), JSON.stringify(manifest, null, 2));
      },
    });
    const pkgFile = `${dir}/parts/racks.part.js`;
    const kitPart = (exportName: string, id: string) => ({
      ...generatedPart(pkgFile, exportName, { definition: pkgFile, class: pkgFile }, {}),
      schema: { ...generatedPart(pkgFile, exportName, { definition: pkgFile, class: pkgFile }, {}).schema, id },
    });
    results.set(pkgFile, scanOf(pkgFile, [kitPart('kitGear', 'gear'), kitPart('kitRack', 'rack')]));

    const answer = await listing();
    expect(answer.status).toBe(200);
    // The package's plain part module (spacer) holds no generated definition: never scanned.
    expect(scans.sort()).toEqual([gear, pkgFile].sort());
    expect(answer.body.entries.map((entry: any) => [entry.exportName, entry.schema.id, entry.package?.availability ?? null])).toEqual([
      ['gearPart', 'gear', null],
      ['kitRack', 'rack', 'library'],
    ]);
    expect(answer.body.entries[1]).toMatchObject({ path: '@acme/kit/parts/racks.part.js', package: { name: '@acme/kit', version: '0.1.0' } });
  });
});

describe('the writers, values by id', () => {
  it('inserts a generated definition with its values by id: the import, the statement and its name', async () => {
    currentCode = `import { insert } from 'fluidcad/core';\n`;
    project.write('assemblies/crate.assembly.js', 'export {};\n');
    const inserted = await post('/part-catalog/insert', {
      inserts: [{ file: project.at('assemblies/crate.assembly.js'), exportName: 'crate', kind: 'value', params: { width: 80, finish: 'closed', note: 'two\nlines' } }],
    });
    expect(inserted.status).toBe(200);
    const result = await applyFeatureEdit(currentCode, relayed[0].spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { crate } from './assemblies/crate.assembly.js';`);
    expect(result.newCode).toContain(`const crate1 = insert(crate, { width: 80, finish: 'closed', note: 'two\\nlines' }).name('crate1');`);
  });

  it('pins a library package before inserting its generated part, imported by the package\'s name', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0', {
      edit: (at) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(at, 'manifest.json'), 'utf8'));
        manifest.parts.push({
          exportName: 'gearPart', module: 'parts/spacer.part.js', name: 'Gear', kind: 'part', exportKind: 'value', params: [],
          definitionKind: 'generated',
          schema: { kind: 'part', definitionKind: 'generated', id: 'gear', label: 'Gear', params: {}, layout: [], connectors: [], assetBase: { layout: 'definition' } },
          assetModules: { definition: null, class: null },
          images: [],
        });
        // A generated entry whose schema doesn't hold together is left out.
        manifest.parts.push({ exportName: 'broken', module: 'parts/spacer.part.js', name: 'Broken', kind: 'part', exportKind: 'value', params: [], definitionKind: 'generated' });
        fs.writeFileSync(path.join(at, 'manifest.json'), JSON.stringify(manifest, null, 2));
        fs.appendFileSync(path.join(at, 'index.js'), `export { gearPart, broken } from './parts/spacer.part.js';\n`);
      },
    });
    expect(PackageManifests.of(dir)?.parts.map(part => part.exportName)).toEqual(['spacer', 'gearPart']);
    const inserted = await post('/part-catalog/insert', {
      inserts: [{ file: `${dir}/parts/spacer.part.js`, exportName: 'gearPart', kind: 'value', params: { teeth: 18 } }],
    });
    expect(inserted.status).toBe(200);
    expect(readProjectConfig(project.root).dependencies?.['@acme/kit']?.version).toBe('0.1.0');
    const result = await applyFeatureEdit(currentCode, relayed[0].spec);
    expect(result.newCode).toContain(`import { gearPart } from '@acme/kit';`);
    expect(result.newCode).toContain(`insert(gearPart, { teeth: 18 }).name('gearPart1')`);
    const refused = await post('/part-catalog/insert', {
      inserts: [{ file: `${dir}/parts/spacer.part.js`, exportName: 'broken', kind: 'value' }],
    });
    expect(refused.status).toBe(422);
  });

  it('merges changed values into the insert by id, resets one, and keeps the rest', async () => {
    const merged = await post('/update-insert-params', {
      filePath: assemblyFile, sourceLine: 4, set: { depth: 40, finish: 'closed' }, unset: [],
    });
    expect(merged.status).toBe(200);
    let code = (await applyFeatureEdit(currentCode, relayed[0].spec)).newCode;
    expect(code).toContain(`const crate1 = insert(crate, { width: 60, depth: 40, finish: 'closed' }).name('crate1');`);
    currentCode = code;
    expect((await post('/update-insert-params', { filePath: assemblyFile, sourceLine: 4, set: {}, unset: ['width', 'depth'] })).status).toBe(200);
    code = (await applyFeatureEdit(currentCode, relayed[1].spec)).newCode;
    expect(code).toContain(`const crate1 = insert(crate, { finish: 'closed' }).name('crate1');`);
  });
});

describe('engine-owned rows are read-only (G8)', () => {
  const DEFINITION = '/ws/assemblies/crate.assembly.js';
  const SITE = { filePath: DEFINITION, line: 7 };
  const SITE_SENTENCE = `The parts of the generated assembly 'crate' (crate.assembly.js) are read-only: change them through the values of the insert that makes them.`;
  const ROW_SENTENCE = `'Lid' is made by the generated assembly 'crate1' and is read-only: change it through the values of the insert that makes it.`;

  beforeEach(() => {
    const insertAt = { filePath: assemblyFile, line: 4 };
    rows = GeneratedRows.of([
      { type: 'part', name: 'lid', sourceLocation: SITE, object: { name: 'lid', generatedBy: { definition: 'crate', type: 'lid' } } },
      { type: 'part', name: 'Spur gear', sourceLocation: { filePath: '/ws/parts/spur.part.js', line: 5 }, object: { generated: { definition: 'spur', values: {} } } },
      // A user's part: never a site.
      { type: 'part', name: 'Bracket', sourceLocation: { filePath: '/ws/bracket.part.js', line: 3 }, object: {} },
    ], {
      occurrences: [{ occurrenceId: 'asm-0', name: 'crate1', assemblyName: 'Crate', generated: { definition: 'crate', values: {} }, sourceLocation: insertAt }],
      instances: [
        { instanceId: 'asm-0/inst-0', name: 'Base', owner: 'asm-0', generatedBy: { definition: 'crate', type: 'base' }, sourceLocation: insertAt },
        { instanceId: 'asm-0/inst-1', name: 'Lid', owner: 'asm-0', generatedBy: { definition: 'crate', type: 'lid' }, sourceLocation: insertAt },
        { instanceId: 'inst-0', name: 'b1', owner: '', sourceLocation: { filePath: assemblyFile, line: 5 } },
      ],
      mates: [{ mateId: 'asm-0/mate-0', name: 'Lid hinge', owner: 'asm-0', sourceLocation: insertAt }],
    });
  });

  const refusedWith = (sentence: string) => ({ status: 403, body: { success: false, reason: sentence, code: 'generated-read-only' } });

  it('refuses material and appearance on a generated part\'s row, before the material is copied', async () => {
    const before = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    expect(await post('/set-part-material', { sourceLocation: SITE, material: 'house-pla' })).toEqual(refusedWith(SITE_SENTENCE));
    expect(adopted).toEqual([]);
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(before);
    expect(await post('/set-part-appearance', { sourceLocation: { filePath: '/ws/parts/spur.part.js', line: 5 }, appearance: null }))
      .toEqual(refusedWith(`'Spur gear' is made by the generated part 'spur' (spur.part.js) and is read-only: change it through the values of the insert that makes it.`));
    expect(relayed).toEqual([]);
  });

  it('refuses rename, ground, delete and pose aimed at a generated part\'s statement', async () => {
    expect(await post('/rename-part', { sourceLocation: SITE, name: 'Box' })).toEqual(refusedWith(SITE_SENTENCE));
    expect(await post('/update-insert-chain', { sourceLocation: SITE, edit: { ground: true } })).toEqual(refusedWith(SITE_SENTENCE));
    expect(await post('/remove-feature', { sourceLocation: SITE })).toEqual(refusedWith(SITE_SENTENCE));
    expect(await post('/remove-feature', { sourceLocation: SITE, dryRun: true })).toEqual(refusedWith(SITE_SENTENCE));
    expect(relayed).toEqual([]);
  });

  it('refuses every row write that names an engine-owned row, though its statement is the user\'s insert', async () => {
    const at = { filePath: assemblyFile, sourceLine: 4 };
    expect(await post('/instance-pose', { ...at, position: [1, 2, 3], rotateXYZ: null, row: 'asm-0/inst-1' })).toEqual(refusedWith(ROW_SENTENCE));
    expect(await post('/rename-instance', { ...at, name: 'Top', row: 'asm-0/inst-1' })).toEqual(refusedWith(ROW_SENTENCE));
    expect(await post('/set-instance-transparency', { ...at, transparency: 0.5, row: 'asm-0/inst-1' })).toEqual(refusedWith(ROW_SENTENCE));
    expect(await post('/update-insert-params', { ...at, set: { width: 70 }, row: 'asm-0/inst-1' })).toEqual(refusedWith(ROW_SENTENCE));
    expect(await post('/update-insert-chain', { sourceLocation: { filePath: assemblyFile, line: 4 }, edit: { ground: true }, row: 'asm-0/inst-1' }))
      .toEqual(refusedWith(ROW_SENTENCE));
    expect(await post('/remove-feature', { sourceLocation: { filePath: assemblyFile, line: 4 }, row: 'asm-0/mate-0' }))
      .toEqual(refusedWith(`'Lid hinge' is made by the generated assembly 'crate1' and is read-only: change it through the values of the insert that makes it.`));
    expect(await post('/set-part-material', { sourceLocation: { filePath: assemblyFile, line: 4 }, material: null, row: 'asm-0/inst-0' }))
      .toEqual(refusedWith(`'Base' is made by the generated assembly 'crate1' and is read-only: change it through the values of the insert that makes it.`));
    expect(relayed).toEqual([]);
  });

  it('leaves the generated occurrence\'s own insert, and every other row, editable', async () => {
    const at = { filePath: assemblyFile, sourceLine: 4 };
    expect((await post('/instance-pose', { ...at, position: [1, 2, 3], rotateXYZ: null, row: 'asm-0' })).status).toBe(200);
    expect((await post('/update-insert-params', { ...at, set: { width: 70 }, row: 'asm-0' })).status).toBe(200);
    expect((await post('/update-insert-chain', { sourceLocation: { filePath: assemblyFile, line: 4 }, edit: { ground: true } })).status).toBe(200);
    expect((await post('/remove-feature', { sourceLocation: { filePath: assemblyFile, line: 5 }, row: 'inst-0' })).status).toBe(200);
    expect((await post('/set-part-material', { sourceLocation: { filePath: '/ws/bracket.part.js', line: 3 }, material: 'house-pla' })).status).toBe(200);
    expect(relayed.map(message => message.type)).toEqual(['apply-feature-edit', 'apply-feature-edit', 'update-insert-chain', 'remove-feature', 'apply-feature-edit']);
  });

  it('refuses a host message aimed at a generated part\'s statement, whatever route sends it', async () => {
    expect(await post('/rename-feature', { sourceLocation: SITE, name: 'x' })).toEqual(refusedWith(SITE_SENTENCE));
    expect(relayed).toEqual([]);
  });
});
