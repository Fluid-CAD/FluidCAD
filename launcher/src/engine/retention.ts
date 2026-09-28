import fs from 'fs';
import path from 'path';
import { builtinEngine, describeEngineAt, markEngineInstalled, type InstalledEngine } from './cache.ts';
import { engineRoot } from '../paths.ts';
import { EngineScratch } from './scratch.ts';

/**
 * Keeping the app's own engine for the projects that pin it.
 *
 * The built-in engine runs from inside the app bundle, and an app update
 * replaces the bundle. Every project pinned to it then had to download that
 * version again on its next open: ~30 MB from GitHub before the window showed
 * anything. That is what failed on poor connections (GH #80). So the first
 * time a project pins the built-in version, the launcher copies the engine into
 * the home cache (`~/.fluidcad/engines/<version>`), where downloaded engines
 * live. While the app still ships that version the copy stays hidden
 * (`listEngines` keeps one entry per version: the built-in one). Once an update
 * moves the app on, it is an ordinary cached engine, and the prune step keeps
 * it for as long as a recent project pins it.
 *
 * It never copies earlier: a version no project pins is not worth an engine's
 * disk. It never copies into a project: one engine serves every project that
 * pins it. And it never copies the package `npx fluidcad` runs from: npm owns
 * that one, and a project pinned to it downloads the engine like any other.
 */
export class BuiltinEngineRetention {
  /** One copy per version at a time; later callers join it. */
  private static readonly pending = new Map<string, Promise<InstalledEngine>>();

  /**
   * Make sure the home cache holds the engine `pin` names, when that is the
   * engine shipped inside the app. Resolves to the cached copy, or to null
   * when `pin` is not the built-in version, or the built-in engine is not a
   * copyable root, because then there is nothing of the app's to keep.
   */
  static ensure(pin: string | null): Promise<InstalledEngine | null> {
    const builtin = builtinEngine();
    if (!pin || !builtin || builtin.version !== pin || builtin.root === null) {
      return Promise.resolve(null);
    }
    const cached = BuiltinEngineRetention.cachedCopy(builtin.version);
    if (cached) {
      return Promise.resolve(cached);
    }
    let copying = BuiltinEngineRetention.pending.get(builtin.version);
    if (!copying) {
      copying = BuiltinEngineRetention.copy({ ...builtin, root: builtin.root }).finally(() => {
        BuiltinEngineRetention.pending.delete(builtin.version);
      });
      BuiltinEngineRetention.pending.set(builtin.version, copying);
    }
    return copying;
  }

  /**
   * `ensure` for callers that must not wait on it: the copy runs in the
   * background, and a failure only means the next app update downloads this
   * engine again, as it did before this class existed.
   */
  static ensureInBackground(pin: string | null): void {
    BuiltinEngineRetention.ensure(pin).catch((err) => {
      console.warn(`[engine] could not keep engine ${pin} for after an update: ${err?.message ?? err}`);
    });
  }

  private static cachedCopy(version: string): InstalledEngine | null {
    const copy = describeEngineAt(engineRoot(version), false);
    return copy?.version === version ? copy : null;
  }

  private static async copy(builtin: InstalledEngine & { root: string }): Promise<InstalledEngine> {
    const scratch = EngineScratch.create();
    const staging = scratch.file('engine');
    try {
      await fs.promises.cp(builtin.root, staging, {
        recursive: true,
        // The engine's `node_modules/.bin` links are relative. Resolved, they
        // would point back into the bundle the next update deletes.
        verbatimSymlinks: true,
        // A copy-on-write clone where libuv can make one (btrfs, XFS), a
        // plain copy elsewhere. That includes macOS: libuv has no clonefile().
        mode: fs.constants.COPYFILE_FICLONE,
      });
      if (describeEngineAt(staging, false)?.version !== builtin.version) {
        throw new Error(`the copy of engine ${builtin.version} is incomplete`);
      }

      const destination = engineRoot(builtin.version);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        fs.renameSync(staging, destination);
      } catch (err) {
        // A download of the same version landed first. It is the same engine.
        if (!BuiltinEngineRetention.cachedCopy(builtin.version)) {
          throw err;
        }
      }

      const kept = BuiltinEngineRetention.cachedCopy(builtin.version);
      if (!kept) {
        throw new Error(`engine ${builtin.version} did not land in ${destination}`);
      }
      markEngineInstalled(builtin.version);
      return kept;
    } finally {
      scratch.dispose();
    }
  }
}
