/**
 * The code versions of generated definitions: what keeps a part template
 * built by a generator's old code from standing in for one its new code
 * builds — in the next render's compare and in the template cache, whose
 * keys hold the version.
 *
 * A definition's code version is `<epoch>:<base>`, where the base is fixed
 * by the generator class (`Generator.codeBaseOf`):
 * - **its origin** — an installed package's stamp, its name, version and
 *   tree hash, which change exactly when its code can (so package code
 *   needs no other signal), else `workspace`;
 * - **a digest of the class's own text**, every class of its chain — an
 *   edit of `layout` or `build` changes it, saved or not;
 * - and the **epoch**, a counter per definition id kept here, which the host
 *   bumps when a workspace module the definition's module imports changes
 *   ({@link modulesChanged}): helper code outside the class reaches no
 *   digest, and the host's module graph knows who imports what.
 *
 * Process-wide, like the template cache it keys: modules are evaluated
 * again on every render, so the class objects are new each time while the
 * code they hold is mostly not.
 */
export class GeneratedCode {

  /** Each definition id's epoch; absent is 0. */
  private static readonly epochs = new Map<string, number>();

  /** The definition ids each module defined (`defineAssembly()`'s file), as evaluated so far. */
  private static readonly definedIn = new Map<string, Set<string>>();

  /**
   * Note that the module at `file` defines `id` — where `defineAssembly()`
   * ran. {@link modulesChanged} reads it.
   */
  static noteDefinition(id: string, file: string | null | undefined): void {
    if (!file) {
      return;
    }
    const path = GeneratedCode.pathOf(file);
    let ids = GeneratedCode.definedIn.get(path);
    if (!ids) {
      ids = new Set();
      GeneratedCode.definedIn.set(path, ids);
    }
    ids.add(id);
  }

  /** The code version of definition `id` whose class's base is `base` (see the class comment). */
  static versionOf(id: string, base: string): string {
    return `${GeneratedCode.epochOf(id)}:${base}`;
  }

  /**
   * Whether `version` — a version {@link versionOf} gave for `id` — is still
   * current: no module the definition imports changed since.
   */
  static isCurrent(id: string, version: string): boolean {
    return version.startsWith(`${GeneratedCode.epochOf(id)}:`);
  }

  /**
   * Workspace modules changed — `files`, as the host names them: a saved
   * file and every module that imports it, directly or through another.
   * Every definition one of them defined takes a new code version: what was
   * built with the old one is never served again. Answers those
   * definitions' ids.
   */
  static modulesChanged(files: Iterable<string>): string[] {
    const ids = new Set<string>();
    for (const file of files) {
      for (const id of GeneratedCode.definedIn.get(GeneratedCode.pathOf(file)) ?? []) {
        ids.add(id);
      }
    }
    GeneratedCode.changed(ids);
    return [...ids];
  }

  /** The code of these definitions changed: each takes a new code version. */
  static changed(ids: Iterable<string>): void {
    for (const id of ids) {
      GeneratedCode.epochs.set(id, GeneratedCode.epochOf(id) + 1);
    }
  }

  private static epochOf(id: string): number {
    return GeneratedCode.epochs.get(id) ?? 0;
  }

  /** A file as the module graph and stack frames both name it: forward slashes, no live-buffer overlay. */
  private static pathOf(file: string): string {
    return file.replace('virtual:live-render:', '').replace(/\\/g, '/');
  }
}
