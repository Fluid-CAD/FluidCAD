import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluidcadHome } from '../../src/fluidcad-home.ts';
import { PackageRoots } from '../../src/packages/package-roots.ts';
import { normalizePath } from '../../src/normalize-path.ts';

/**
 * Where packages live (research §3): the library's resolution order, and
 * "a package root is recognised by location plus marker", never by a
 * folder name. Every case points FLUIDCAD_PACKAGES (or, for the order
 * itself, HOME and FLUIDCAD_HOME) at temp directories.
 */

const ENV_KEYS = ['FLUIDCAD_PACKAGES', 'FLUIDCAD_HOME', 'HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let project: string;
let library: string;

function write(abs: string, contents = ''): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

/** Where the preferences file lands once HOME, XDG_CONFIG_HOME and APPDATA all point at `home`. */
function preferencesFile(home: string): string {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'fluidcad', 'preferences.json');
  }
  return path.join(home, 'fluidcad', 'preferences.json');
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmp = normalizePath(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-roots-'))));
  project = path.posix.join(tmp, 'project');
  library = path.posix.join(tmp, 'library');
  fs.mkdirSync(project, { recursive: true });
  write(path.join(project, 'fluidcad.json'), '{}');
  process.env.FLUIDCAD_PACKAGES = library;
  PackageRoots.forget();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
  PackageRoots.forget();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the user library', () => {
  it('resolves FLUIDCAD_PACKAGES, then the preference, then $FLUIDCAD_HOME/packages, then the home directory', () => {
    const home = path.posix.join(tmp, 'home');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    process.env.APPDATA = home;
    process.env.FLUIDCAD_HOME = path.posix.join(tmp, 'fluidcad-home');
    write(preferencesFile(home), JSON.stringify({ packageLibraryPath: path.posix.join(tmp, 'preferred') }));

    expect(PackageRoots.libraryPath()).toBe(library);

    delete process.env.FLUIDCAD_PACKAGES;
    PackageRoots.forget();
    expect(PackageRoots.libraryPath()).toBe(path.posix.join(tmp, 'preferred'));

    write(preferencesFile(home), JSON.stringify({ packageLibraryPath: '' }));
    PackageRoots.forget();
    expect(PackageRoots.libraryPath()).toBe(path.posix.join(tmp, 'fluidcad-home', 'packages'));

    delete process.env.FLUIDCAD_HOME;
    expect(PackageRoots.libraryPath()).toBe(normalizePath(path.join(home, '.fluidcad', 'packages')));
    expect(FluidcadHome.dir()).toBe(path.join(home, '.fluidcad'));
  });

  it('ignores a hand-edited relative preference', () => {
    const home = path.posix.join(tmp, 'home');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    process.env.APPDATA = home;
    process.env.FLUIDCAD_HOME = path.posix.join(tmp, 'fluidcad-home');
    delete process.env.FLUIDCAD_PACKAGES;
    write(preferencesFile(home), JSON.stringify({ packageLibraryPath: 'relative/packages' }));

    expect(PackageRoots.libraryPath()).toBe(path.posix.join(tmp, 'fluidcad-home', 'packages'));
  });

  it('lists the project copy first, then the library', () => {
    expect(PackageRoots.rootsFor(project)).toEqual([
      { target: 'project', root: path.posix.join(project, 'packages') },
      { target: 'library', root: library },
    ]);
    expect(PackageRoots.rootsFor(null)).toEqual([{ target: 'library', root: library }]);
  });
});

describe('isPackageRoot: location plus marker', () => {
  it('accepts <root>/@scope/name/<version>/ holding manifest.json, in either root', () => {
    write(path.join(project, 'packages/@acme/kit/0.1.0/manifest.json'), '{}');
    write(path.join(library, '@acme/kit/0.2.0/manifest.json'), '{}');

    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/@acme/kit/0.1.0'), project)).toBe(true);
    expect(PackageRoots.isPackageRoot(path.join(library, '@acme/kit/0.2.0'), project)).toBe(true);
    expect(PackageRoots.isPackageRoot(path.join(library, '@acme/kit/0.2.0'), null)).toBe(true);
  });

  it('refuses the same shape without the marker, at another depth, or under no root', () => {
    write(path.join(project, 'packages/@acme/draft/0.1.0/draft.feature.js'));
    write(path.join(project, 'packages/@acme/kit/manifest.json'), '{}');
    write(path.join(project, 'packages/models/0.1.0/manifest.json'), '{}');
    write(path.join(project, 'packages/@acme/kit/latest/manifest.json'), '{}');
    // A fork copied into the workspace keeps its manifest.json and is still ordinary code.
    write(path.join(project, 'vendor/@acme/kit/0.1.0/manifest.json'), '{}');

    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/@acme/draft/0.1.0'), project)).toBe(false);
    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/@acme/kit'), project)).toBe(false);
    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/models/0.1.0'), project)).toBe(false);
    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/@acme/kit/latest'), project)).toBe(false);
    expect(PackageRoots.isPackageRoot(path.join(project, 'vendor/@acme/kit/0.1.0'), project)).toBe(false);
    // Without the project, its copy is no root at all.
    write(path.join(project, 'packages/@acme/kit/0.1.0/manifest.json'), '{}');
    expect(PackageRoots.isPackageRoot(path.join(project, 'packages/@acme/kit/0.1.0'), null)).toBe(false);
  });

  it('never takes the open workspace root for a package root', () => {
    // A workspace that itself sits where a package would.
    const nested = path.posix.join(library, '@acme', 'kit', '0.1.0');
    write(path.join(nested, 'manifest.json'), '{}');

    expect(PackageRoots.isPackageRoot(nested, nested)).toBe(false);
    expect(PackageRoots.isPackageRoot(nested, project)).toBe(true);
  });

  it('sees a package installed after a "no" without being told', () => {
    const dir = path.join(library, '@acme/kit/0.1.0');
    expect(PackageRoots.isPackageRoot(dir, project)).toBe(false);
    write(path.join(dir, 'manifest.json'), '{}');
    expect(PackageRoots.isPackageRoot(dir, project)).toBe(true);
  });

  it('finds the package a file belongs to, and treats the scratch as the installer’s', () => {
    write(path.join(project, 'packages/@acme/kit/0.1.0/manifest.json'), '{}');
    write(path.join(project, 'packages/@acme/kit/0.1.0/parts/spacer.part.js'));

    const owner = PackageRoots.containing(path.join(project, 'packages/@acme/kit/0.1.0/parts/spacer.part.js'), project);
    expect(owner).toMatchObject({ target: 'project', name: '@acme/kit', version: '0.1.0' });
    expect(PackageRoots.containing(path.join(project, 'packages/models/bracket.part.js'), project)).toBeNull();
    expect(PackageRoots.isManaged(path.join(project, 'packages/.tmp/123-abc/tree/index.js'), project)).toBe(true);
    expect(PackageRoots.isManaged(path.join(project, 'packages/models/bracket.part.js'), project)).toBe(false);
  });

  it('locates a version in the project copy before the library', () => {
    write(path.join(project, 'packages/@acme/kit/0.1.0/manifest.json'), '{}');
    write(path.join(library, '@acme/kit/0.1.0/manifest.json'), '{}');
    write(path.join(library, '@acme/kit/0.2.0/manifest.json'), '{}');

    expect(PackageRoots.locate('@acme/kit', '0.1.0', project)?.target).toBe('project');
    expect(PackageRoots.locate('@acme/kit', '0.2.0', project)?.target).toBe('library');
    expect(PackageRoots.locate('@acme/kit', '0.3.0', project)).toBeNull();
    expect(PackageRoots.installedIn({ target: 'library', root: library }).map((p) => p.version)).toEqual(['0.1.0', '0.2.0']);
  });
});

describe('checkLibraryPath', () => {
  it('accepts an existing folder and a path it can create', () => {
    expect(PackageRoots.checkLibraryPath(tmp)).toBeNull();
    expect(PackageRoots.checkLibraryPath(path.join(tmp, 'new', 'deeper', 'packages'))).toBeNull();
  });

  it('refuses a relative path and a file', () => {
    expect(PackageRoots.checkLibraryPath('packages')).toMatch(/absolute path/);
    write(path.join(tmp, 'a-file'));
    expect(PackageRoots.checkLibraryPath(path.join(tmp, 'a-file'))).toMatch(/is a file/);
    expect(PackageRoots.checkLibraryPath(path.join(tmp, 'a-file', 'packages'))).toMatch(/is a file/);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a path under a folder it can’t write, but accepts a read-only existing share', () => {
    const locked = path.join(tmp, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
    try {
      expect(PackageRoots.checkLibraryPath(path.join(locked, 'packages'))).toMatch(/isn't writable/);
      expect(PackageRoots.checkLibraryPath(locked)).toBeNull();
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});
