import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import {
  PackageBuildError,
  packPackage,
  type PackEngine,
  type PackPackageResult,
} from '../../src/packages/package-builder.ts';
import { PackageLayout } from '../../src/packages/package-manifest.ts';
import { PackageAuthoring } from '../../src/packages/package-authoring.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';

// `fluidcad pack` (research §2) over a package workspace in the package
// layout (HD20): a copy of fixtures/package-workspace — two feature modules
// in features/ (the fastener with its option images), a part and its
// nested helper in parts/, a root test model and notes that must not ship,
// a README and a LICENSE. The folders decide the exports. Each pack boots
// the engine in process, as the CLI does.
//
// The part snapshots' `params` are not asserted here: under vitest the
// server's own copy of lib/dist is not the instance the workspace's kernel
// runs on, so the part scan's parameter registry stays empty. The CLI test
// (server/tests/cli/pack-command.test.ts) runs the compiled server, one
// instance, and asserts them.

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PACKAGE_WORKSPACE = path.join(FIXTURES, 'package-workspace');

const PRE_LAYOUT_ARCHIVE = path.join(FIXTURES, 'pre-layout', 'acme-kit-0.1.0.fluidpkg');

const SHIPPED = [
  'LICENSE',
  'README.md',
  'features/fastener.feature.js',
  'features/fastener.svg',
  'features/fastener/counterbore.svg',
  'features/fastener/countersink.svg',
  'features/fastener/depth.svg',
  'features/fastener/m3.svg',
  'features/fastener/m4.svg',
  'features/fastener/m5.svg',
  'features/fastener/n4.svg',
  'features/fastener/n6.svg',
  'features/fastener/plain.svg',
  'features/fastener/section.svg',
  'features/standoff.feature.js',
  'features/standoff.svg',
  'fluidcad.json',
  'index.js',
  'parts/helpers/sizes.js',
  'parts/spacer.part.js',
];

const HELPER = 'parts/helpers/sizes.js';

const MATERIALS = { 'acme-pom': { name: 'POM', density: 1.41, densityUnit: 'g/cm³' } };

let scratch: string;
let ws: string;

const at = (rel: string) => path.join(ws, rel);

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), content);
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(at('fluidcad.json'), 'utf8'));
}

/** Rewrite the workspace's `package` block. */
function editPackage(edit: (block: Record<string, any>) => void): void {
  const config = readConfig();
  edit(config.package);
  write('fluidcad.json', JSON.stringify(config, null, 2) + '\n');
}

/** Run `fn` with the engine's own logging silenced. */
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

function pack(extra: { engine?: PackEngine } = {}): Promise<PackPackageResult> {
  return quietly(() => packPackage({ workspacePath: ws, fluidcadVersion: '0.0.46', ...extra }));
}

/** A pack while the clock reads `iso`. */
async function packAt(iso: string): Promise<PackPackageResult> {
  vi.setSystemTime(new Date(iso));
  try {
    return await pack();
  } finally {
    vi.useRealTimers();
  }
}

/** The refusal a pack ends in. */
async function refused(extra: { engine?: PackEngine } = {}): Promise<PackageBuildError> {
  try {
    await pack(extra);
  } catch (err) {
    expect(err).toBeInstanceOf(PackageBuildError);
    return err as PackageBuildError;
  }
  throw new Error('the pack was expected to be refused');
}

/** The sentence of the refusal a pack ends in. */
async function refusal(extra: { engine?: PackEngine } = {}): Promise<string> {
  return (await refused(extra)).message;
}

/** Prepend a line to the spacer's helper module. */
function prependToHelper(line: string): void {
  write(HELPER, `${line}\n${fs.readFileSync(at(HELPER), 'utf8')}`);
}

async function unzip(zip: Buffer): Promise<Record<string, Buffer>> {
  const archive = await JSZip.loadAsync(zip);
  const out: Record<string, Buffer> = {};
  for (const name of Object.keys(archive.files)) {
    if (!archive.files[name].dir) {
      out[name] = await archive.files[name].async('nodebuffer');
    }
  }
  return out;
}

/** Every entry under `dir`, workspace-relative: a file's bytes, a link's target, a directory's mark. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      const rel = path.relative(dir, child).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        out[rel] = `link → ${fs.readlinkSync(child)}`;
      } else if (entry.isDirectory()) {
        out[rel] = 'directory';
        walk(child);
      } else {
        out[rel] = fs.readFileSync(child).toString('base64');
      }
    }
  };
  walk(dir);
  return out;
}

/** A plate part whose standoff can't build: its hole is wider than its boss. */
const BROKEN_STANDOFF_PART = [
  `import { part, sketch, line, extrude, select } from 'fluidcad/core';`,
  `import { coincident, fix } from 'fluidcad/constraints';`,
  `import { face } from 'fluidcad/filters';`,
  `import { standoff } from '../features/standoff.feature.js';`,
  ``,
  `export const wobbly = part('Wobbly plate', () => {`,
  `  sketch('xy', () => {`,
  `    const a = line([0, 0], [40, 0]); const b = line([40, 0], [40, 30]); const c = line([40, 30], [0, 30]); const d = line([0, 30], [0, 0]);`,
  `    coincident(a.end(), b.start()); coincident(b.end(), c.start()); coincident(c.end(), d.start()); coincident(d.end(), a.start());`,
  `    fix(a.start(), [0, 0]); fix(b.start(), [40, 0]); fix(c.start(), [40, 30]); fix(d.start(), [0, 30]);`,
  `  });`,
  `  extrude(5);`,
  `  standoff(select(face().planar().onPlane('xy', 5)), { hole: 10, outer: 6 });`,
  `});`,
  ``,
].join('\n');

/** A copy of the standoff fixture under another class, export name and id. */
function standoffCopy(id: string, exportName: string): string {
  return fs.readFileSync(at('features/standoff.feature.js'), 'utf8')
    .replace("static id = 'standoff';", `static id = '${id}';`)
    .replace('export class Standoff ', 'export class StandoffCopy ')
    .replace('export const standoff = defineFeature(Standoff,', `export const ${exportName} = defineFeature(StandoffCopy,`);
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fluidcad-pack-'));
  ws = path.join(scratch, 'kit');
  fs.cpSync(PACKAGE_WORKSPACE, ws, { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the package-workspace fixture', () => {
  it('carries the JavaScript standoff fixture unchanged', () => {
    expect(fs.readFileSync(path.join(PACKAGE_WORKSPACE, 'features/standoff.feature.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(FIXTURES, 'custom-features/standoff.feature.js'), 'utf8'));
  });
});

describe('packing a package workspace', () => {
  it('writes the manifest: identity from the package block, the engine, the unit, the snapshots and the files', async () => {
    const { manifest } = await pack();

    const { features, parts, ...rest } = manifest;
    expect(rest).toEqual({
      manifestVersion: 1,
      name: 'kit',
      version: '0.1.0',
      description: 'A standoff, a fastener hole and a spacer',
      license: 'MIT',
      keywords: ['standoff', 'fastener'],
      engine: '0.0.46',
      // No minEngine in the block: the workspace's engine pin.
      minEngine: '0.0.46',
      sdkVersion: 1,
      unit: 'mm',
      fileUnits: { 'parts/spacer.part.js': 'in' },
      contents: ['features', 'parts'],
      // Nothing dated: no `createdAt` (see the reproducibility test).
      files: SHIPPED,
    });
    expect(features.map(({ id, exportName, module }) => ({ id, exportName, module }))).toEqual([
      { id: 'fastener', exportName: 'fastener', module: 'features/fastener.feature.js' },
      { id: 'standoff', exportName: 'standoff', module: 'features/standoff.feature.js' },
    ]);
    const standoff = features.find((f) => f.id === 'standoff')!;
    expect(standoff.meta).toMatchObject({ id: 'standoff', label: 'Standoff', icon: './standoff.svg' });
    expect(parts.map(({ params, ...part }) => part)).toEqual([
      { exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part', exportKind: 'value' },
    ]);
  });

  it('ships the folders\' exports, their closure and images, the README and LICENSE: never the root test model, init.js or the notes', async () => {
    const { manifest, zip, files } = await pack();
    const archived = await unzip(zip);

    expect(Object.keys(archived).sort()).toEqual([...SHIPPED, 'manifest.json'].sort());
    for (const rel of ['demo.part.js', 'init.js', 'notes.txt']) {
      expect(archived[rel]).toBeUndefined();
    }
    // The sources are verbatim, and the result's files are the archive's.
    for (const rel of manifest.files.filter((f) => !PackageLayout.isReserved(f))) {
      expect(archived[rel].equals(fs.readFileSync(at(rel)))).toBe(true);
    }
    expect(Object.keys(files).sort()).toEqual(Object.keys(archived).sort());
    for (const rel of Object.keys(files)) {
      expect(files[rel].equals(archived[rel])).toBe(true);
    }
    expect(JSON.parse(archived['manifest.json'].toString('utf8'))).toEqual(manifest);
  });

  it('generates index.js: one named re-export line per module, sorted', async () => {
    const { files } = await pack();
    expect(files['index.js'].toString('utf8')).toBe([
      '// Generated by `fluidcad pack`: every feature, part and assembly kit exports, by name.',
      'export { fastener } from "./features/fastener.feature.js";',
      'export { standoff } from "./features/standoff.feature.js";',
      'export { spacer } from "./parts/spacer.part.js";',
      '',
    ].join('\n'));
  });

  it('reduces fluidcad.json to the unit and the materials', async () => {
    const { files } = await pack();
    expect(JSON.parse(files['fluidcad.json'].toString('utf8'))).toEqual({ unit: 'mm', materials: MATERIALS });
  });

  it('makes a project without a unit explicit in mm, and leaves materials out when it has none', async () => {
    const config = readConfig();
    delete config.unit;
    delete config.materials;
    write('fluidcad.json', JSON.stringify(config, null, 2));
    const { files, manifest } = await pack();
    expect(JSON.parse(files['fluidcad.json'].toString('utf8'))).toEqual({ unit: 'mm' });
    expect(manifest.unit).toBe('mm');
  });

  it('packs the same tree to the same bytes whenever it runs: the same zip and tree hash, the extracted directory\'s', async () => {
    // Nothing is pinned: the clock moves years between the two packs, so
    // anything dated by it (a manifest field, the zip entries) would differ.
    const first = await packAt('2026-10-09T12:00:00.000Z');
    const second = await packAt('2031-03-17T08:30:46.000Z');

    const hash = TreeHash.ofFiles(first.files);
    expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    expect(TreeHash.ofFiles(second.files)).toBe(hash);
    expect(second.zip.equals(first.zip)).toBe(true);

    const extracted = path.join(scratch, 'extracted');
    for (const [rel, bytes] of Object.entries(await unzip(first.zip))) {
      fs.mkdirSync(path.dirname(path.join(extracted, rel)), { recursive: true });
      fs.writeFileSync(path.join(extracted, rel), bytes);
    }
    expect(await TreeHash.ofDirectory(extracted)).toBe(hash);
  });

  it('writes nothing to the workspace: fluidcad.json stays byte-identical, and no engine link is planted', async () => {
    const config = fs.readFileSync(at('fluidcad.json'));
    const before = snapshotTree(ws);
    await pack();
    expect(fs.readFileSync(at('fluidcad.json')).equals(config)).toBe(true);
    expect(fs.existsSync(at('node_modules'))).toBe(false);
    expect(snapshotTree(ws)).toEqual(before);
  });

  it('packs again after `fluidcad version patch`, with the new version', async () => {
    const first = await pack();
    expect(PackageLayout.archiveName(first.manifest.name, first.manifest.version)).toBe('kit-0.1.0.fluidpkg');

    PackageAuthoring.bumpVersion(ws, 'patch');
    const second = await pack();

    expect(second.manifest.version).toBe('0.1.1');
    expect(PackageLayout.archiveName(second.manifest.name, second.manifest.version)).toBe('kit-0.1.1.fluidpkg');
    expect(TreeHash.ofFiles(second.files)).not.toBe(TreeHash.ofFiles(first.files));
  });

  it('takes minEngine from the block over the engine pin, and the packing engine when neither is set', async () => {
    editPackage((block) => {
      block.minEngine = '0.0.40';
    });
    expect((await pack()).manifest.minEngine).toBe('0.0.40');

    const config = readConfig();
    delete config.engine;
    delete config.package.minEngine;
    write('fluidcad.json', JSON.stringify(config, null, 2));
    expect((await pack()).manifest.minEngine).toBe('0.0.46');
  });

  it('ignores a stale manifest.json in the workspace root, as in a fork of an installed package, and writes its own', async () => {
    write('manifest.json', JSON.stringify({ manifestVersion: 1, name: '@acme/kit', version: '9.9.9', files: ['stale.js'] }));
    const { manifest, files } = await pack();
    expect(manifest.version).toBe('0.1.0');
    expect(JSON.parse(files['manifest.json'].toString('utf8')).version).toBe('0.1.0');
    expect(manifest.files).not.toContain('manifest.json');
  });

  it('writes no raw OpenCascade flag, even for a feature that reaches it', async () => {
    write('features/raw.feature.js', [
      `import { Feature, defineFeature } from 'fluidcad/sdk';`,
      `import { getOC } from 'fluidcad/sdk/occt';`,
      ``,
      `export class Raw extends Feature.with({ face: { picker: 'face', label: 'On face' } }) {`,
      `  static id = 'raw';`,
      `  buildTool() { getOC(); return []; }`,
      `}`,
      ``,
      `export const raw = defineFeature(Raw, { label: 'Raw', description: 'Reaches raw OpenCascade', group: 'create', call: ['face'] });`,
      ``,
    ].join('\n'));
    const { manifest } = await pack();
    // A feature that reaches raw OpenCascade packs like any other: the manifest says nothing about it.
    expect(manifest.features.map((f) => f.id)).toEqual(['fastener', 'raw', 'standoff']);
    expect(manifest.features.every((f) => !('usesOcct' in f))).toBe(true);
  });

  it('snapshots an assembly in assemblies/ as a part of kind assembly', async () => {
    write('assemblies/pair.assembly.js', [
      `import { assembly, insert } from 'fluidcad/core';`,
      `import { spacer } from '../parts/spacer.part.js';`,
      ``,
      `export const pair = assembly('Spacer pair', () => {`,
      `  insert(spacer);`,
      `  insert(spacer).translate(20, 0, 0);`,
      `});`,
      ``,
    ].join('\n'));
    const { manifest, files } = await pack();
    expect(manifest.parts.map(({ params, ...part }) => part)).toEqual([
      { exportName: 'pair', module: 'assemblies/pair.assembly.js', name: 'Spacer pair', kind: 'assembly', exportKind: 'value' },
      { exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part', exportKind: 'value' },
    ]);
    expect(files['index.js'].toString('utf8')).toContain('export { pair } from "./assemblies/pair.assembly.js";');
    expect(PackageLayout.modelCount(manifest)).toBe(2);
    expect(PackageLayout.contentsOf(manifest).assemblies.map((a) => a.module)).toEqual(['assemblies/pair.assembly.js']);
  });
});

describe('the package layout: the folders decide the exports (HD20)', () => {
  it('exports a *.fluid.js model in parts/ as a part', async () => {
    write('parts/washer.fluid.js', [
      `import { cylinder, part } from 'fluidcad/core';`,
      ``,
      `export const washer = part('Washer', () => {`,
      `  cylinder(4, 1);`,
      `});`,
      ``,
    ].join('\n'));
    const { manifest, files } = await pack();
    expect(manifest.parts.map((p) => [p.module, p.exportName, p.kind])).toEqual([
      ['parts/spacer.part.js', 'spacer', 'part'],
      ['parts/washer.fluid.js', 'washer', 'part'],
    ]);
    expect(files['index.js'].toString('utf8')).toContain('export { washer } from "./parts/washer.fluid.js";');
  });

  it('exports modules in nested folders, and ships a plain helper only when a module imports it', async () => {
    write('features/holes/bore.feature.js', standoffCopy('bore', 'bore'));
    fs.copyFileSync(at('features/standoff.svg'), at('features/holes/standoff.svg'));
    write('features/holes/unused.js', 'export const UNUSED = 1;\n');
    const { manifest } = await pack();
    expect(manifest.features.map((f) => f.module)).toEqual([
      'features/fastener.feature.js',
      'features/holes/bore.feature.js',
      'features/standoff.feature.js',
    ]);
    expect(manifest.files).toContain('features/holes/standoff.svg');
    expect(manifest.files).not.toContain('features/holes/unused.js');
  });

  it('packs a features-only package for a local install, with no models', async () => {
    fs.rmSync(at('parts'), { recursive: true });
    fs.rmSync(at('demo.part.js'));
    const { manifest } = await pack();
    expect(manifest.contents).toEqual(['features']);
    expect(manifest.parts).toEqual([]);
    expect(PackageLayout.modelCount(manifest)).toBe(0);
    expect(PackageLayout.contentsOf(manifest)).toMatchObject({ parts: [], assemblies: [], models: 0 });
  });

  it('keeps the manifest\'s shape: the same keys as an archive packed before the layout, less usesOcct', async () => {
    const archived = await unzip(fs.readFileSync(PRE_LAYOUT_ARCHIVE));
    const before = JSON.parse(archived['manifest.json'].toString('utf8'));
    const { manifest } = await pack();
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(before).sort());
    // Features dropped usesOcct since; nothing else changed.
    expect(Object.keys(manifest.features[0]).sort()).toEqual(Object.keys(before.features[0]).filter((key) => key !== 'usesOcct').sort());
    expect(Object.keys(manifest.parts[0]).sort()).toEqual(Object.keys(before.parts[0]).sort());
    // The same package, moved into the folders: the same names, and the ids
    // without the scope the pre-HD29 archive's carried.
    expect(manifest.features.map((f) => f.id)).toEqual(before.features.map((f: any) => f.id.replace(/^acme\./, '')));
    expect(manifest.parts.map((p) => p.exportName)).toEqual(before.parts.map((p: any) => p.exportName));
    expect(manifest.features.map((f) => f.module)).toEqual(before.features.map((f: any) => `features/${f.module}`));
  });
});

describe('what pack refuses', () => {
  it('a workspace with no package block', async () => {
    const config = readConfig();
    delete config.package;
    write('fluidcad.json', JSON.stringify(config, null, 2));
    expect(await refusal()).toBe("This workspace isn't a package — run `fluidcad package init` first.");
  });

  it('a package block without a version', async () => {
    editPackage((block) => {
      delete block.version;
    });
    const message = await refusal();
    expect(message).toContain('without a "version"');
    expect(message).toContain('Fix it, then pack again.');
  });

  it('a package block that still lists exports, naming the folders the workspace has', async () => {
    editPackage((block) => {
      block.exports = ['features/standoff.feature.js'];
    });
    const err = await refused();
    expect(err.code).toBe('refused');
    expect(err.message).toBe(
      'fluidcad.json has a "package" with an "exports" list, but a package exports its features/, parts/ and assemblies/ ' +
        'folders: remove "exports" (this workspace has features/ and parts/). Fix it, then pack again.',
    );
  });

  it('a part in assemblies/\'s place: parts/x.assembly.js is in the wrong folder', async () => {
    write('parts/pair.assembly.js', `export const NOTHING = 1;\n`);
    const err = await refused();
    expect(err.code).toBe('wrong-folder');
    expect(err.message).toBe('parts/pair.assembly.js is an assembly in parts/, but assemblies belong in assemblies/: move it there.');
  });

  it('a part in features/: features/x.part.js is in the wrong folder', async () => {
    fs.renameSync(at('parts/spacer.part.js'), at('features/spacer.part.js'));
    const err = await refused();
    expect(err.code).toBe('wrong-folder');
    expect(err.message).toBe('features/spacer.part.js is a part in features/, but parts belong in parts/: move it there.');
  });

  it('an import of a root-level module: outside the layout', async () => {
    write('lib/x.js', 'export const X = 1;\n');
    prependToHelper(`import { X } from '../../lib/x.js';`);
    const err = await refused();
    expect(err.code).toBe('outside-layout');
    expect(err.message).toBe(
      'parts/helpers/sizes.js imports lib/x.js, which is outside features/, parts/ and assemblies/: ' +
        'a package ships only what those folders hold. Move lib/x.js into one of them.',
    );
  });

  it('a workspace with nothing in the three folders', async () => {
    fs.rmSync(at('features'), { recursive: true });
    fs.rmSync(at('parts'), { recursive: true });
    const err = await refused();
    expect(err.code).toBe('no-exports');
    expect(err.message).toBe(
      'kit exports nothing: put its feature modules in features/, its parts in parts/ and its assemblies in ' +
        'assemblies/. Pack exports what those folders hold.',
    );
  });

  it('two modules exporting the same name', async () => {
    write('features/more.feature.js', standoffCopy('standoffCopy', 'standoff'));
    expect(await refusal()).toBe(
      "features/more.feature.js and features/standoff.feature.js both export 'standoff': the package entry re-exports by name, so rename one of them.",
    );
  });

  it('two features sharing an id', async () => {
    write('features/twin.feature.js', standoffCopy('standoff', 'twinStandoff'));
    expect(await refusal()).toBe(
      "features/standoff.feature.js and features/twin.feature.js both declare the feature id 'standoff': give each feature its own id.",
    );
  });

  it('a scoped name in the package block, with the sentence saying the hub adds the handle', async () => {
    const config = JSON.parse(fs.readFileSync(at('fluidcad.json'), 'utf8'));
    config.package.name = '@acme/kit';
    write('fluidcad.json', JSON.stringify(config, null, 2));
    expect(await refusal()).toContain('"name" "@acme/kit" carries a scope, but the hub adds your handle when you publish: write "kit"');
  });

  it('an import from node_modules', async () => {
    write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', main: 'index.js' }));
    write('node_modules/left-pad/index.js', 'module.exports = (s) => s;\n');
    prependToHelper(`import pad from 'left-pad';`);
    expect(await refusal()).toBe(
      "parts/helpers/sizes.js imports node_modules/left-pad/index.js, an npm dependency: a package can't carry npm dependencies yet.",
    );
  });

  it('an import of another package', async () => {
    prependToHelper(`import { gear } from '@acme/gears';`);
    expect(await refusal()).toBe(
      'parts/helpers/sizes.js:1: "@acme/gears" is the package @acme/gears: a package can\'t import another package yet.',
    );
  });

  it('a blocked Node built-in', async () => {
    prependToHelper(`import fs from 'fs';`);
    expect(await refusal()).toBe(
      'parts/helpers/sizes.js:1: Module "fs" is not allowed in FluidCAD scripts. Access to Node.js "fs" module is restricted for security.',
    );
  });

  it('an import from outside the workspace', async () => {
    fs.writeFileSync(path.join(scratch, 'shared.js'), 'export const SHARED = 1;\n');
    prependToHelper(`import { SHARED } from '../../../shared.js';`);
    expect(await refusal()).toBe(
      'parts/helpers/sizes.js imports ../shared.js, which lies outside the workspace: a package ships only its own files.',
    );
  });

  it('an import of init.js', async () => {
    prependToHelper(`import '../../init.js';`);
    expect(await refusal()).toContain('parts/helpers/sizes.js imports init.js, which never ships');
  });

  it('a part that fails to build with its default parameters', async () => {
    write('parts/broken.part.js', [
      `import { part, cylinder } from 'fluidcad/core';`,
      ``,
      `export const broken = part('Broken', () => {`,
      `  throw new Error('the broken part never builds');`,
      `});`,
      ``,
    ].join('\n'));
    expect(await refusal()).toBe(
      "parts/broken.part.js: 'broken' doesn't build with its default parameters: the broken part never builds",
    );
  });

  it('a part one of whose objects fails to build, though nothing throws', async () => {
    write('parts/wobbly.part.js', BROKEN_STANDOFF_PART);
    const message = await refusal();
    expect(message).toMatch(/^parts\/wobbly\.part\.js: 'wobbly' doesn't build with its default parameters: its .+ fails \(/);
    expect(message).toContain('must be narrower than the boss');
  });

  it('a module that doesn\'t evaluate', async () => {
    write('features/bad.feature.js', `throw new Error('no such luck');\n`);
    expect(await refusal()).toBe('features/bad.feature.js doesn\'t evaluate: no such luck');
  });

  it('an export module that exports nothing a package can share', async () => {
    write('features/empty.feature.js', `export const NOTHING = 1;\n`);
    expect(await refusal()).toBe(
      'features/empty.feature.js exports nothing a package can share: export its feature builders, parts or assemblies by name.',
    );
  });

  it('a missing declared image', async () => {
    fs.rmSync(at('features/fastener/m4.svg'));
    expect(await refusal()).toBe(
      "features/fastener.feature.js declares the image ./fastener/m4.svg (feature 'fastener'), which doesn't exist next to the module.",
    );
  });

  it('an authored root index.js in the closure', async () => {
    write('index.js', 'export const SIZE = 1;\n');
    prependToHelper(`import { SIZE } from '../../index.js';`);
    expect(await refusal()).toBe(
      'index.js would ship at the package root (parts/helpers/sizes.js imports it), where pack writes its own generated index.js. Rename or move it.',
    );
  });

  it.each(['manifest.json', 'fluidcad.json'])('a closure file at the reserved root path %s', async (reserved) => {
    if (reserved === 'manifest.json') {
      write('manifest.json', '{}\n');
    }
    prependToHelper(`import data from '../../${reserved}';`);
    expect(await refusal()).toBe(
      `${reserved} would ship at the package root (parts/helpers/sizes.js imports it), where pack writes its own generated ${reserved}. Rename or move it.`,
    );
  });

  it('a workspace without init.js: no engine to check the exports with', async () => {
    fs.rmSync(at('init.js'));
    expect(await refusal()).toContain('This workspace has no init.js');
  });

  it('a file whose editor buffer differs from the disk, when packing through a running engine', async () => {
    const scans = vi.fn();
    const engine: PackEngine = {
      describeMissingEngine: () => null,
      scanFeaturesInFile: scans,
      scanPartsInFile: scans,
      getLiveBuffer: (file) => (file.endsWith('/parts/helpers/sizes.js') ? 'export const SPACER_RADIUS = 9;\n' : null),
    };
    expect(await refusal({ engine })).toBe('parts/helpers/sizes.js has unsaved changes: save it, then pack again.');
    expect(scans).not.toHaveBeenCalled();
  });
});
