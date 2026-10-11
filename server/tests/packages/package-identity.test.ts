import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PackageName } from '../../src/packages/package-name.ts';
import { PackageIdentity } from '../../src/packages/package-identity.ts';
import { PackageInstallError } from '../../src/packages/package-installer.ts';
import { PackageLayout } from '../../src/packages/package-manifest.ts';
import { PackagePins } from '../../src/packages/package-pins.ts';
import { ProjectPackages } from '../../src/packages/project-packages.ts';
import { writeDependency } from '../../src/project-config.ts';

/**
 * HD29: the author's files hold a bare name (`feature-tests`); the public
 * name `@<handle>/<name>` lives on the consumer side, and a package
 * installed from a file takes the project's one pin of its name, `--as`,
 * or the reserved local scope.
 */

const INTEGRITY = 'sha256-' + 'A'.repeat(42) + 'E=';

describe('PackageName', () => {
  it('reads an author\'s bare name: lowercase letters, digits and single dashes, starting with a letter, 1–64 characters', () => {
    for (const name of ['kit', 'feature-tests', 'a', 'gears2', 'm3-fasteners', 'g'.repeat(64)]) {
      expect(PackageName.isBare(name), name).toBe(true);
    }
    for (const name of ['', '3d-kit', '-kit', 'kit-', 'feature--tests', 'Kit', 'spur_gears', 'g'.repeat(65), '@acme/kit', 'a.b', 7, null]) {
      expect(PackageName.isBare(name), String(name)).toBe(false);
    }
  });

  it('reads a public name: a handle (2–39 characters, letter first) and a bare name', () => {
    for (const name of ['@acme/kit', '@bea-tools/feature-tests', '@local/feature-tests', `@${'a'.repeat(39)}/kit`, `@acme/${'g'.repeat(64)}`]) {
      expect(PackageName.isValid(name), name).toBe(true);
    }
    for (const name of [
      'kit', '@a/kit', `@${'a'.repeat(40)}/kit`, '@3d/kit', '@acme/3d-kit', '@acme--tools/kit', '@acme/kit--x',
      '@acme/-kit', '@Acme/kit', '@acme/', '@acme/kit/x', `@acme/${'g'.repeat(65)}`,
    ]) {
      expect(PackageName.isValid(name), name).toBe(false);
    }
  });

  it('splits and joins the two halves', () => {
    expect(PackageName.bareOf('@acme/feature-tests')).toBe('feature-tests');
    expect(PackageName.scope('@acme/feature-tests')).toBe('acme');
    expect(PackageName.bareOf('feature-tests')).toBeNull();
    expect(PackageName.publicName('acme', 'feature-tests')).toBe('@acme/feature-tests');
    expect(() => PackageName.publicName('acme', '3d')).toThrow('is not a package name');
  });

  it('names an archive by the bare name, or the public one for a hub download', () => {
    expect(PackageLayout.archiveName('feature-tests', '0.1.0')).toBe('feature-tests-0.1.0.fluidpkg');
    expect(PackageLayout.archiveName('@acme/feature-tests', '0.1.0')).toBe('acme-feature-tests-0.1.0.fluidpkg');
    expect(() => PackageLayout.archiveName('3d', '0.1.0')).toThrow('is not a package name');
  });
});

describe('PackageIdentity', () => {
  let project: string;

  beforeEach(() => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-identity-')));
    fs.writeFileSync(path.join(project, 'fluidcad.json'), '{}\n');
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  function refusal(run: () => unknown): PackageInstallError {
    try {
      run();
    } catch (err) {
      expect(err).toBeInstanceOf(PackageInstallError);
      return err as PackageInstallError;
    }
    throw new Error('expected a refusal');
  }

  it('installs a file under @local when nothing names it, in a project or outside one', () => {
    expect(PackageIdentity.forInstall('feature-tests', { project })).toBe('@local/feature-tests');
    expect(PackageIdentity.forInstall('feature-tests')).toBe('@local/feature-tests');
    expect(PackageIdentity.isLocal('@local/feature-tests')).toBe(true);
    expect(PackageIdentity.isLocal('@acme/feature-tests')).toBe(false);
  });

  it('takes the project\'s one pin of that bare name', () => {
    writeDependency(project, '@acme/feature-tests', { version: '0.1.0', integrity: INTEGRITY });
    writeDependency(project, '@acme/gears', { version: '1.0.0', integrity: INTEGRITY });
    expect(PackageIdentity.forInstall('feature-tests', { project })).toBe('@acme/feature-tests');
    expect(PackageIdentity.forInstall('bolts', { project })).toBe('@local/bolts');
  });

  it('refuses to guess between several pins of that bare name, naming them and --as', () => {
    writeDependency(project, '@bea-tools/feature-tests', { version: '0.1.0', integrity: INTEGRITY });
    writeDependency(project, '@acme/feature-tests', { version: '0.1.0', integrity: INTEGRITY });
    const err = refusal(() => PackageIdentity.forInstall('feature-tests', { project }));
    expect(err.code).toBe('ambiguous-name');
    expect(err.message).toBe(
      'This project pins @acme/feature-tests and @bea-tools/feature-tests, and this file could be any of them: '
        + 'name the one it is with --as, such as --as @acme/feature-tests.',
    );
    expect(PackageIdentity.forInstall('feature-tests', { project, as: '@bea-tools/feature-tests' })).toBe('@bea-tools/feature-tests');
  });

  it('takes a given name over the pins, when its bare part is the file\'s', () => {
    writeDependency(project, '@acme/feature-tests', { version: '0.1.0', integrity: INTEGRITY });
    expect(PackageIdentity.forInstall('feature-tests', { project, as: '@local/feature-tests' })).toBe('@local/feature-tests');
    const wrong = refusal(() => PackageIdentity.forInstall('feature-tests', { as: '@acme/gears' }));
    expect(wrong).toMatchObject({ code: 'wrong-name', message: "This file is feature-tests, so it can't install as @acme/gears." });
    const bad = refusal(() => PackageIdentity.forInstall('feature-tests', { as: 'feature-tests' }));
    expect(bad).toMatchObject({ code: 'wrong-name', message: `"feature-tests" is not a package name: ${PackageName.RULE}.` });
  });

  it('reads unreadable pins as none', () => {
    fs.writeFileSync(path.join(project, 'fluidcad.json'), JSON.stringify({ dependencies: { '@acme/feature-tests': '0.1.0' } }));
    expect(PackageIdentity.forInstall('feature-tests', { project })).toBe('@local/feature-tests');
  });

  it('hints at the public name a hub download\'s file name gives, and at nothing else', () => {
    const manifest = { name: 'feature-tests', version: '0.1.0' };
    expect(PackageIdentity.hintFromFileName('/tmp/acme-feature-tests-0.1.0.fluidpkg', manifest)).toBe('@acme/feature-tests');
    expect(PackageIdentity.hintFromFileName('C:\\Downloads\\bea-tools-feature-tests-0.1.0.fluidpkg', manifest)).toBe('@bea-tools/feature-tests');
    for (const file of [
      'feature-tests-0.1.0.fluidpkg', 'acme-feature-tests-0.2.0.fluidpkg', 'acme-gears-0.1.0.fluidpkg',
      'local-feature-tests-0.1.0.fluidpkg', '3d-feature-tests-0.1.0.fluidpkg', 'a-feature-tests-0.1.0.fluidpkg', 'acme-feature-tests-0.1.0.zip',
    ]) {
      expect(PackageIdentity.hintFromFileName(file, manifest), file).toBeNull();
    }
  });

  it('words a missing @local package without the hub', () => {
    expect(PackageIdentity.localSentence('@local/feature-tests', '0.1.0')).toBe(
      "@local/feature-tests 0.1.0 was installed from a file, so the hub doesn't have it: install that file again (`fluidcad install <file>`).",
    );
    expect(ProjectPackages.notInstalledSentence('@local/feature-tests', null)).toBe(
      "@local/feature-tests was installed from a file, so the hub doesn't have it: install that file again (`fluidcad install <file>`).",
    );
    expect(ProjectPackages.notInstalledSentence('@acme/feature-tests', null)).toContain('downloads it from the hub');
    writeDependency(project, '@local/feature-tests', { version: '0.1.0', integrity: INTEGRITY });
    writeDependency(project, '@acme/gears', { version: '1.0.0', integrity: INTEGRITY });
    expect(PackagePins.describeProblems(project)).toEqual([
      'FluidCAD: This project uses `@acme/gears` 1.0.0, which isn\'t installed. `fluidcad install @acme/gears@1.0.0` downloads it from the hub '
        + '(`fluidcad install` alone fetches every missing one), or install it from a file.',
      "FluidCAD: This project uses `@local/feature-tests` 0.1.0, which isn't installed. @local/feature-tests 0.1.0 was installed from a file, "
        + "so the hub doesn't have it: install that file again (`fluidcad install <file>`).",
    ]);
  });
});
