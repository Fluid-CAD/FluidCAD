/**
 * Which scene-row types are custom features' — the workspace's own, and
 * installed packages'. A custom feature's row is typed by its catalog key:
 * its plain id (`standoff`) in the workspace that declares it, keyed by the
 * package for an installed one (`@acme/feature-tests:standoff`). Neither is
 * a word to show: the row's name ("Standoff") is.
 *
 * The feature catalog registers each workspace feature's id as it adds the
 * feature's dialog. A package key is told by its separator, whether or not
 * the catalog has loaded; so is a dotted id (`acme.standoff`), which no
 * engine type has.
 */
export class CustomFeatureTypes {
  /** Between a package's public name and a plain id in a key (the engine's `FeatureKey.SEPARATOR`). */
  static readonly KEY_SEPARATOR = ':';

  private static readonly registered = new Set<string>();

  static register(type: string): void {
    CustomFeatureTypes.registered.add(type);
  }

  static unregister(type: string): void {
    CustomFeatureTypes.registered.delete(type);
  }

  /** Whether `type` is a custom feature's: a package key, a dotted id, or an id the catalog registered. */
  static isCustom(type: string | undefined | null): boolean {
    if (!type) {
      return false;
    }
    return type.includes(CustomFeatureTypes.KEY_SEPARATOR) || type.includes('.') || CustomFeatureTypes.registered.has(type);
  }
}
