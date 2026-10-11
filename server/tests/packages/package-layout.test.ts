import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageLayout } from '../../src/packages/package-manifest.ts';
import { PackageArchive } from '../../src/packages/package-archive.ts';
import { PackageInstaller } from '../../src/packages/package-installer.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import JSZip from 'jszip';

/** H3b's pre-layout archive with its manifest's scoped name made bare, as `scripts/package-conformance.mjs` converts it. */
class PreLayout {
  static async withBareName(archive: Buffer): Promise<Buffer> {
    const zip = await JSZip.loadAsync(archive);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    manifest.name = 'kit';
    zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n', { date: new Date('1980-01-01T00:00:00.000Z') });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

/**
 * Stage H3b: a package keeps its feature modules in `features/`, its parts
 * in `parts/` and its assemblies in `assemblies/`, and the folders decide
 * what it exports (HD20). The layout is a pack and hub rule: an archive
 * packed before it still inspects and installs.
 */

const PRE_LAYOUT_ARCHIVE = path.resolve(__dirname, '../fixtures/pre-layout/acme-kit-0.1.0.fluidpkg');

let tmp: string;
let ws: string;

function write(rel: string, contents = ''): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

beforeEach(() => {
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-layout-'))));
  ws = path.posix.join(tmp, 'ws');
  fs.mkdirSync(ws);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PackageLayout: the suffix ↔ folder table', () => {
  it('puts each kind of module in its folder, *.fluid.js among the parts', () => {
    expect(PackageLayout.folderFor('features/gear.feature.js')).toBe('features');
    expect(PackageLayout.folderFor('parts/spur.part.js')).toBe('parts');
    expect(PackageLayout.folderFor('parts/demo.fluid.js')).toBe('parts');
    expect(PackageLayout.folderFor('assemblies/train.assembly.js')).toBe('assemblies');
    expect(PackageLayout.folderFor('features/shared/involute.js')).toBeNull();
    expect(PackageLayout.folderFor('README.md')).toBeNull();
  });

  it('names the folder a path sits in, nested or not, and null outside the three', () => {
    expect(PackageLayout.folderOf('features/gear.feature.js')).toBe('features');
    expect(PackageLayout.folderOf('parts/gears/spur/spur.part.js')).toBe('parts');
    expect(PackageLayout.folderOf('assemblies/train.assembly.js')).toBe('assemblies');
    expect(PackageLayout.folderOf('gear.feature.js')).toBeNull();
    expect(PackageLayout.folderOf('lib/x.js')).toBeNull();
    expect(PackageLayout.folderOf('features')).toBeNull();
    expect(PackageLayout.folderOf('featuresx/gear.feature.js')).toBeNull();
    expect(PackageLayout.folderOf('/features/gear.feature.js')).toBeNull();
  });

  it('words the folders for a sentence', () => {
    expect(PackageLayout.describeFolders()).toBe('features/, parts/ and assemblies/');
    expect(PackageLayout.describeFolders(['features', 'parts'])).toBe('features/ and parts/');
    expect(PackageLayout.describeFolders(['parts'])).toBe('parts/');
  });
});

describe('PackageLayout.exportsOf', () => {
  it('lists the modules of the three folders, sorted, nested folders included', () => {
    write('features/gear.feature.js');
    write('features/holes/bore.feature.js');
    write('features/gear.svg');
    write('features/shared/involute.js');
    write('parts/spur.part.js');
    write('parts/demo.fluid.js');
    write('parts/gears/helical.part.js');
    write('assemblies/train.assembly.js');
    write('assemblies/sub/pair.assembly.js');
    // Outside the folders: never an export.
    write('rack.part.js');
    write('lib/x.feature.js');
    write('init.js');

    expect(PackageLayout.exportsOf(ws)).toEqual([
      'assemblies/sub/pair.assembly.js',
      'assemblies/train.assembly.js',
      'features/gear.feature.js',
      'features/holes/bore.feature.js',
      'parts/demo.fluid.js',
      'parts/gears/helical.part.js',
      'parts/spur.part.js',
    ]);
    expect(PackageLayout.foldersIn(ws)).toEqual(['features', 'parts', 'assemblies']);
  });

  it('skips dot-entries and node_modules', () => {
    write('features/gear.feature.js');
    write('features/.draft.feature.js');
    write('features/.wip/old.feature.js');
    write('parts/node_modules/dep/x.part.js');
    expect(PackageLayout.exportsOf(ws)).toEqual(['features/gear.feature.js']);
  });

  it('is empty for a workspace without the folders', () => {
    write('gear.feature.js');
    expect(PackageLayout.exportsOf(ws)).toEqual([]);
    expect(PackageLayout.foldersIn(ws)).toEqual([]);
  });

  it('leaves a module in the wrong folder out, and misplacedIn names it with the folder it belongs in', () => {
    write('features/gear.feature.js');
    write('features/bracket.part.js');
    write('parts/train.assembly.js');
    write('parts/gear.feature.js');
    write('assemblies/demo.fluid.js');

    expect(PackageLayout.exportsOf(ws)).toEqual(['features/gear.feature.js']);
    const misplaced = PackageLayout.misplacedIn(ws);
    expect(misplaced).toEqual([
      { path: 'assemblies/demo.fluid.js', folder: 'assemblies', belongsIn: 'parts' },
      { path: 'features/bracket.part.js', folder: 'features', belongsIn: 'parts' },
      { path: 'parts/gear.feature.js', folder: 'parts', belongsIn: 'features' },
      { path: 'parts/train.assembly.js', folder: 'parts', belongsIn: 'assemblies' },
    ]);
    expect(misplaced.map((m) => PackageLayout.describeMisplaced(m))).toEqual([
      'assemblies/demo.fluid.js is a part in assemblies/, but parts belong in parts/: move it there.',
      'features/bracket.part.js is a part in features/, but parts belong in parts/: move it there.',
      'parts/gear.feature.js is a feature module in parts/, but feature modules belong in features/: move it there.',
      'parts/train.assembly.js is an assembly in parts/, but assemblies belong in assemblies/: move it there.',
    ]);
  });
});

describe('PackageLayout.modelCount and contentsOf', () => {
  const manifest = {
    // An archive packed before the flag was dropped still carries usesOcct: contentsOf leaves it out.
    features: [{ id: 'acme.gear', exportName: 'gear', module: 'features/gear.feature.js', meta: {} as any, usesOcct: true }],
    parts: [
      { exportName: 'spur', module: 'parts/spur.part.js', name: 'Spur', kind: 'part' as const, exportKind: 'value' as const, params: [{} as any, {} as any] },
      { exportName: 'train', module: 'assemblies/train.assembly.js', name: 'Train', kind: 'assembly' as const, exportKind: 'factory' as const, params: [] as any[] },
    ],
  };

  it('counts the parts and assemblies', () => {
    expect(PackageLayout.modelCount(manifest)).toBe(2);
    expect(PackageLayout.modelCount({ parts: [] })).toBe(0);
  });

  it('groups the manifest by folder', () => {
    expect(PackageLayout.contentsOf(manifest)).toEqual({
      features: [{ id: 'acme.gear', exportName: 'gear', module: 'features/gear.feature.js' }],
      parts: [{ exportName: 'spur', name: 'Spur', module: 'parts/spur.part.js', params: 2 }],
      assemblies: [{ exportName: 'train', name: 'Train', module: 'assemblies/train.assembly.js', params: 0 }],
      models: 2,
    });
  });
});

describe('an archive packed before the layout', () => {
  let savedPackages: string | undefined;

  beforeEach(() => {
    savedPackages = process.env.FLUIDCAD_PACKAGES;
    process.env.FLUIDCAD_PACKAGES = path.posix.join(tmp, 'library');
    PackageRoots.forget();
    fs.writeFileSync(path.join(ws, 'fluidcad.json'), JSON.stringify({ engine: '0.0.46' }, null, 2) + '\n');
    fs.writeFileSync(path.join(ws, 'init.js'), '');
  });

  afterEach(() => {
    if (savedPackages === undefined) {
      delete process.env.FLUIDCAD_PACKAGES;
    } else {
      process.env.FLUIDCAD_PACKAGES = savedPackages;
    }
    PackageRoots.forget();
  });

  // The archive was also packed before HD29: its manifest names `@acme/kit`,
  // so it is refused as it is ("pack it again"), and converted here the way
  // the conformance script converts it — the manifest's name made bare.
  it('is refused as packed, its manifest naming its scope (HD29)', async () => {
    await expect(PackageArchive.inspect(fs.readFileSync(PRE_LAYOUT_ARCHIVE), {
      root: PackageRoots.rootFor('library', ws),
      engineVersion: '0.0.46',
    })).rejects.toMatchObject({ code: 'bad-manifest', message: expect.stringContaining('Pack it again with this one.') });
  });

  it('still inspects and installs once its name is bare: install never enforces the layout', async () => {
    const zip = await PreLayout.withBareName(fs.readFileSync(PRE_LAYOUT_ARCHIVE));
    const inspection = await PackageArchive.inspect(zip, {
      root: PackageRoots.rootFor('library', ws),
      engineVersion: '0.0.46',
    });
    expect(inspection.manifest.name).toBe('kit');
    // Its modules sit at the root, outside the three folders.
    expect(inspection.manifest.features.map((f) => f.module)).toEqual(['fastener.feature.js', 'standoff.feature.js']);
    expect(inspection.manifest.features.every((f) => PackageLayout.folderOf(f.module) === null)).toBe(true);

    const installed = await PackageInstaller.install(inspection.token, 'library', { project: ws, replace: false, as: '@acme/kit' });
    expect(installed.status).toBe('installed');
    expect(await TreeHash.ofDirectory(installed.directory)).toBe(installed.integrity);
    expect(inspection.integrity).toBe(installed.integrity);
  });
});
