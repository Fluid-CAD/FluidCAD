import { resolve } from 'path';
import { HubCli } from './hub.js';

/**
 * The terminal around the server's `HubMaintainer` (H12), shared by
 * `fluidcad deprecate` and `listing`: the hub and the token as `publish`
 * resolves them (`--hub`, `FLUIDCAD_HUB_URL`, the signed-in credential), the
 * workspace a command without a package name reads `package.name` from, and
 * one way to word a refusal: its sentence, exit 1.
 */
export class HubMaintainCli {
  /** Runs `work(maintainer, context)`; a refusal prints its sentence and exits 1. */
  static async run(opts, work) {
    const mods = await HubCli.loadMaintainer();
    const config = HubCli.config(mods, opts);
    const maintainer = new mods.HubMaintainer({
      config,
      credential: mods.HubCredentials.read(config.origin),
      version: HubCli.version(),
    });
    const context = { mods, hub: config.origin, workspace: resolve(opts.workspace ?? process.cwd()) };
    try {
      await work(maintainer, context);
    } catch (err) {
      HubCli.exitOnRefusal(err, mods);
    }
  }

  /** A commander action that runs `fn` and exits 0, or prints what went wrong and exits 1. */
  static action(fn) {
    return (...args) => {
      fn(...args)
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    };
  }

  /** `"text"`, as the output quotes what the owner wrote. */
  static quoted(text) {
    return `“${text}”`;
  }

  /** `24.1 kB`, `1.2 MB`. */
  static size(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} kB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
