import fs from 'fs';
import path from 'path';
import { START_PAGE_FILE } from './protocol';

/**
 * Where the start page is served from: the engine that ships inside the app.
 *
 * Never `defaultEngine()`'s newest-on-disk fallback: only the built-in engine
 * is staged from the same checkout as the shell (`stage-engine.js` refuses a
 * version mismatch), so only its page is guaranteed to speak this shell's
 * `window.fluidcadShell.start`. A cached engine is some other release.
 *
 * `FLUIDCAD_START_UI=<dir>` points a development run at a build of its own
 * (say, `ui/dist-start` in a checkout); a packaged app ignores it. Null means
 * there is nothing to serve, and the window shows the static fallback.
 */
export function startPageRoot(input: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  /** The built-in engine's `fluidcad` package, if the app has one. */
  builtinPackageRoot: string | null;
}): string | null {
  const override = input.packaged ? undefined : input.env.FLUIDCAD_START_UI;
  const candidate = override
    ? path.resolve(override)
    : input.builtinPackageRoot
      ? path.join(input.builtinPackageRoot, 'ui', 'dist-start')
      : null;
  if (!candidate || !fs.existsSync(path.join(candidate, START_PAGE_FILE))) {
    return null;
  }
  return candidate;
}
