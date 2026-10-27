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
      docs: [],
    });
  });

  it('lists the doc pages from files: docs/**/*.md, nested too, never an image or a page elsewhere', () => {
    const files = ['README.md', 'docs/guide/holes.md', 'docs/images/standoff.svg', 'docs/standoff.MD', 'features/notes.md', 'index.js'];
    expect(PackageLayout.contentsOf({ ...manifest, files }).docs).toEqual(['docs/guide/holes.md', 'docs/standoff.MD']);
    expect(PackageLayout.docPagesOf({ files })).toEqual(['docs/guide/holes.md', 'docs/standoff.MD']);
    // A manifest from before docs/ shipped has none.
    expect(PackageLayout.docPagesOf({ files: ['README.md', 'index.js'] })).toEqual([]);
    expect(PackageLayout.docPagesOf({})).toEqual([]);
  });
});

describe('PackageLayout: docs/ (package-docs DOC6)', () => {
  it('lists the files under docs/, nested and sorted, skipping dot-entries; none without the folder', () => {
    expect(PackageLayout.docsIn(ws)).toEqual([]);
    write('docs/standoff.md', '# Standoff\n');
    write('docs/images/standoff.svg', '<svg/>');
    write('docs/a/b/deep.md', '# Deep\n');
    write('docs/.DS_Store', '');
    write('docs/.drafts/next.md', '');
    write('docs/node_modules/x.md', '');
    expect(PackageLayout.docsIn(ws)).toEqual(['docs/a/b/deep.md', 'docs/images/standoff.svg', 'docs/standoff.md']);
  });

  it('keeps the three module folders as they were: docs/ exports nothing and is not one of them', () => {
    write('docs/standoff.md', '# Standoff\n');
    expect(PackageLayout.FOLDERS).toEqual(['features', 'parts', 'assemblies']);
    expect(PackageLayout.folderOf('docs/standoff.md')).toBeNull();
    expect(PackageLayout.foldersIn(ws)).toEqual([]);
  });

  it('tells pages, images and scripts apart, by the hub\'s own tests', () => {
    expect(PackageLayout.isDocPage('docs/standoff.md')).toBe(true);
    expect(PackageLayout.isDocPage('README.md')).toBe(false);
    for (const image of ['docs/a.svg', 'docs/a.png', 'docs/a.jpg', 'docs/a.jpeg', 'docs/a.webp', 'docs/A.PNG']) {
      expect(PackageLayout.isDocImage(image), image).toBe(true);
    }
    expect(PackageLayout.isDocImage('docs/a.gif')).toBe(false);
    expect(PackageLayout.isScript('docs/run.js')).toBe(true);
    expect(PackageLayout.isScript('docs/run.mjs')).toBe(true);
    expect(PackageLayout.isScript('docs/run.cjs')).toBe(true);
    expect(PackageLayout.isScript('docs/run.ts')).toBe(false);
  });

  it('words the refusals, naming the file and the caps', () => {
    expect(PackageLayout.describeDocsFile('docs/cad.zip')).toBe(
      "docs/cad.zip can't ship: docs/ holds markdown pages (.md) and the images they show (.svg, .png, .jpg, .jpeg, .webp) only. Move it out of docs/ or remove it.",
    );
    expect(PackageLayout.describeOutsideLayout('docs/run.js')).toBe(
      'docs/run.js is outside features/, parts/ and assemblies/: a package ships only what those folders hold. Move docs/run.js into one of them.',
    );
    expect(PackageLayout.describeDocsFileTooLarge('docs/big.md', 300 * 1024)).toBe(
      'docs/big.md is 300 KB; a page in docs/ can be at most 256 KB. Split it into smaller pages.',
    );
    expect(PackageLayout.describeDocsFileTooLarge('docs/photo.png', 2.5 * 1024 * 1024)).toBe(
      'docs/photo.png is 2.5 MB; an image in docs/ can be at most 2 MB. Make it smaller.',
    );
    expect(PackageLayout.describeDocsFolderTooLarge(201, 1000)).toBe('docs/ holds 201 files; it can hold at most 200.');
    expect(PackageLayout.describeDocsFolderTooLarge(30, 4.25 * 1024 * 1024)).toBe('docs/ holds 4.3 MB; it can hold at most 4 MB.');
    expect([PackageLayout.DOCS_PAGE_BYTES, PackageLayout.DOCS_IMAGE_BYTES, PackageLayout.DOCS_BYTES, PackageLayout.DOCS_FILES])
      .toEqual([262_144, 2_097_152, 4_194_304, 200]);
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

  it('still inspects and installs: install never enforces the layout', async () => {
    const zip = fs.readFileSync(PRE_LAYOUT_ARCHIVE);
    const inspection = await PackageArchive.inspect(zip, {
      root: PackageRoots.rootFor('library', ws),
      engineVersion: '0.0.46',
    });
    expect(inspection.manifest.name).toBe('@acme/kit');
    // Its modules sit at the root, outside the three folders.
    expect(inspection.manifest.features.map((f) => f.module)).toEqual(['fastener.feature.js', 'standoff.feature.js']);
    expect(inspection.manifest.features.every((f) => PackageLayout.folderOf(f.module) === null)).toBe(true);

    const installed = await PackageInstaller.install(inspection.token, 'library', { project: ws, replace: false });
    expect(installed.status).toBe('installed');
    expect(await TreeHash.ofDirectory(installed.directory)).toBe(installed.integrity);
    expect(inspection.integrity).toBe(installed.integrity);
  });
});
