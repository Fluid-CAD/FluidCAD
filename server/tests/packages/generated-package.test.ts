import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import http from 'node:http';
import { PackageBuildError, packPackage, type PackPackageResult } from '../../src/packages/package-builder.ts';
import { PackageArchive, PackageArchiveError } from '../../src/packages/package-archive.ts';
import { PackageManifests } from '../../src/packages/package-manifests.ts';
import { InProcessEngine } from '../../src/packages/in-process-engine.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { FluidCadServer } from '../../src/fluidcad-server/index.ts';
import { LocalSceneHost } from '../../src/host/local-scene-host.ts';
import { createPartCatalogRouter } from '../../src/routes/part-catalog.ts';
import { FeatureEditDispatcher } from '../../src/edit-dispatch.ts';
import { ArchiveFixture } from './archive-fixture.ts';
import { PackageProject } from './package-project.ts';

// A package of generated definitions (generators S4): fixtures/generated-
// workspace packed — a definePart in parts/, a defineAssembly beside an
// exported generator class in assemblies/ — carries each in its manifest
// with its schema, the modules its images resolve against and the images
// themselves, shipped. Its minEngine is no older than the first engine to
// run generated definitions. The installer refuses a manifest whose
// generated entry doesn't hold together. Installed in a library, the
// package's generated definitions are listed and their images served,
// confined to the package.

const FIXTURE = path.resolve(__dirname, '../fixtures/generated-workspace');

let scratch: string;
let ws: string;
let engine: InProcessEngine;
let packed: PackPackageResult;

const at = (rel: string) => path.join(ws, rel);

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}

function pack(fluidcadVersion = '0.0.48'): Promise<PackPackageResult> {
  return quietly(() => packPackage({ workspacePath: ws, fluidcadVersion, engine: engine.server }));
}

async function refusal(fluidcadVersion = '0.0.48'): Promise<string> {
  try {
    await pack(fluidcadVersion);
  } catch (err) {
    expect(err).toBeInstanceOf(PackageBuildError);
    return (err as Error).message;
  }
  throw new Error('the pack was expected to be refused');
}

/** Edit `rel` for the length of `fn`, then put it back. */
async function editing<T>(rel: string, edit: (source: string) => string, fn: () => Promise<T>): Promise<T> {
  const before = fs.readFileSync(at(rel), 'utf8');
  fs.writeFileSync(at(rel), edit(before));
  try {
    return await fn();
  } finally {
    fs.writeFileSync(at(rel), before);
  }
}

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-generated-package-'));
  ws = path.join(scratch, 'ws');
  fs.cpSync(FIXTURE, ws, { recursive: true });
  engine = await quietly(() => InProcessEngine.boot(ws, { linkEngine: false }));
  packed = await pack();
});

afterAll(async () => {
  await engine?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('packing generated definitions', () => {
  it('lists each in the manifest by its folder, with its schema, its image modules and its images', () => {
    const { manifest } = packed;
    expect(manifest.contents).toEqual(['features', 'parts']);
    expect(manifest.features.map(f => f.exportName)).toEqual(['spur']);
    expect(manifest.parts.map(p => [p.exportName, p.module, p.kind, p.exportKind, p.definitionKind])).toEqual([
      ['crate', 'assemblies/crate.assembly.js', 'assembly', 'value', 'generated'],
      ['spurPart', 'parts/spur.part.js', 'part', 'value', 'generated'],
    ]);
    const [crate, spur] = manifest.parts;
    expect(crate).toMatchObject({
      name: 'Crate',
      params: [],
      assetModules: { definition: 'assemblies/crate.assembly.js', class: 'features/lib/crate.js' },
      images: ['features/icons/crate.svg', 'features/lib/img/closed.svg', 'features/lib/img/open.svg'],
    });
    expect(crate.schema).toMatchObject({ kind: 'assembly', id: 'crate', label: 'Crate', icon: '../features/icons/crate.svg' });
    expect(spur).toMatchObject({
      name: 'Spur gear',
      assetModules: { definition: 'parts/spur.part.js', class: 'features/spur.feature.js' },
      images: ['features/icons/spur.svg', 'features/img/helical.svg', 'features/img/spur.svg'],
    });
    expect(spur.schema).toMatchObject({ kind: 'part', id: 'spur', connectors: ['axis'], assetBase: { layout: 'class' } });
  });

  it('ships every image the schemas declare, the generator helper, and re-exports the definitions but never the class', () => {
    const { manifest, files } = packed;
    for (const image of ['features/icons/crate.svg', 'features/icons/spur.svg', 'features/lib/img/open.svg', 'features/lib/img/closed.svg', 'features/img/spur.svg']) {
      expect(manifest.files).toContain(image);
      expect(files[image].equals(fs.readFileSync(at(image)))).toBe(true);
    }
    expect(manifest.files).toContain('features/lib/crate.js');
    expect(files['index.js'].toString('utf8')).toBe([
      '// Generated by `fluidcad pack`: every feature, part and assembly @acme/generated exports, by name.',
      `export { crate } from "./assemblies/crate.assembly.js";`,
      `export { spur } from "./features/spur.feature.js";`,
      `export { spurPart } from "./parts/spur.part.js";`,
      '',
    ].join('\n'));
    expect(packed.warnings).toEqual([]);
  });

  it('declares a minEngine no older than the first engine that runs generated definitions', async () => {
    expect(packed.manifest.minEngine).toBe('0.0.48');
    const config = fs.readFileSync(at('fluidcad.json'), 'utf8');
    const withMinEngine = (minEngine: string) => {
      const parsed = JSON.parse(config);
      parsed.package.minEngine = minEngine;
      return JSON.stringify(parsed, null, 2);
    };
    await editing('fluidcad.json', () => withMinEngine('0.0.47'), async () => {
      // A pre-release engine that ran them is the floor…
      expect(await refusal('0.0.48')).toBe(
        `@acme/generated can't declare minEngine 0.0.47: assemblies/crate.assembly.js exports 'crate', a generated assembly (defineAssembly), `
          + `which FluidCAD 0.0.48 is the first to run. Set "minEngine" in the package block to 0.0.48 or later, then try again.`,
      );
    });
    await editing('fluidcad.json', () => withMinEngine('0.0.48'), async () => {
      // …and the release that shipped them, once the packing engine is newer.
      expect(await refusal('0.0.50')).toContain('which FluidCAD 0.0.49 is the first to run');
      expect((await pack('0.0.48')).manifest.minEngine).toBe('0.0.48');
    });
  });

  it('ships the dialog aside a generated assembly declares, read against its own module, and refuses one that climbs out', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><title>crate size</title></svg>\n';
    fs.writeFileSync(at('features/img/crate-size.svg'), svg);
    const withAside = (image: string) => (source: string) => source.replace(
      `icon: '../features/icons/crate.svg',`,
      `icon: '../features/icons/crate.svg',\n  width: 'wide',\n  aside: [{ image: '${image}', alt: 'Width, depth and height' }],`,
    );
    try {
      await editing('assemblies/crate.assembly.js', withAside('../features/img/crate-size.svg'), async () => {
        const result = await pack();
        const crate = result.manifest.parts.find(part => part.exportName === 'crate')!;
        expect(crate.schema).toMatchObject({
          width: 'wide',
          aside: [{ image: '../features/img/crate-size.svg', alt: 'Width, depth and height' }],
          assetBase: { layout: 'definition', aside: 'definition' },
        });
        expect(crate.images).toEqual(['features/icons/crate.svg', 'features/img/crate-size.svg', 'features/lib/img/closed.svg', 'features/lib/img/open.svg']);
        expect(result.manifest.files).toContain('features/img/crate-size.svg');
        expect(result.files['features/img/crate-size.svg'].toString('utf8')).toBe(svg);
      });
      fs.writeFileSync(path.join(scratch, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
      await editing('assemblies/crate.assembly.js', withAside('../../outside.svg'), async () => {
        expect(await refusal()).toBe(`assemblies/crate.assembly.js: 'crate' declares the image ../../outside.svg, which leads outside the workspace: a package ships only its own files.`);
      });
    } finally {
      fs.rmSync(at('features/img/crate-size.svg'), { force: true });
    }
  });

  it('refuses an image a schema declares that is missing, or that climbs out of the workspace', async () => {
    await editing('parts/spur.part.js', source => source.replace('../features/icons/spur.svg', '../features/icons/none.svg'), async () => {
      expect(await refusal()).toBe(`parts/spur.part.js: 'spurPart' declares the image ../features/icons/none.svg, which doesn't exist next to parts/spur.part.js.`);
    });
    fs.writeFileSync(path.join(scratch, 'outside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    await editing('assemblies/crate.assembly.js', source => source.replace('../features/icons/crate.svg', '../../outside.svg'), async () => {
      expect(await refusal()).toBe(`assemblies/crate.assembly.js: 'crate' declares the image ../../outside.svg, which leads outside the workspace: a package ships only its own files.`);
    });
  });
});

describe('installing generated definitions', () => {
  it('accepts the packed archive, and refuses one whose generated entry doesn\'t hold together', async () => {
    const root = path.join(scratch, 'inspect');
    fs.mkdirSync(root, { recursive: true });
    const inspection = await PackageArchive.inspect(packed.zip, { root, engineVersion: '0.0.48' });
    expect(inspection.manifest.parts.map(p => p.definitionKind)).toEqual(['generated', 'generated']);

    const broken = async (part: Record<string, unknown>) => {
      const files = { ...ArchiveFixture.defaultFiles(), 'parts/gear.part.js': 'export const gearPart = null;\n' };
      const zip = await ArchiveFixture.zip({ files, manifest: { parts: [{ exportName: 'gearPart', module: 'parts/gear.part.js', name: 'Gear', kind: 'part', exportKind: 'value', params: [], ...part }] } });
      try {
        await PackageArchive.inspect(zip, { root, engineVersion: ArchiveFixture.ENGINE });
      } catch (err) {
        expect(err).toBeInstanceOf(PackageArchiveError);
        return (err as PackageArchiveError).message;
      }
      throw new Error('expected a refusal');
    };
    const schema = { kind: 'part', definitionKind: 'generated', id: 'gear', label: 'Gear', params: {}, layout: [], connectors: [], assetBase: { layout: 'definition' } };
    expect(await broken({ definitionKind: 'generated' }))
      .toBe(`@acme/kit's manifest.json is malformed: 'gearPart' is a generated part without a well-formed schema.`);
    expect(await broken({ definitionKind: 'generated', schema: { ...schema, kind: 'assembly' } }))
      .toBe(`@acme/kit's manifest.json is malformed: 'gearPart' is a generated part without a well-formed schema.`);
    expect(await broken({ definitionKind: 'generated', schema, images: ['icons/gear.svg'] }))
      .toBe(`@acme/kit's manifest.json is malformed: 'gearPart' declares the image icons/gear.svg, which the package doesn't ship.`);
    expect(await broken({ definitionKind: 'made-up' }))
      .toBe(`@acme/kit's manifest.json is malformed: 'gearPart''s definitionKind "made-up" isn't one FluidCAD knows.`);
  });

  it('lists an installed package\'s generated definitions and serves their images from inside the package', async () => {
    const project = new PackageProject('fluidcad-generated-installed-');
    let host: LocalSceneHost | null = null;
    let server: http.Server | null = null;
    try {
      const dir = project.packageDir('@acme/generated', '0.1.0');
      for (const [rel, bytes] of Object.entries(packed.files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), bytes);
      }
      const integrity = await TreeHash.ofDirectory(dir);
      PackageProject.chmodFiles(dir, 0o444);
      project.config({ '@acme/generated': { version: '0.1.0', integrity } });
      PackageManifests.forget();
      expect(PackageManifests.of(dir)?.parts.map(part => part.exportName)).toEqual(['crate', 'spurPart']);

      host = new LocalSceneHost();
      const fluid = new FluidCadServer(host);
      await quietly(() => fluid.init(project.root));
      const app = express();
      app.use(express.json());
      app.use('/api', createPartCatalogRouter(fluid, project.root, new FeatureEditDispatcher(fluid, () => false)));
      server = http.createServer(app);
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
      const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;

      const files = (await (await fetch(`${base}/api/part-catalog/files`)).json()).files;
      expect(files.map((file: any) => file.path)).toEqual(['@acme/generated/assemblies/crate.assembly.js', '@acme/generated/parts/spur.part.js']);

      const scan = await (await fetch(`${base}/api/part-catalog/scan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: `${dir}/assemblies/crate.assembly.js` }),
      })).json();
      expect(scan.errors).toEqual([]);
      const crate = scan.assemblies[0];
      expect(crate).toMatchObject({
        exportName: 'crate',
        definitionKind: 'generated',
        assetModules: { definition: `${dir}/assemblies/crate.assembly.js`, class: `${dir}/features/lib/crate.js` },
      });
      const icon = await fetch(`${base}/${crate.assetUrls.definition['../features/icons/crate.svg']}`);
      expect(icon.status).toBe(200);
      expect(Buffer.from(await icon.arrayBuffer()).equals(packed.files['features/icons/crate.svg'])).toBe(true);
      expect((await fetch(`${base}/${crate.assetUrls.class['./img/open.svg']}`)).status).toBe(200);
    } finally {
      if (server) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
      }
      await host?.server?.close();
      project.dispose();
    }
  });
});
