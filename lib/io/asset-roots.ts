import { StackFrames } from "../common/stack-frames.js";

/**
 * Where the files a call reads live when they are not the workspace's: an
 * installed package's own directory.
 */
export type AssetRoot = {
  /** The package directory, absolute: what disk reads, stamps and render inputs resolve against. */
  dir: string;
  /**
   * The prefix an asset provider is asked under (`packages/@acme/kit/1.2.0/`,
   * ending in a slash), or null when no provider's tree carries the
   * directory: the root is then read from disk alone.
   */
  key: string | null;
  /** The package, for a sentence: `@acme/kit@1.2.0`. */
  label: string;
};

/**
 * Answers the asset root of a call written in `callerFile` (an absolute
 * path): the installed package that owns the file, or null for anything
 * else — a workspace file, a file no package owns, a file of the engine.
 */
export type AssetRootSource = (callerFile: string) => AssetRoot | null;

/**
 * Where a `load()` or a `.font()` reads its file (`{ from }`): `'package'`,
 * the default, beside the file that wrote the call — its installed package's
 * own directory, or the project for a file no package owns; `'project'`, the
 * project that uses the package, whatever file wrote the call.
 */
export type AssetFrom = 'package' | 'project';

type AssetRootsState = {
  source: AssetRootSource | null;
};

/**
 * Which directory a `load()`'s `imports/` and a `.font()`'s font file are
 * read under: the installed package that owns the file that wrote the
 * call, the way a relative import resolves against the importing file. A
 * package part's `load("motor.step")` reads the package's own
 * `imports/motor.brep`; the same call written in the project's own file
 * reads the project's. `{ from: 'project' }` reads the project's whatever
 * file wrote the call: how a package reads a file name the model using it
 * passes in.
 *
 * The file that wrote the call is the innermost frame of the stack outside
 * the engine, read when the statement is made: a part body that builds
 * after its module evaluated, a feature's build at render time and a
 * package's helper called from the model's own code all run in the file
 * that holds the call. Mapping that file to a package is the host's: the
 * server installs an {@link AssetRootSource} that answers by its project's
 * installed packages (location plus marker). No source installed — the
 * browser host, a bare `init()`, the tests — reads every asset under the
 * workspace, as before packages had assets, and captures no stack.
 *
 * The state sits on a registry symbol, so a kernel copy other than the
 * server's own reads the same source.
 */
export class AssetRoots {
  /** The values `{ from }` takes. */
  static readonly FROM: readonly AssetFrom[] = ['package', 'project'];

  private static readonly SLOT: unique symbol = Symbol.for('fluidcad.asset-roots') as never;

  /** The directory the engine's own modules sit under (`…/lib/dist/` or `…/lib/`), read once. */
  private static engineDir: string | null | undefined;

  /** Install the host's source (null removes it); answers the one it replaces. */
  static use(source: AssetRootSource | null): AssetRootSource | null {
    const state = AssetRoots.state();
    const previous = state.source;
    state.source = source;
    return previous;
  }

  /** Whether a source is installed: without one, every asset is the workspace's. */
  static active(): boolean {
    return AssetRoots.state().source !== null;
  }

  /**
   * The `{ from }` a call passed, checked: `'package'` when left out, and a
   * refusal naming `callee` (`load()`, `text().font()`) for anything but
   * the two values.
   */
  static parseFrom(callee: string, value: unknown): AssetFrom {
    if (value === undefined) {
      return 'package';
    }
    if (typeof value === 'string' && (AssetRoots.FROM as readonly string[]).includes(value)) {
      return value as AssetFrom;
    }
    throw new Error(`${callee}: from must be 'package' or 'project', not ${AssetRoots.describeValue(value)}`);
  }

  /**
   * The root the call being made reads its file under: null — the
   * workspace — for `'project'`, and for `'package'` the package that owns
   * the file that wrote the call ({@link callerFile}), null when none does.
   * Called from the engine method the author's code called (the statement's
   * constructor, `.font()`), so the stack still holds the author's frame.
   */
  static forCall(from: AssetFrom): AssetRoot | null {
    if (from === 'project' || !AssetRoots.active()) {
      return null;
    }
    return AssetRoots.rootFor(AssetRoots.callerFile());
  }

  /** The root a call written in `callerFile` reads under: the source's answer, null without a source, a file or an answer. */
  static rootFor(callerFile: string | null): AssetRoot | null {
    const source = AssetRoots.state().source;
    if (source === null || callerFile === null) {
      return null;
    }
    let root: AssetRoot | null;
    try {
      root = source(callerFile);
    } catch {
      return null;
    }
    if (!root || typeof root.dir !== 'string' || root.dir === '') {
      return null;
    }
    return { dir: root.dir, key: typeof root.key === 'string' && root.key !== '' ? root.key : null, label: String(root.label ?? root.dir) };
  }

  /** The file that wrote the call being made: the innermost frame of the current stack outside the engine. */
  static callerFile(): string | null {
    const stack = StackFrames.capture();
    return stack ? AssetRoots.callerFileIn(stack) : null;
  }

  /**
   * The innermost frame of `stack` outside the engine, by its path: not one
   * of the engine's own modules (its tests are not the engine), not a Node
   * built-in, and a path at all (`<anonymous>` is none). Null when every
   * frame is the engine's.
   */
  static callerFileIn(stack: string, engineDir: string | null = AssetRoots.ownDir()): string | null {
    for (const frame of StackFrames.parse(stack)) {
      const file = frame.filePath;
      if (!AssetRoots.isPath(file)) {
        continue;
      }
      if (engineDir !== null && AssetRoots.isEngineFile(file, engineDir)) {
        continue;
      }
      return file;
    }
    return null;
  }

  /** "imports/mine.brep in @acme/labels@1.2.0. If the name comes from the model using the package, read it with …". */
  static describeMissing(subject: string, relPath: string, root: AssetRoot, escape: string): string {
    return `${subject}: ${relPath} in ${root.label}. If the name comes from the model using the package, read it with ${escape}.`;
  }

  /** Where a root is, for a sentence: the package, or the workspace for none. */
  static describe(root: AssetRoot | null): string {
    return root ? root.label : 'the workspace';
  }

  /** Whether `file` is one of the engine's modules under `engineDir` — its tests are not. */
  private static isEngineFile(file: string, engineDir: string): boolean {
    return file.startsWith(engineDir) && !file.startsWith(`${engineDir}tests/`);
  }

  /** An absolute path: POSIX, or a Windows drive. A Node built-in (`node:…`), `<anonymous>` or a URL is none. */
  private static isPath(file: string): boolean {
    return file.startsWith('/') || /^[A-Za-z]:\//.test(file);
  }

  /**
   * The directory the engine's modules sit under, ending in a slash: two
   * levels above this module's own frame (`<engine>/io/asset-roots.js`).
   * Read off a stack, not `import.meta`, so bundles that rewrite it keep
   * the answer; null when the engine gives no stack.
   */
  private static ownDir(): string | null {
    if (AssetRoots.engineDir !== undefined) {
      return AssetRoots.engineDir;
    }
    const stack = new Error().stack;
    const self = stack ? StackFrames.parse(stack).find((frame) => AssetRoots.isPath(frame.filePath)) : undefined;
    if (!self) {
      AssetRoots.engineDir = null;
      return null;
    }
    const segments = self.filePath.split('/');
    AssetRoots.engineDir = segments.length > 2 ? `${segments.slice(0, -2).join('/')}/` : null;
    return AssetRoots.engineDir;
  }

  private static describeValue(value: unknown): string {
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }

  private static state(): AssetRootsState {
    const holder = globalThis as unknown as Record<symbol, AssetRootsState | undefined>;
    let state = holder[AssetRoots.SLOT];
    if (!state) {
      state = { source: null };
      holder[AssetRoots.SLOT] = state;
    }
    return state;
  }
}
