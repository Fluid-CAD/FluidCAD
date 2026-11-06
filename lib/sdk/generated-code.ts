import { TextDigest } from "../common/text-digest.js";
import { FeatureNamespaces } from "./feature-namespaces.js";

/**
 * The code versions of generated definitions: what keeps a part built by a
 * definition's old code from standing in for one its new code builds — in
 * the next render's compare and in the template cache, whose keys hold the
 * version. Two kinds of definition have one: a generated assembly
 * (`defineAssembly`, whose templates its generator class builds) and a
 * generated part (`definePart`, whose variants its feature class builds).
 *
 * A definition's code version is `<epoch>:<base>`, where the base is fixed
 * by the class that builds its parts ({@link baseOf}):
 * - **its origin** — an installed package's stamp, its name, version and
 *   tree hash, which change exactly when its code can (so package code
 *   needs no other signal), else `workspace`; read where the class's
 *   values were declared (`Generator.with()`, `Feature.with()`);
 * - **a digest of the class's own text**, every class of its chain — an
 *   edit of `layout`, `build` or `buildTool` changes it, saved or not;
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

  /** The definition ids each module defined (`defineAssembly()`'s or `definePart()`'s file, or its class's), as evaluated so far. */
  private static readonly definedIn = new Map<string, Set<string>>();

  /**
   * Each class `Generator.with()` or `Feature.with()` made, with where the
   * code that called it comes from: the stamp of the installed package
   * whose module was evaluating (`FeatureNamespaces.currentStamp`), else
   * `workspace`.
   */
  private static readonly origins = new WeakMap<Function, string>();

  /** Each class's own text digest, made on first ask: an engine base is one object for the whole process. */
  private static readonly digests = new WeakMap<Function, string>();

  /** Each class's recorded origin (null: none in its chain) and chain digest, made on first ask (see {@link baseOf}). */
  private static readonly bases = new WeakMap<Function, { origin: string | null; digest: string }>();

  /**
   * Record where the class `.with()` just made comes from — called by
   * `Generator.with()` and `Feature.with()` on the base they return, while
   * the module that declares the class evaluates (`class X extends
   * Feature.with({ … })` runs there).
   */
  static noteOrigin(base: Function): void {
    GeneratedCode.origins.set(base, FeatureNamespaces.currentStamp() ?? 'workspace');
  }

  /**
   * The fixed part of a code version for parts `cls` builds:
   * `<origin>:<digest>` — where its code comes from (the origin {@link
   * noteOrigin} recorded for the nearest class of its chain that has one;
   * else `fallbackOrigin`, the stamp where the definition was made; else
   * `workspace`) and a digest of the text of every class of its chain, the
   * engine's bases included (an engine upgrade is new code too). Evaluating
   * the same code again gives the same base.
   */
  static baseOf(cls: Function, fallbackOrigin: string | null = null): string {
    let known = GeneratedCode.bases.get(cls);
    if (known === undefined) {
      let origin: string | null = null;
      const digests: string[] = [];
      for (let current: unknown = cls; typeof current === 'function' && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
        const recorded = GeneratedCode.origins.get(current as Function);
        if (origin === null && recorded !== undefined) {
          origin = recorded;
        }
        digests.push(GeneratedCode.digestOf(current as Function));
      }
      known = { origin, digest: TextDigest.of(digests.join(':')) };
      GeneratedCode.bases.set(cls, known);
    }
    return `${known.origin ?? fallbackOrigin ?? 'workspace'}:${known.digest}`;
  }

  /**
   * Note that the module at `file` defines `id` — where `defineAssembly()`
   * or `definePart()` ran, or where the class its parts are built by
   * declared its values. {@link modulesChanged} reads it.
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

  /** The digest of one class's own source text. */
  private static digestOf(cls: Function): string {
    let digest = GeneratedCode.digests.get(cls);
    if (digest === undefined) {
      digest = TextDigest.of(Function.prototype.toString.call(cls));
      GeneratedCode.digests.set(cls, digest);
    }
    return digest;
  }

  private static epochOf(id: string): number {
    return GeneratedCode.epochs.get(id) ?? 0;
  }

  /** A file as the module graph and stack frames both name it: forward slashes, no live-buffer overlay. */
  private static pathOf(file: string): string {
    return file.replace('virtual:live-render:', '').replace(/\\/g, '/');
  }
}
