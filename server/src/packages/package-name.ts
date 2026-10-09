/**
 * The package name grammar (research §1, K11): always scoped, `@scope/name`,
 * lowercase letters, digits and dashes. The scope becomes the publisher
 * handle on the hub, and a package's feature ids must start with it (K4).
 *
 * Deliberately dependency-free (no imports at all): `project-config.ts`
 * validates `package.name` and the `dependencies` keys with it, the resolver
 * matches import specifiers with it, and the plain-JS CLI checks `--name`
 * with it as compiled JS out of `server/dist`.
 */
export class PackageName {
  static readonly PATTERN = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}$/;

  /** The sentence every refusal of a bad name ends with. */
  static readonly RULE = 'packages are named @scope/name, in lowercase letters, digits and dashes';

  static isValid(name: unknown): name is string {
    return typeof name === 'string' && PackageName.PATTERN.test(name);
  }

  /** `@acme/gears` → `acme`; null for anything that isn't a package name. */
  static scope(name: string): string | null {
    if (!PackageName.isValid(name)) {
      return null;
    }
    return name.slice(1, name.indexOf('/'));
  }
}
