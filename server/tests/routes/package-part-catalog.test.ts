import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'node:http';
import { createPartCatalogRouter } from '../../src/routes/part-catalog.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { applyFeatureEdit } from '../../src/apply-feature-edit/index.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { readProjectConfig } from '../../src/project-config.ts';
import { PackageProject } from '../packages/package-project.ts';

// Stage P6: the Insert dialog lists installed packages' parts under their
// package — the pinned packages, and the library's newest version of each
// one the project doesn't pin (K7) — scans their files, and inserts one with
// `import { spacer } from '@acme/kit'`. Inserting from a library package pins
// it first, and copies nothing into the project. The engine is faked: the
// scan answers from its arguments.

const ASSEMBLY = [
  `import { insert } from 'fluidcad/core';`,
  ``,
].join('\n');

let project: PackageProject;
let assemblyFile: string;
let relayed: any[];
let configAtSend: unknown[];
let scans: { file: string; unit: string }[];
let server: http.Server | null = null;
let base: string;

async function serve(): Promise<void> {
  const backend = {
    getCurrentCode: () => ASSEMBLY,
    getCurrentFileName: () => assemblyFile,
    getLiveBuffer: () => null,
    hasLiveBuffer: () => false,
    scanPartsInFile: async (file: string, unit: string) => {
      scans.push({ file, unit });
      return { file, unit, parts: [{ exportName: 'spacer', partName: 'Spacer', kind: 'value', rootId: 'r', objects: [], params: [] }], assemblies: [], errors: [], deps: [] };
    },
  } as any;
  const send = (message: any) => {
    relayed.push(message);
    configAtSend.push(readProjectConfig(project.root).dependencies ?? null);
    return false;
  };
  const app = express();
  app.use(express.json());
  app.use(createPartCatalogRouter(backend, project.root, new FeatureEditDispatcher(backend, send)));
  server = http.createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function files(): Promise<any[]> {
  const res = await fetch(`${base}/part-catalog/files`);
  expect(res.status).toBe(200);
  return (await res.json()).files;
}

beforeEach(async () => {
  project = new PackageProject('fluidcad-package-parts-');
  assemblyFile = project.at('board.assembly.js');
  project.write('bracket.part.js', `import { part } from 'fluidcad/core';\nexport const bracket = part('Bracket', () => {});\n`);
  PackageManifests.forget();
  relayed = [];
  configAtSend = [];
  scans = [];
  await serve();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
  project.dispose();
});

describe('the Insert dialog lists packages’ parts', () => {
  it('lists a pinned package’s part files after the workspace’s, under the package, in its unit', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    expect(await files()).toEqual([
      { path: 'bracket.part.js', absPath: project.at('bracket.part.js'), unit: 'mm' },
      {
        path: '@acme/kit/parts/spacer.part.js',
        absPath: `${dir}/parts/spacer.part.js`,
        unit: 'in',
        package: { name: '@acme/kit', version: '0.1.0', availability: 'dependency' },
      },
    ]);
  });

  it('lists the library’s newest version of a package the project does not pin', async () => {
    await project.install('@acme/kit', '0.1.0');
    const newer = await project.install('@acme/kit', '0.2.0');
    project.config(null);
    expect((await files()).slice(1)).toEqual([{
      path: '@acme/kit/parts/spacer.part.js',
      absPath: `${newer.dir}/parts/spacer.part.js`,
      unit: 'in',
      package: { name: '@acme/kit', version: '0.2.0', availability: 'library' },
    }]);
  });

  it('scans a file under a package root in the package’s unit, and still refuses one outside', async () => {
    const { dir } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const scanned = await post('/part-catalog/scan', { file: `${dir}/parts/spacer.part.js` });
    expect(scanned.status).toBe(200);
    expect(scans).toEqual([{ file: `${dir}/parts/spacer.part.js`, unit: 'in' }]);
    const outside = await post('/part-catalog/scan', { file: `${project.scratch}/elsewhere.part.js` });
    expect(outside.status).toBe(400);
    // A package-shaped folder without its marker is no package.
    fs.mkdirSync(`${project.library}/@acme/fake/1.0.0`, { recursive: true });
    expect((await post('/part-catalog/scan', { file: `${project.library}/@acme/fake/1.0.0/a.part.js` })).status).toBe(400);
  });
});

describe('inserting a package’s part', () => {
  it('imports it by the package’s bare name, and pins nothing for a pinned package', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config({ '@acme/kit': { version: '0.1.0', integrity } });
    const before = fs.readFileSync(project.at('fluidcad.json'), 'utf8');
    const inserted = await post('/part-catalog/insert', { inserts: [{ file: `${dir}/parts/spacer.part.js`, exportName: 'spacer', kind: 'value' }] });
    expect(inserted.status).toBe(200);
    expect(relayed[0].spec.insertPart.inserts).toEqual([{ importFrom: '@acme/kit', exportName: 'spacer', kind: 'value' }]);
    const result = await applyFeatureEdit(ASSEMBLY, relayed[0].spec);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`import { spacer } from '@acme/kit';`);
    expect(result.newCode).toContain(`insert(spacer)`);
    expect(fs.readFileSync(project.at('fluidcad.json'), 'utf8')).toBe(before);
  });

  it('pins a library package before the insert reaches the editor, and copies no files', async () => {
    const { dir, integrity } = await project.install('@acme/kit', '0.1.0');
    project.config(null);
    const inserted = await post('/part-catalog/insert', {
      inserts: [
        { file: project.at('bracket.part.js'), exportName: 'bracket', kind: 'value' },
        { file: `${dir}/parts/spacer.part.js`, exportName: 'spacer', kind: 'value', params: { Length: 1 } },
      ],
    });
    expect(inserted.status).toBe(200);
    expect(configAtSend).toEqual([{ '@acme/kit': { version: '0.1.0', integrity } }]);
    expect(relayed[0].spec.insertPart.inserts).toEqual([
      { importFrom: './bracket.part.js', exportName: 'bracket', kind: 'value' },
      { importFrom: '@acme/kit', exportName: 'spacer', kind: 'value', params: { Length: 1 } },
    ]);
    expect(fs.existsSync(project.at('packages'))).toBe(false);
  });

  it('refuses a name the package does not export and a version other than the pinned one, sending and pinning nothing', async () => {
    const pinned = await project.install('@acme/kit', '0.1.0');
    const other = await project.install('@acme/kit', '0.2.0');
    project.config(null);
    const helper = await post('/part-catalog/insert', { inserts: [{ file: `${pinned.dir}/helpers/sizes.js`, exportName: 'SPACER_LENGTH', kind: 'value' }] });
    expect(helper.status).toBe(422);
    expect(helper.body.reason).toBe("`@acme/kit` 0.1.0 doesn't export `SPACER_LENGTH` from helpers/sizes.js, so it can't be imported by the package's name.");
    expect(readProjectConfig(project.root).dependencies ?? null).toBeNull();

    project.config({ '@acme/kit': { version: '0.1.0', integrity: pinned.integrity } });
    const switched = await post('/part-catalog/insert', { inserts: [{ file: `${other.dir}/parts/spacer.part.js`, exportName: 'spacer', kind: 'value' }] });
    expect(switched.status).toBe(422);
    expect(switched.body.reason).toBe("This project uses `@acme/kit` 0.1.0, not 0.2.0; switching the version it pins isn't supported yet.");
    expect(relayed).toEqual([]);
    expect(readProjectConfig(project.root).dependencies).toEqual({ '@acme/kit': { version: '0.1.0', integrity: pinned.integrity } });
  });
});
