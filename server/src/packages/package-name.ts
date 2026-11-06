/**
 * The package name grammar (research §1, K11; hub-research HD30): one name
 * per package, the public one, `@<handle>/<name>`, which the author writes
 * in `fluidcad.json`'s `package.name` and which the archive's
 * `manifest.json`, the hub's URLs, pins and `dependencies` keys, import
 * specifiers and library directories all hold. The scope is the author's
 * hub handle (2–39 characters); each part is lowercase letters, digits and
 * single dashes, starting with a letter; the name after the slash is at
 * most 64 characters.
 *
 * The bare grammar (`feature-tests`) is a detector only: it decides when a
 * refusal can suggest `@<your-handle>/<name>` and when `package init` adds
 * the signed-in handle.
 *
 * Deliberately dependency-free (no imports at all): `project-config.ts`
 * validates `package.name` and the `dependencies` keys with it, the resolver
 * matches import specifiers with it, and the plain-JS CLI checks `--name`
 * with it as compiled JS out of `server/dist`.
 */
export class PackageName {
  /** A name without its scope (`feature-tests`): lowercase letters, digits and single dashes, starting with a letter. */
  static readonly BARE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  /** The longest name after the slash. */
  static readonly BARE_MAX = 64;

  /** A hub handle, the scope of a package name: the bare grammar, 2–39 characters. */
  static readonly HANDLE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  static readonly HANDLE_MIN = 2;

  static readonly HANDLE_MAX = 39;

  /** A package name, `@<handle>/<name>` (the lengths are checked by {@link isValid}). */
  static readonly PATTERN = /^@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

  /** The sentence every refusal of a bad name ends with. */
  static readonly RULE = 'packages are named @handle/name, each part in lowercase letters, digits and single dashes, starting with a letter';

  /** Whether `name` is a package name, `@acme/feature-tests`. */
  static isValid(name: unknown): name is string {
    if (typeof name !== 'string') {
      return false;
    }
    const match = PackageName.PATTERN.exec(name);
    if (!match) {
      return false;
    }
    return PackageName.isHandle(match[1]) && match[2].length <= PackageName.BARE_MAX;
  }

  /**
   * Whether `name` is a name without its scope, `feature-tests`: a refusal
   * then suggests `@<your-handle>/feature-tests`.
   */
  static isBare(name: unknown): name is string {
    return typeof name === 'string' && name.length >= 1 && name.length <= PackageName.BARE_MAX && PackageName.BARE.test(name);
  }

  /** Whether `handle` follows the hub's handle grammar. */
  static isHandle(handle: unknown): handle is string {
    return typeof handle === 'string'
      && handle.length >= PackageName.HANDLE_MIN
      && handle.length <= PackageName.HANDLE_MAX
      && PackageName.HANDLE.test(handle);
  }

  /** `@acme/gears` → `acme`; null for anything that isn't a package name. */
  static scope(name: string): string | null {
    if (!PackageName.isValid(name)) {
      return null;
    }
    return name.slice(1, name.indexOf('/'));
  }

  /** `@acme/feature-tests` → `feature-tests`; null for anything that isn't a package name. */
  static bareOf(name: string): string | null {
    if (!PackageName.isValid(name)) {
      return null;
    }
    return name.slice(name.indexOf('/') + 1);
  }

  /** `('acme', 'feature-tests')` → `@acme/feature-tests`, refusing parts that don't make a package name. */
  static publicName(scope: string, bare: string): string {
    const name = `@${scope}/${bare}`;
    if (!PackageName.isValid(name)) {
      throw new Error(`${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
    }
    return name;
  }
}
