import { describe, it, expect } from 'vitest';
import { PackageName } from '../../src/packages/package-name.ts';
import { PackageLayout } from '../../src/packages/package-manifest.ts';

/**
 * HD30: a package has one name, `@<handle>/<name>`, which its author writes
 * in `fluidcad.json` and which the archive, the hub, pins, imports and
 * library paths all hold. The name without its scope is a detector only:
 * it lets a refusal suggest `@<your-handle>/<name>`.
 */

describe('PackageName', () => {
  it('reads a package name: a handle (2–39 characters) and a name (at most 64), each part letter-first with single dashes', () => {
    for (const name of ['@acme/feature-tests', '@acme/kit', '@bea-tools/feature-tests', '@acme-robotics/gear-train-2', `@${'a'.repeat(39)}/${'g'.repeat(64)}`]) {
      expect(PackageName.isValid(name), name).toBe(true);
    }
    for (const name of [
      '@3d/kit', '@acme/3d-kit', '@acme/a--b', '@a/kit', `@${'a'.repeat(40)}/kit`, `@acme/${'g'.repeat(65)}`, 'feature-tests',
      '@acme--tools/kit', '@acme/-kit', '@acme/kit-', '@Acme/kit', '@acme/', '@acme/kit/x', '', 7, null,
    ]) {
      expect(PackageName.isValid(name), String(name)).toBe(false);
    }
  });

  it('detects a name written without its scope, so a refusal can suggest one', () => {
    for (const name of ['kit', 'feature-tests', 'a', 'gears2', 'g'.repeat(64)]) {
      expect(PackageName.isBare(name), name).toBe(true);
    }
    for (const name of ['', '3d-kit', '-kit', 'kit-', 'feature--tests', 'Kit', 'g'.repeat(65), '@acme/kit', 7, null]) {
      expect(PackageName.isBare(name), String(name)).toBe(false);
    }
  });

  it('says the rule every refusal of a bad name ends with', () => {
    expect(PackageName.RULE).toBe('packages are named @handle/name, each part in lowercase letters, digits and single dashes, starting with a letter');
  });

  it('splits a name and builds one from a handle', () => {
    expect(PackageName.scope('@acme/feature-tests')).toBe('acme');
    expect(PackageName.bareOf('@acme/feature-tests')).toBe('feature-tests');
    expect(PackageName.scope('feature-tests')).toBeNull();
    expect(PackageName.publicName('acme', 'feature-tests')).toBe('@acme/feature-tests');
    expect(() => PackageName.publicName('acme', '3d')).toThrow(`"@acme/3d" is not a package name: ${PackageName.RULE}.`);
  });

  it('names an archive <scope>-<name>-<version>.fluidpkg, and refuses a name without its scope', () => {
    expect(PackageLayout.archiveName('@acme/feature-tests', '0.1.0')).toBe('acme-feature-tests-0.1.0.fluidpkg');
    expect(() => PackageLayout.archiveName('feature-tests', '0.1.0')).toThrow(`"feature-tests" is not a package name: ${PackageName.RULE}.`);
  });
});
