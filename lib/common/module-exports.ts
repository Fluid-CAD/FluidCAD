/**
 * Reading a model module's exports the way a render does.
 *
 * A host resolves every export of the module it renders before anything
 * builds: a value as it is, and a function — a factory, such as
 * `export const frame = (w = 700) => assembly(…)` — called with no
 * arguments for what it returns. The rules:
 *
 * - **A class is never called.** An exported class (`export class
 *   Cabinet extends Generator.with({ … })`, a `Feature.with()` class) is a
 *   declaration the module shares, not a factory: calling it without `new`
 *   throws. It is read as the value it is, so a generator class may sit
 *   beside the `defineAssembly()` that uses it.
 * - Anything else that is a function is a factory, called once.
 */
export class ModuleExports {

  /**
   * Whether `value` is a class: a function whose source text is a class
   * declaration (`class X …`). Engines print a class's own text for it,
   * whatever the module was compiled from, so this holds for every class
   * syntax declares; a constructor function written the old way is a plain
   * function and stays a factory.
   */
  static isClass(value: unknown): boolean {
    if (typeof value !== 'function') {
      return false;
    }
    try {
      return /^class\b/.test(Function.prototype.toString.call(value));
    } catch {
      return false;
    }
  }

  /** Whether `value` is a factory a render calls for what it returns: a function that is not a class. */
  static isFactory(value: unknown): value is () => unknown {
    return typeof value === 'function' && !ModuleExports.isClass(value);
  }

  /** An export as a render reads it: a factory called with no arguments, awaited; a class and any other value as they are. */
  static async resolve(value: unknown): Promise<unknown> {
    return ModuleExports.isFactory(value) ? await value() : value;
  }
}
