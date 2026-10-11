/**
 * The package name grammars (hub-research HD29, which replaced K4's scope in
 * the author's files):
 *
 * - **The author's bare name** (`feature-tests`): what `fluidcad.json`'s
 *   `package.name` and the archive's `manifest.json` hold. Lowercase
 *   letters, digits and single dashes, starting with a letter, 1–64
 *   characters. It never carries a handle: the hub adds the publisher's
 *   when the package is published.
 * - **The public name** (`@acme/feature-tests`): the consumer side — pins
 *   and `dependencies` keys, import specifiers, library directories, hub
 *   URLs. The scope follows the hub's handle grammar (2–39 characters,
 *   starting with a letter) and the name the bare grammar. A package
 *   installed from a file takes the reserved scope `local` unless it is
 *   given another (`PackageIdentity`).
 *
 * Deliberately dependency-free (no imports at all): `project-config.ts`
 * validates `package.name` and the `dependencies` keys with it, the resolver
 * matches import specifiers with it, and the plain-JS CLI checks `--name`
 * with it as compiled JS out of `server/dist`.
 */
export class PackageName {
  /** The author's name: lowercase letters, digits and single dashes, starting with a letter. */
  static readonly BARE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  /** The longest bare name. */
  static readonly BARE_MAX = 64;

  /** A hub handle, the scope of a public name: the bare grammar, 2–39 characters. */
  static readonly HANDLE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  static readonly HANDLE_MIN = 2;

  static readonly HANDLE_MAX = 39;

  /** The public name, `@<handle>/<bare>` (the lengths are checked by {@link isValid}). */
  static readonly PATTERN = /^@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

  /** The sentence every refusal of a bad public name ends with. */
  static readonly RULE = 'packages are named @scope/name, in lowercase letters, digits and dashes';

  /** The sentence every refusal of a bad bare name ends with. */
  static readonly BARE_RULE = 'package names are lowercase letters, digits and single dashes, starting with a letter';

  /** Whether `name` is a public name, `@acme/feature-tests`. */
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

  /** Whether `name` is an author's bare name, `feature-tests`. */
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

  /** `@acme/gears` → `acme`; null for anything that isn't a public name. */
  static scope(name: string): string | null {
    if (!PackageName.isValid(name)) {
      return null;
    }
    return name.slice(1, name.indexOf('/'));
  }

  /** `@acme/feature-tests` → `feature-tests`; null for anything that isn't a public name. */
  static bareOf(name: string): string | null {
    if (!PackageName.isValid(name)) {
      return null;
    }
    return name.slice(name.indexOf('/') + 1);
  }

  /** `('acme', 'feature-tests')` → `@acme/feature-tests`, refusing parts that don't make a public name. */
  static publicName(scope: string, bare: string): string {
    const name = `@${scope}/${bare}`;
    if (!PackageName.isValid(name)) {
      throw new Error(`${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
    }
    return name;
  }
}
