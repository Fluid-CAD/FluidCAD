import { AssetRoots } from "../io/asset-roots.js";

/**
 * Which module declares a class whose values are an interface: the module
 * that called `Feature.with()` or `Generator.with()` — `class Gear extends
 * Feature.with({ … })` runs there. A generated definition's schema resolves
 * the values' own pictures (option images, asides) and a borrowed dialog
 * layout against that module (`GeneratedAssetBase` `'class'`), so a host
 * that serves them, or packs them, has to know it.
 *
 * The rules:
 * - The module is read when `.with()` runs: the innermost frame of the
 *   stack outside the engine (`AssetRoots.callerFile`), a path as hosts
 *   name files (the live editor buffer's prefix dropped). An engine that
 *   gives no stack, or a stack with no such frame (a bundle), records none.
 * - A class answers for every class that extends it: the lookup walks the
 *   prototype chain to the base `.with()` made.
 * - Each evaluation of a module makes a new base, so a re-evaluated module
 *   records again; nothing is ever overwritten.
 */
export class ClassModules {

  private static readonly modules = new WeakMap<Function, string>();

  /** Record the module calling `.with()` as `base`'s: called by `Feature.with()` and `Generator.with()` on the base they make. */
  static note(base: Function): void {
    const file = AssetRoots.callerFile();
    if (file !== null) {
      ClassModules.modules.set(base, file);
    }
  }

  /** The module that declared `cls`'s values (see {@link note}), from the nearest base in its chain that has one; null when none was recorded. */
  static of(cls: Function): string | null {
    for (let current: unknown = cls; typeof current === 'function' && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
      const file = ClassModules.modules.get(current as Function);
      if (file !== undefined) {
        return file;
      }
    }
    return null;
  }
}
