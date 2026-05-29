import { LocalSceneHost } from '../host/local-scene-host.ts';
import { FluidCadServer } from '../fluidcad-server.ts';
import type { ParamDefinition } from '../../../lib/dist/index.js';

/**
 * Render a model once, headlessly, and return its full parameter schema.
 *
 * Param *definitions* (type, default, current value, constraints) only exist
 * after the engine runs the model — the packer/bundler never executes user
 * code, so a static manifest can carry override values at most. `fluidcad
 * publish` calls this to capture the real schema and embeds it in the manifest
 * (`paramDefinitions`), so the hub can build param forms without a live worker.
 *
 * The render doubles as a build gate: a compile/runtime error in the model
 * propagates out of here, failing the publish before any draft is created.
 *
 * Side-effect-free at import time — it constructs its own `FluidCadServer`
 * (which boots OC wasm + a Vite SSR pipeline) and tears the Vite server down
 * before returning so a one-shot CLI process can exit. Import this (or use
 * `fluidcad/server/api`), NOT `fluidcad/server`, which boots the desktop binary.
 */
export async function captureParamDefinitions(
  entryPath: string,
  workspacePath: string,
): Promise<ParamDefinition[]> {
  const host = new LocalSceneHost();
  const server = new FluidCadServer(host);
  try {
    await server.init(workspacePath);
    const rendered = await server.processFile(entryPath);
    if (!rendered) {
      throw new Error(
        'The engine did not initialize — is there an init.js at the workspace root? ' +
          'Run `fluidcad init` to scaffold one.',
      );
    }
    return rendered.params ?? [];
  } finally {
    // LocalSceneHost.init() starts a Vite dev server that keeps the event loop
    // alive; close it so the CLI can exit after a single render.
    try {
      await host.server?.close();
    } catch {
      /* best-effort teardown */
    }
  }
}
