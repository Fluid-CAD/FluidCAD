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

// `fluidcad pack` (research §2) over a package workspace: a copy of
// fixtures/package-workspace — two feature modules (the fastener with its
// option images), a part module and its helper, a test model and notes
// that must not ship, a README and a LICENSE. Each pack boots the engine
// in process, as the CLI does.
//
// The part snapshots' `params` are not asserted here: under vitest the
// server's own copy of lib/dist is not the instance the workspace's kernel
// runs on, so the part scan's parameter registry stays empty. The CLI test
// (server/tests/cli/pack-command.test.ts) runs the compiled server, one
// instance, and asserts them.

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PACKAGE_WORKSPACE = path.join(FIXTURES, 'package-workspace');
const CREATED_AT = '2026-10-09T12:00:00.000Z';

const SHIPPED = [
  'LICENSE',
  'README.md',
  'fastener.feature.js',
  'fastener.svg',
  'fastener/counterbore.svg',
  'fastener/countersink.svg',
  'fastener/depth.svg',
  'fastener/m3.svg',
  'fastener/m4.svg',
  'fastener/m5.svg',
  'fastener/n4.svg',
  'fastener/n6.svg',
  'fastener/plain.svg',
  'fastener/section.svg',
  'fluidcad.json',
  'helpers/sizes.js',
  'index.js',
  'parts/spacer.part.js',
  'standoff.feature.js',
  'standoff.svg',
];

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

function addExport(rel: string): void {
  editPackage((block) => {
    block.exports.push(rel);
  });
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
  return quietly(() => packPackage({ workspacePath: ws, fluidcadVersion: '0.0.46', createdAt: CREATED_AT, ...extra }));
}

/** The refusal a pack ends in. */
async function refusal(extra: { engine?: PackEngine } = {}): Promise<string> {
  try {
    await pack(extra);
  } catch (err) {
    expect(err).toBeInstanceOf(PackageBuildError);
    return (err as Error).message;
  }
  throw new Error('the pack was expected to be refused');
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
  `import { standoff } from '../standoff.feature.js';`,
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
  return fs.readFileSync(at('standoff.feature.js'), 'utf8')
    .replace("static id = 'acme.standoff';", `static id = '${id}';`)
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
    expect(fs.readFileSync(path.join(PACKAGE_WORKSPACE, 'standoff.feature.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(FIXTURES, 'custom-features/standoff.feature.js'), 'utf8'));
  });
});

describe('packing a package workspace', () => {
  it('writes the manifest: identity from the package block, the engine, the unit, the snapshots and the files', async () => {
    const { manifest } = await pack();

    const { features, parts, ...rest } = manifest;
    expect(rest).toEqual({
      manifestVersion: 1,
      name: '@acme/kit',
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
      files: SHIPPED,
      createdAt: CREATED_AT,
    });
    expect(features.map(({ id, exportName, module, usesOcct }) => ({ id, exportName, module, usesOcct }))).toEqual([
      { id: 'acme.fastener', exportName: 'fastener', module: 'fastener.feature.js', usesOcct: false },
      { id: 'acme.standoff', exportName: 'standoff', module: 'standoff.feature.js', usesOcct: false },
    ]);
    const standoff = features.find((f) => f.id === 'acme.standoff')!;
    expect(standoff.meta).toMatchObject({ id: 'acme.standoff', label: 'Standoff', icon: './standoff.svg' });
    expect(parts.map(({ params, ...part }) => part)).toEqual([
      { exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part', exportKind: 'value' },
    ]);
  });

  it('ships the exports\' closure, their images, the README and LICENSE: never the test model, init.js or the notes', async () => {
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
      '// Generated by `fluidcad pack`: every feature, part and assembly @acme/kit exports, by name.',
      'export { fastener } from "./fastener.feature.js";',
      'export { spacer } from "./parts/spacer.part.js";',
      'export { standoff } from "./standoff.feature.js";',
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

  it('produces the same tree, and the same zip, twice; the tree hash is the extracted directory\'s', async () => {
    const first = await pack();
    const second = await pack();

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
    expect(PackageLayout.archiveName(first.manifest.name, first.manifest.version)).toBe('acme-kit-0.1.0.fluidpkg');

    PackageAuthoring.bumpVersion(ws, 'patch');
    const second = await pack();

    expect(second.manifest.version).toBe('0.1.1');
    expect(PackageLayout.archiveName(second.manifest.name, second.manifest.version)).toBe('acme-kit-0.1.1.fluidpkg');
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

  it('records raw OpenCascade use per feature', async () => {
    write('raw.feature.js', [
      `import { Feature, defineFeature } from 'fluidcad/sdk';`,
      `import { getOC } from 'fluidcad/sdk/occt';`,
      ``,
      `export class Raw extends Feature.with({ face: { picker: 'face', label: 'On face' } }) {`,
      `  static id = 'acme.raw';`,
      `  buildTool() { getOC(); return []; }`,
      `}`,
      ``,
      `export const raw = defineFeature(Raw, { label: 'Raw', description: 'Reaches raw OpenCascade', group: 'create', call: ['face'] });`,
      ``,
    ].join('\n'));
    addExport('raw.feature.js');
    const { manifest } = await pack();
    expect(manifest.features.map((f) => [f.id, f.usesOcct])).toEqual([
      ['acme.fastener', false],
      ['acme.raw', true],
      ['acme.standoff', false],
    ]);
  });

  it('snapshots an exported assembly as a part of kind assembly', async () => {
    write('pair.assembly.js', [
      `import { assembly, insert } from 'fluidcad/core';`,
      `import { spacer } from './parts/spacer.part.js';`,
      ``,
      `export const pair = assembly('Spacer pair', () => {`,
      `  insert(spacer);`,
      `  insert(spacer).translate(20, 0, 0);`,
      `});`,
      ``,
    ].join('\n'));
    addExport('pair.assembly.js');
    const { manifest, files } = await pack();
    expect(manifest.parts.map(({ params, ...part }) => part)).toEqual([
      { exportName: 'spacer', module: 'parts/spacer.part.js', name: 'Spacer', kind: 'part', exportKind: 'value' },
      { exportName: 'pair', module: 'pair.assembly.js', name: 'Spacer pair', kind: 'assembly', exportKind: 'value' },
    ].sort((a, b) => (a.module < b.module ? -1 : 1)));
    expect(files['index.js'].toString('utf8')).toContain('export { pair } from "./pair.assembly.js";');
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

  it('an export that doesn\'t exist', async () => {
    addExport('gone.feature.js');
    expect(await refusal()).toBe(
      '"exports" lists gone.feature.js, which doesn\'t exist in the workspace. Fix the path, or remove it from "exports".',
    );
  });

  it('two modules exporting the same name', async () => {
    write('more.feature.js', standoffCopy('acme.standoffCopy', 'standoff'));
    addExport('more.feature.js');
    expect(await refusal()).toBe(
      "more.feature.js and standoff.feature.js both export 'standoff': the package entry re-exports by name, so rename one of them.",
    );
  });

  it('a feature id outside the package\'s scope', async () => {
    write('other.feature.js', standoffCopy('other.standoff', 'otherStandoff'));
    addExport('other.feature.js');
    expect(await refusal()).toBe(
      "other.feature.js declares the feature id 'other.standoff', but @acme/kit may only declare ids that start with 'acme.' (the package's scope).",
    );
  });

  it('two features sharing an id', async () => {
    write('twin.feature.js', standoffCopy('acme.standoff', 'twinStandoff'));
    addExport('twin.feature.js');
    expect(await refusal()).toBe(
      "standoff.feature.js and twin.feature.js both declare the feature id 'acme.standoff': give each feature its own id.",
    );
  });

  it('an import from node_modules', async () => {
    write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', main: 'index.js' }));
    write('node_modules/left-pad/index.js', 'module.exports = (s) => s;\n');
    write('helpers/sizes.js', `import pad from 'left-pad';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      "helpers/sizes.js imports node_modules/left-pad/index.js, an npm dependency: a package can't carry npm dependencies yet.",
    );
  });

  it('an import of another package', async () => {
    write('helpers/sizes.js', `import { gear } from '@acme/gears';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      'helpers/sizes.js:1: "@acme/gears" is the package @acme/gears: a package can\'t import another package yet.',
    );
  });

  it('a blocked Node built-in', async () => {
    write('helpers/sizes.js', `import fs from 'fs';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      'helpers/sizes.js:1: Module "fs" is not allowed in FluidCAD scripts. Access to Node.js "fs" module is restricted for security.',
    );
  });

  it('an import from outside the workspace', async () => {
    fs.writeFileSync(path.join(scratch, 'shared.js'), 'export const SHARED = 1;\n');
    write('helpers/sizes.js', `import { SHARED } from '../../shared.js';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      'helpers/sizes.js imports ../shared.js, which lies outside the workspace: a package ships only its own files.',
    );
  });

  it('an import of init.js', async () => {
    write('helpers/sizes.js', `import '../init.js';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toContain('helpers/sizes.js imports init.js, which never ships');
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
    addExport('parts/broken.part.js');
    expect(await refusal()).toBe(
      "parts/broken.part.js: 'broken' doesn't build with its default parameters: the broken part never builds",
    );
  });

  it('a part one of whose objects fails to build, though nothing throws', async () => {
    write('parts/wobbly.part.js', BROKEN_STANDOFF_PART);
    addExport('parts/wobbly.part.js');
    const message = await refusal();
    expect(message).toMatch(/^parts\/wobbly\.part\.js: 'wobbly' doesn't build with its default parameters: its .+ fails \(/);
    expect(message).toContain('must be narrower than the boss');
  });

  it('a module that doesn\'t evaluate', async () => {
    write('bad.feature.js', `throw new Error('no such luck');\n`);
    addExport('bad.feature.js');
    expect(await refusal()).toBe('bad.feature.js doesn\'t evaluate: no such luck');
  });

  it('an export module that exports nothing a package can share', async () => {
    write('empty.feature.js', `export const NOTHING = 1;\n`);
    addExport('empty.feature.js');
    expect(await refusal()).toBe(
      'empty.feature.js exports nothing a package can share: export its feature builders, parts or assemblies by name.',
    );
  });

  it('a missing declared image', async () => {
    fs.rmSync(at('fastener/m4.svg'));
    expect(await refusal()).toBe(
      "fastener.feature.js declares the image ./fastener/m4.svg (feature 'acme.fastener'), which doesn't exist next to the module.",
    );
  });

  it('an authored root index.js in the closure', async () => {
    write('index.js', 'export const SIZE = 1;\n');
    write('helpers/sizes.js', `import { SIZE } from '../index.js';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      'index.js would ship at the package root (helpers/sizes.js imports it), where pack writes its own generated index.js. Rename or move it.',
    );
  });

  it.each(['manifest.json', 'fluidcad.json'])('a closure file at the reserved root path %s', async (reserved) => {
    if (reserved === 'manifest.json') {
      write('manifest.json', '{}\n');
    }
    write('helpers/sizes.js', `import data from '../${reserved}';\n${fs.readFileSync(at('helpers/sizes.js'), 'utf8')}`);
    expect(await refusal()).toBe(
      `${reserved} would ship at the package root (helpers/sizes.js imports it), where pack writes its own generated ${reserved}. Rename or move it.`,
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
      getLiveBuffer: (file) => (file.endsWith('/helpers/sizes.js') ? 'export const SPACER_RADIUS = 9;\n' : null),
    };
    expect(await refusal({ engine })).toBe('helpers/sizes.js has unsaved changes: save it, then pack again.');
    expect(scans).not.toHaveBeenCalled();
  });
});
