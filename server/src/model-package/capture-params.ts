import { InProcessEngine } from '../packages/in-process-engine.ts';
import type { ParamDefinition } from '../../../lib/dist/index.js';
import type { ModelPackageConfigurations } from './types.ts';

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
 * Side-effect-free at import time — it boots its own {@link InProcessEngine}
 * (OC wasm + a Vite SSR pipeline) and closes it before returning so a
 * one-shot CLI process can exit. Import this (or use `fluidcad/server/api`),
 * NOT `fluidcad/server`, which boots the desktop binary.
 */
export async function captureParamDefinitions(
  entryPath: string,
  workspacePath: string,
): Promise<ParamDefinition[]> {
  return InProcessEngine.run(workspacePath, async (engine) => {
    const rendered = await engine.server.processFile(entryPath);
    if (!rendered) {
      throw new Error(
        'The engine did not initialize — is there an init.js at the workspace root? ' +
          'Run `fluidcad init` to scaffold one.',
      );
    }
    return rendered.params ?? [];
  });
}
