/**
 * A feature's catalog key: the plain id its class declares (`standoff`), or
 * for a feature loaded from an installed package, the package's public name
 * and that id (`@acme/feature-tests:standoff`). Two publishers can each ship
 * a `standoff`, and their keys never collide.
 *
 * `:` can't appear in an id (dot-separated names of letters, digits, `-`
 * and `_`) nor in a package name, so a key always parses back. Keys are
 * runtime catalog keys only: no model file ever holds one.
 */
export class FeatureKey {
  /** Between the package's public name and the plain id. */
  static readonly SEPARATOR = ':';

  /** `('@acme/feature-tests', 'standoff')` → `@acme/feature-tests:standoff`. */
  static of(packageName: string, id: string): string {
    return `${packageName}${FeatureKey.SEPARATOR}${id}`;
  }

  /** The package a key names (null for a plain id) and its plain id. */
  static parse(key: string): { packageName: string | null; id: string } {
    const at = key.lastIndexOf(FeatureKey.SEPARATOR);
    if (at < 0) {
      return { packageName: null, id: key };
    }
    return { packageName: key.slice(0, at), id: key.slice(at + 1) };
  }

  /** The plain id: `@acme/feature-tests:standoff` → `standoff`; a plain id as it is. */
  static idOf(key: string): string {
    return FeatureKey.parse(key).id;
  }

  /** What messages call a feature's builder: the plain id's last dot segment (`@acme/kit:acme.standoff` → `standoff`). */
  static calleeOf(key: string): string {
    return FeatureKey.idOf(key).split('.').pop()!;
  }
}
