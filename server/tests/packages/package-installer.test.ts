import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ArchiveFixture } from './archive-fixture.ts';
import { PackageArchive, PackageArchiveError } from '../../src/packages/package-archive.ts';
import { PackageInstallError, PackageInstaller } from '../../src/packages/package-installer.ts';
import { PackagePinError, PackagePins } from '../../src/packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../../src/packages/package-roots.ts';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { TreeHash } from '../../src/packages/tree-hash.ts';
import { FeatureModules } from '../../src/feature-catalog/walk.ts';
import { listCandidateFiles } from '../../src/part-catalog/walk.ts';
import { WorkspaceFiles } from '../../src/files/workspace-files.ts';
import { listWorkspaceFiles } from '../../src/files/file-tree.ts';
import { createWorkspaceIgnore } from '../../src/files/workspace-ignore.ts';
import { normalizePath } from '../../src/normalize-path.ts';
import { readProjectConfig } from '../../src/project-config.ts';

/**
 * Stage P4: a `.fluidpkg` inspected, then installed into the user library
 * or a project copy — atomically, verified, read-only — copied between the
 * two, removed, and pinned. Every case runs with FLUIDCAD_PACKAGES pointed
 * at a temp library, so nothing reaches the user's own.
 */

const ENGINE = ArchiveFixture.ENGINE;
let savedPackages: string | undefined;
let tmp: string;
let project: string;
let library: string;

function write(abs: string, contents = ''): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function rootFor(target: PackageTarget): string {
  return PackageRoots.rootFor(target, project);
}

async function inspect(options: Parameters<typeof ArchiveFixture.zip>[0] = {}, target: PackageTarget = 'library', engineVersion = ENGINE) {
  return PackageArchive.inspect(await ArchiveFixture.zip(options), { root: rootFor(target), engineVersion });
}

async function install(options: Parameters<typeof ArchiveFixture.zip>[0] = {}, target: PackageTarget = 'library', replace = false) {
  const inspection = await inspect(options, target);
  return PackageInstaller.install(inspection.token, target, { project, replace });
}

/** The default archive with one byte of its feature module changed: same version, other contents. */
function changedFiles(): Record<string, string> {
  const files = ArchiveFixture.defaultFiles();
  files['standoff.feature.js'] = files['standoff.feature.js'].replace('null', 'nul1');
  return files;
}

async function expectRefusal(promise: Promise<unknown>, type: Function, code: string): Promise<Error> {
  const err = await promise.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(type);
  expect((err as { code: string }).code).toBe(code);
  return err as Error;
}

function scratchEntries(root: string): string[] {
  try {
    return fs.readdirSync(path.join(root, '.tmp'));
  } catch {
    return [];
  }
}

beforeEach(() => {
  savedPackages = process.env.FLUIDCAD_PACKAGES;
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-install-'))));
  project = path.posix.join(tmp, 'project');
  library = path.posix.join(tmp, 'library');
  write(path.join(project, 'fluidcad.json'), JSON.stringify({ engine: ENGINE }, null, 2) + '\n');
  write(path.join(project, 'init.js'));
  process.env.FLUIDCAD_PACKAGES = library;
  PackageRoots.forget();
});

afterEach(() => {
  if (savedPackages === undefined) {
    delete process.env.FLUIDCAD_PACKAGES;
  } else {
    process.env.FLUIDCAD_PACKAGES = savedPackages;
  }
  PackageRoots.forget();
  PackageScratchCleanup.run(tmp);
});

/** Installed files are read-only; make them writable so the temp tree can go. */
class PackageScratchCleanup {
  static run(dir: string): void {
    PackageScratchCleanup.writable(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private static writable(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        PackageScratchCleanup.writable(child);
      } else if (entry.isFile()) {
        fs.chmodSync(child, 0o644);
      }
    }
  }
}

describe('PackageArchive.inspect', () => {
  it('extracts into <library>/.tmp and answers the manifest, the tree hash and no warnings', async () => {
    const inspection = await inspect();

    expect(inspection.manifest).toMatchObject({ name: '@acme/kit', version: '0.1.0', manifestVersion: 1 });
    const files = { ...ArchiveFixture.defaultFiles(), 'manifest.json': JSON.stringify(ArchiveFixture.manifest(), null, 2) + '\n' };
    expect(inspection.integrity).toBe(TreeHash.ofFiles(Object.fromEntries(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]))));
    expect(inspection.warnings).toEqual([]);
    expect(scratchEntries(library)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);

    PackageArchive.discard(inspection.token);
    expect(fs.existsSync(path.join(library, '.tmp'))).toBe(false);
  });

  it('warns about raw OpenCascade, a newer minEngine and another SDK version', async () => {
    const inspection = await PackageArchive.inspect(await ArchiveFixture.zip({
      manifest: {
        minEngine: '0.1.0',
        sdkVersion: 2,
        features: [{ id: 'acme.twist', exportName: 'twist', module: 'standoff.feature.js', meta: {}, usesOcct: true }],
      },
    }), { root: library, engineVersion: '0.0.46' });

    expect(inspection.warnings.map((w) => w.code)).toEqual(['uses-occt', 'min-engine', 'sdk-version']);
    expect(inspection.warnings[0].message).toContain('acme.twist');
    expect(inspection.warnings[1].message).toContain('Needs FluidCAD 0.1.0 or newer; this is 0.0.46');
    PackageArchive.discard(inspection.token);
  });

  it('refuses an archive of the old model packer', async () => {
    const zip = await ArchiveFixture.zip({ manifest: null, raw: { 'manifest.json': JSON.stringify({ schemaVersion: 3, entry: 'part.fluid.js' }), 'bundle.js': '' } });
    const err = await expectRefusal(PackageArchive.inspect(zip, { root: library, engineVersion: ENGINE }), PackageArchiveError, 'model-archive');
    expect(err.message).toMatch(/^This is a model archive, not a package/);
    expect(scratchEntries(library)).toEqual([]);
  });

  it.each([
    ['../evil.js'],
    ['parts/../../evil.js'],
    ['/abs.js'],
  ])('refuses the path-traversal entry %s and writes nothing outside the scratch', async (entry) => {
    const zip = await ArchiveFixture.zip({ raw: { [entry]: 'export const pwned = 1;' } });
    const err = await expectRefusal(PackageArchive.inspect(zip, { root: library, engineVersion: ENGINE }), PackageArchiveError, 'unsafe-path');
    expect(err.message).toContain('is not a path inside the package');
    expect(fs.existsSync(path.join(tmp, 'evil.js'))).toBe(false);
    expect(fs.existsSync(path.join(library, 'evil.js'))).toBe(false);
    expect(scratchEntries(library)).toEqual([]);
  });

  it('refuses a module that imports a blocked built-in, naming the file', async () => {
    const files = { ...ArchiveFixture.defaultFiles(), 'helpers/run.js': "import { execSync } from 'child_process';\n" };
    const err = await expectRefusal(inspect({ files }), PackageArchiveError, 'blocked-import');
    expect(err.message).toMatch(/^helpers\/run\.js imports "child_process"/);
  });

  it('refuses something that is not a zip, a zip without a manifest, and a manifest that lies about its files', async () => {
    await expectRefusal(PackageArchive.inspect(Buffer.from('not a zip'), { root: library, engineVersion: ENGINE }), PackageArchiveError, 'not-a-zip');
    await expectRefusal(inspect({ manifest: null }), PackageArchiveError, 'no-manifest');
    await expectRefusal(inspect({ raw: { 'extra.js': '' } }), PackageArchiveError, 'files-mismatch');
    await expectRefusal(inspect({ manifest: { manifestVersion: 2 } }), PackageArchiveError, 'newer-manifest');
    await expectRefusal(inspect({ manifest: { name: 'kit' } }), PackageArchiveError, 'bad-manifest');
  });
});

describe('PackageInstaller.install', () => {
  it('installs into the library: renamed into place, read-only, scratch gone', async () => {
    const result = await install();

    const dir = path.posix.join(library, '@acme', 'kit', '0.1.0');
    expect(result).toMatchObject({ target: 'library', name: '@acme/kit', version: '0.1.0', directory: dir, status: 'installed' });
    expect(result.integrity).toBe(await TreeHash.ofDirectory(dir));
    expect(fs.readdirSync(dir).sort()).toEqual(['fluidcad.json', 'index.js', 'manifest.json', 'standoff.feature.js']);
    expect(fs.existsSync(path.join(library, '.tmp'))).toBe(false);
    expect(PackageRoots.isPackageRoot(dir, project)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('makes every installed file read-only', async () => {
    const result = await install();
    for (const file of ['index.js', 'manifest.json', 'standoff.feature.js']) {
      expect(fs.statSync(path.join(result.directory, file)).mode & 0o222).toBe(0);
    }
    expect(() => fs.writeFileSync(path.join(result.directory, 'index.js'), 'changed')).toThrow();
  });

  it('installs an archive packed while the manifest still had createdAt, the installed manifest kept byte for byte', async () => {
    const old = { manifest: { createdAt: '2026-10-09T12:00:00.000Z' } };
    const inspection = await inspect(old);
    expect(inspection.manifest).toMatchObject({ name: '@acme/kit', version: '0.1.0', createdAt: '2026-10-09T12:00:00.000Z' });
    expect(inspection.warnings).toEqual([]);

    const result = await PackageInstaller.install(inspection.token, 'library', { project, replace: false });
    expect(result).toMatchObject({ name: '@acme/kit', version: '0.1.0', status: 'installed', integrity: inspection.integrity });
    expect(fs.readFileSync(path.join(result.directory, 'manifest.json'), 'utf8'))
      .toBe(JSON.stringify(ArchiveFixture.manifest(old), null, 2) + '\n');
    const [listed] = PackageInstaller.list('library');
    expect(listed).toMatchObject({ name: '@acme/kit', version: '0.1.0', target: 'library' });
    expect(listed.manifest?.features[0].id).toBe('acme.standoff');
  });

  it('installs into the project copy', async () => {
    const result = await install({}, 'project');
    expect(result.directory).toBe(path.posix.join(project, 'packages', '@acme', 'kit', '0.1.0'));
    expect(fs.existsSync(path.join(project, 'packages', '.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(library, '@acme'))).toBe(false);
  });

  it('reinstalling the same tree is a no-op', async () => {
    const first = await install();
    const mtime = fs.statSync(path.join(first.directory, 'index.js')).mtimeMs;

    const second = await install();
    expect(second.status).toBe('unchanged');
    expect(second.integrity).toBe(first.integrity);
    expect(fs.statSync(path.join(first.directory, 'index.js')).mtimeMs).toBe(mtime);
    expect(scratchEntries(library)).toEqual([]);
  });

  it('refuses the same version with other contents, unless it is explicitly replaced', async () => {
    const first = await install();
    const err = await expectRefusal(install({ files: changedFiles() }), PackageInstallError, 'conflict');
    expect(err.message).toContain('@acme/kit 0.1.0 is already in your library with different contents');
    expect(await TreeHash.ofDirectory(first.directory)).toBe(first.integrity);

    const replaced = await install({ files: changedFiles() }, 'library', true);
    expect(replaced.status).toBe('replaced');
    expect(replaced.integrity).not.toBe(first.integrity);
    expect(await TreeHash.ofDirectory(first.directory)).toBe(replaced.integrity);
    expect(scratchEntries(library)).toEqual([]);
  });

  it('refuses to write over a folder at the target path that is not an installed package', async () => {
    const own = path.join(project, 'packages', '@acme', 'kit', '0.1.0');
    write(path.join(own, 'notes.txt'), 'mine');

    const err = await expectRefusal(install({}, 'project'), PackageInstallError, 'not-a-package-folder');
    expect(err.message).toContain('isn\'t an installed package');
    expect(fs.readdirSync(own)).toEqual(['notes.txt']);
  });

  it('refuses a token that is gone', async () => {
    const inspection = await inspect();
    await PackageInstaller.install(inspection.token, 'library');
    await expectRefusal(PackageInstaller.install(inspection.token, 'library'), PackageInstallError, 'unknown-token');
  });

  it('moves a tree inspected under one root into the other', async () => {
    const inspection = await inspect({}, 'library');
    const result = await PackageInstaller.install(inspection.token, 'project', { project });
    expect(result.target).toBe('project');
    expect(await TreeHash.ofDirectory(result.directory)).toBe(inspection.integrity);
    expect(scratchEntries(library)).toEqual([]);
    expect(scratchEntries(path.join(project, 'packages'))).toEqual([]);
  });
});

describe('PackageInstaller.copy, remove and list', () => {
  it('copies both ways and keeps the hash', async () => {
    const installed = await install();

    const intoProject = await PackageInstaller.copy('@acme/kit', '0.1.0', 'project', project);
    expect(intoProject).toMatchObject({ target: 'project', status: 'installed', integrity: installed.integrity });
    expect(await TreeHash.ofDirectory(intoProject.directory)).toBe(installed.integrity);

    PackageInstaller.remove('@acme/kit', '0.1.0', 'library', project);
    expect(fs.existsSync(installed.directory)).toBe(false);

    const backToLibrary = await PackageInstaller.copy('@acme/kit', '0.1.0', 'library', project);
    expect(backToLibrary.directory).toBe(installed.directory);
    expect(await TreeHash.ofDirectory(installed.directory)).toBe(installed.integrity);
    expect((await PackageInstaller.copy('@acme/kit', '0.1.0', 'library', project)).status).toBe('unchanged');
  });

  it('refuses to copy what the source root does not have', async () => {
    await expectRefusal(PackageInstaller.copy('@acme/kit', '0.1.0', 'project', project), PackageInstallError, 'not-installed');
  });

  it('removes a named version, the only version, and asks which when there are several', async () => {
    await install({ version: '0.1.0' });
    await install({ version: '0.2.0' });

    expect(() => PackageInstaller.remove('@acme/kit', null, 'library')).toThrow(/has 0\.1\.0, 0\.2\.0 in your library/);
    PackageInstaller.remove('@acme/kit', '0.1.0', 'library');
    expect(PackageInstaller.list('library').map((p) => p.version)).toEqual(['0.2.0']);
    PackageInstaller.remove('@acme/kit', null, 'library');
    expect(PackageInstaller.list('library')).toEqual([]);
    // The emptied @acme/kit and @acme folders go with it; the library stays.
    expect(fs.readdirSync(library)).toEqual([]);
    expect(() => PackageInstaller.remove('@acme/kit', null, 'library')).toThrow(/isn't in your library/);
  });

  it('takes a removed project copy\'s empty folders with it, packages/ included', async () => {
    await install({}, 'project');
    const copy = path.join(project, 'packages');
    PackageInstaller.remove('@acme/kit', '0.1.0', 'project', project);
    expect(fs.existsSync(path.join(copy, '@acme', 'kit', '0.1.0'))).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("keeps packages/ for the user's own file in it, and @scope/name for another version", async () => {
    await install({ version: '0.1.0' }, 'project');
    await install({ version: '0.2.0' }, 'project');
    write(path.join(project, 'packages', 'models', 'bracket.part.js'), 'export {};\n');

    PackageInstaller.remove('@acme/kit', '0.1.0', 'project', project);
    expect(fs.readdirSync(path.join(project, 'packages', '@acme', 'kit'))).toEqual(['0.2.0']);

    PackageInstaller.remove('@acme/kit', '0.2.0', 'project', project);
    expect(fs.existsSync(path.join(project, 'packages', '@acme'))).toBe(false);
    expect(fs.readdirSync(path.join(project, 'packages'))).toEqual(['models']);
    expect(fs.readFileSync(path.join(project, 'packages', 'models', 'bracket.part.js'), 'utf8')).toBe('export {};\n');
  });

  it('keeps the library root when its last package goes', async () => {
    await install();
    PackageInstaller.remove('@acme/kit', '0.1.0', 'library', project);
    expect(fs.existsSync(library)).toBe(true);
    expect(fs.readdirSync(library)).toEqual([]);
  });

  it('lists each package with its manifest and size', async () => {
    await install();
    const [entry] = PackageInstaller.list('library');
    expect(entry).toMatchObject({ name: '@acme/kit', version: '0.1.0', target: 'library' });
    expect(entry.manifest?.features[0].id).toBe('acme.standoff');
    expect(entry.bytes).toBeGreaterThan(0);
  });
});

describe('PackageInstaller.sweep', () => {
  it('clears scratch a killed install left behind, and leaves a live one', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const stranded = path.join(library, '.tmp', `${dead}-00000000-0000-0000-0000-000000000000`);
    write(path.join(stranded, 'tree', 'index.js'), 'half an install');
    fs.chmodSync(path.join(stranded, 'tree', 'index.js'), 0o444);
    const projectStranded = path.join(project, 'packages', '.tmp', `${dead}-11111111-1111-1111-1111-111111111111`);
    write(path.join(projectStranded, 'tree', 'index.js'));
    const pending = await inspect();

    const removed = PackageInstaller.sweep(project);

    expect(removed.sort()).toEqual([normalizePath(projectStranded), normalizePath(stranded)].sort());
    expect(fs.existsSync(stranded)).toBe(false);
    expect(fs.existsSync(projectStranded)).toBe(false);
    // This process's own inspection is still waiting for its install.
    expect(scratchEntries(library)).toEqual([expect.stringMatching(new RegExp(`^${process.pid}-`))]);
    expect((await PackageInstaller.install(pending.token, 'library')).status).toBe('installed');
  });
});

describe('pins', () => {
  it('pins an install into the project, and refuses to change the pin’s version', async () => {
    const inspection = await inspect({}, 'project');
    const outcome = await ProjectPackages.installInspected({ token: inspection.token, target: 'project', project });
    expect(outcome.pin).toBe('pinned');
    expect(readProjectConfig(project).dependencies).toEqual({ '@acme/kit': { version: '0.1.0', integrity: inspection.integrity } });
    const before = fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8');

    const newer = await inspect({ version: '0.2.0' });
    const err = await expectRefusal(
      ProjectPackages.installInspected({ token: newer.token, target: 'library', project, pin: true }),
      PackagePinError, 'version-change');
    expect(err.message).toContain('This project pins @acme/kit 0.1.0; pinning 0.2.0 instead');
    // Refused before anything was written: no 0.2.0 anywhere, the pin as it was.
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.2.0'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'fluidcad.json'), 'utf8')).toBe(before);
    PackageArchive.discard(newer.token);
  });

  it('pins only when asked for a library install', async () => {
    const inspection = await inspect();
    const outcome = await ProjectPackages.installInspected({ token: inspection.token, target: 'library', project });
    expect(outcome.pin).toBeNull();
    expect(readProjectConfig(project).dependencies).toBeNull();
  });

  it('refuses a file whose hash differs from the pin of the same version', async () => {
    const first = await inspect();
    await ProjectPackages.installInspected({ token: first.token, target: 'library', project, pin: true });
    PackageInstaller.remove('@acme/kit', '0.1.0', 'library');

    const other = await inspect({ files: changedFiles() });
    await expectRefusal(ProjectPackages.installInspected({ token: other.token, target: 'library', project, pin: true }), PackagePinError, 'integrity-mismatch');
    expect(fs.existsSync(path.join(library, '@acme', 'kit', '0.1.0'))).toBe(false);
    PackageArchive.discard(other.token);
  });

  it('lists a pin as missing when neither root has it', async () => {
    const inspection = await inspect();
    await ProjectPackages.installInspected({ token: inspection.token, target: 'library', project, pin: true });
    expect(PackagePins.availability(project).map((p) => p.availability)).toEqual(['library']);

    const { strandedPin } = ProjectPackages.remove('@acme/kit', '0.1.0', 'library', project);
    expect(strandedPin).toMatchObject({ name: '@acme/kit', version: '0.1.0', availability: 'missing' });
    expect(PackagePins.missing(project).map((p) => p.name)).toEqual(['@acme/kit']);
  });

  it('pins a library package by name: the newest version, or the one asked for, copied in on request', async () => {
    await install({ version: '0.1.0' });
    await install({ version: '0.2.0' });

    const newest = await ProjectPackages.useInstalled('@acme/kit', project);
    expect(newest).toMatchObject({ pin: 'pinned', copied: null, location: { target: 'library', version: '0.2.0' } });

    // The pin decides the version from now on, and --project copies that one.
    const copied = await ProjectPackages.useInstalled('@acme/kit', project, { copy: true });
    expect(copied.pin).toBe('unchanged');
    expect(copied.copied).toMatchObject({ target: 'project', version: '0.2.0', status: 'installed' });

    await expectRefusal(ProjectPackages.useInstalled('@acme/kit@0.1.0', project), PackagePinError, 'version-change');
    const missing = await expectRefusal(ProjectPackages.useInstalled('@acme/gears', project), PackageInstallError, 'not-installed');
    expect(missing.message).toBe("@acme/gears isn't in your library — `fluidcad install @acme/gears` downloads it from the hub, or install it from a file.");
  });
});

describe('the walks prune installed copies by marker, not by folder name', () => {
  async function withProjectCopyAndOwnFolder(): Promise<void> {
    await install({
      files: {
        ...ArchiveFixture.defaultFiles(),
        'parts/spacer.part.js': "import { part } from 'fluidcad/core';\nexport const spacer = part('Spacer', () => {});\n",
      },
    }, 'project');
    write(path.join(project, 'packages', 'models', 'bracket.part.js'), "import { part } from 'fluidcad/core';\npart('Bracket', () => {});\n");
    write(path.join(project, 'packages', 'models', 'clip.feature.js'));
  }

  it('the part and feature catalogs list a user’s own packages/ models but not the project copy', async () => {
    await withProjectCopyAndOwnFolder();

    const parts = (await listCandidateFiles(project)).map((entry) => entry.path);
    expect(parts).toEqual(['packages/models/bracket.part.js']);
    const features = (await FeatureModules.list(project)).map((abs) => path.posix.relative(project, abs));
    expect(features).toEqual(['packages/models/clip.feature.js']);
  });

  it('the editor tree and its ignore list hide the copy and keep the rest of packages/', async () => {
    await withProjectCopyAndOwnFolder();

    const listed = listWorkspaceFiles(project).files.map((f) => f.path);
    expect(listed).toContain('packages/models/bracket.part.js');
    expect(listed.filter((p) => p.startsWith('packages/@acme'))).toEqual([]);
    const ignore = createWorkspaceIgnore(project);
    expect(ignore.isIgnored('packages/@acme/kit/0.1.0', true)).toBe(true);
    expect(ignore.isIgnored('packages/@acme/kit/0.1.0/parts/spacer.part.js', false)).toBe(true);
    expect(ignore.isIgnored('packages/models/bracket.part.js', false)).toBe(false);
  });

  it('a fork copied to vendor/, manifest.json included, is ordinary editable workspace code', async () => {
    const installed = await install({}, 'project');
    const fork = path.join(project, 'vendor', 'gears');
    fs.cpSync(installed.directory, fork, { recursive: true });
    for (const file of fs.readdirSync(fork)) {
      fs.chmodSync(path.join(fork, file), 0o644);
    }

    expect(await WorkspaceFiles.collect(project)).toEqual(expect.arrayContaining([
      'vendor/gears/index.js', 'vendor/gears/manifest.json', 'vendor/gears/standoff.feature.js',
    ]));
    expect((await FeatureModules.list(project)).map((abs) => path.posix.relative(project, abs))).toEqual(['vendor/gears/standoff.feature.js']);
    expect(listWorkspaceFiles(project).files.map((f) => f.path)).toContain('vendor/gears/standoff.feature.js');
    expect(createWorkspaceIgnore(project).isIgnored('vendor/gears/standoff.feature.js', false)).toBe(false);
    expect(PackageRoots.containing(path.join(fork, 'standoff.feature.js'), project)).toBeNull();
  });
});
