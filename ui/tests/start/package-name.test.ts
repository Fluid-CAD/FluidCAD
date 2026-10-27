import { describe, expect, it } from 'vitest';
import { PackageName } from '../../src/start/package-name';

/**
 * The name a new package gets on the start screen: the engine's `@handle/name`
 * grammar (HD30), checked on the page before the launcher sees it. The
 * launcher's own copy of the pattern is held to this one by
 * `launcher/tests/start-contract.test.ts`.
 */
describe('PackageName', () => {
  it('takes a scoped name and refuses what the engine would', () => {
    for (const name of ['@acme/kit', '@acme/kit-3d', `@${'a'.repeat(39)}/${'k'.repeat(64)}`]) {
      expect(PackageName.isValid(name), name).toBe(true);
      expect(PackageName.problem(name), name).toBeNull();
    }
    for (const name of ['kit', '@acme', '@acme/', '@Acme/kit', '@acme/3d-kit', '@acme/a--b', '@a/kit', `@${'a'.repeat(40)}/kit`, '@acme/kit/extra']) {
      expect(PackageName.isValid(name), name).toBe(false);
      expect(PackageName.problem(name), name).toBe(PackageName.PROBLEM);
    }
  });

  it('has no sentence for an empty field, and trims around the name', () => {
    expect(PackageName.problem('')).toBeNull();
    expect(PackageName.problem('   ')).toBeNull();
    expect(PackageName.problem(' @acme/kit ')).toBeNull();
  });

  it('names the folder after the part behind the slash', () => {
    expect(PackageName.folderNameOf('@acme/kit')).toBe('kit');
    expect(PackageName.folderNameOf('@acme/')).toBe('');
    expect(PackageName.folderNameOf('@acme')).toBe('');
    expect(PackageName.folderNameOf('')).toBe('');
  });
});
