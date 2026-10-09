import os from 'os';
import path from 'path';

/**
 * The per-user FluidCAD directory, the home directory's `~/.fluidcad`, or
 * `$FLUIDCAD_HOME` when that is set (CI, and the desktop shell's E2E
 * isolation). The launcher keeps its engines and app state there and has
 * its own copy of this rule (`launcher/src/paths.ts`); the launcher and the
 * server deliberately never import each other.
 *
 * `global-registry.ts` does not use this: `instances.json` stays in the
 * home directory's `~/.fluidcad` whatever `FLUIDCAD_HOME` says, so every
 * MCP process finds every running engine.
 */
export class FluidcadHome {
  static readonly DIR_NAME = '.fluidcad';

  /** `$FLUIDCAD_HOME`, resolved, or the home directory's `~/.fluidcad`. */
  static dir(): string {
    const override = process.env.FLUIDCAD_HOME;
    if (override) {
      return path.resolve(override);
    }
    return path.join(os.homedir(), FluidcadHome.DIR_NAME);
  }

  /** A path inside {@link dir}. */
  static file(...segments: string[]): string {
    return path.join(FluidcadHome.dir(), ...segments);
  }
}
