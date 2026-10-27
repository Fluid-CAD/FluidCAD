import { javascriptDefaults } from 'monaco-editor/languages/features/typescript/register.js';
import { fetchEngineTypes, fetchOcctTypes, fetchPackageTypes } from './editor-api';
import { registerAutoImports } from './auto-imports';
import { PackageTypes } from './package-types';

/**
 * Feed the running engine's own declarations to Monaco's TypeScript service.
 * This is what makes `extrude(` show a signature and `edge().onPlane(`
 * complete — and because the files come from the engine the server resolved,
 * the completions always describe the version this project is pinned to
 * rather than whatever the editor was built against.
 *
 * Loaded lazily, after the viewport has rendered: it is ~550 KB of `.d.ts`,
 * and the scene is the product (Invariant 7). Nothing about the editor blocks
 * first paint.
 */

let loading: Promise<void> | null = null;

export function loadEngineTypes(): Promise<void> {
  if (!loading) {
    loading = fetchEngineTypes()
      .then((payload) => {
        for (const file of payload.files) {
          javascriptDefaults.addExtraLib(file.content, file.uri);
        }
        registerAutoImports(payload.symbols);
        console.info(
          `FluidCAD: loaded ${payload.files.length} engine declarations ` +
          `(${Math.round(payload.bytes / 1024)} KB) for engine ${payload.version}`,
        );
      })
      .catch((err) => {
        // A page without engine types still edits and still renders — it just
        // completes worse. Never let this take the editor down with it.
        console.warn('FluidCAD: engine type declarations unavailable:', err);
      });
  }
  return loading;
}

/**
 * Add raw OpenCascade's declarations — the binding the engine runs on,
 * about 2 MB — to the language service. {@link OcctTypes} calls it the
 * first time a workspace file reaches raw OpenCascade.
 */
export async function loadOcctTypes(): Promise<void> {
  const started = performance.now();
  try {
    const payload = await fetchOcctTypes();
    for (const file of payload.files) {
      javascriptDefaults.addExtraLib(file.content, file.uri);
    }
    console.info(
      `FluidCAD: loaded the OpenCascade binding's declarations `
      + `(${Math.round(payload.bytes / 1024)} KB) in ${Math.round(performance.now() - started)} ms — a file reaches raw OpenCascade`,
    );
  } catch (err) {
    // Raw OpenCascade still builds; its calls just complete as `any`.
    console.warn('FluidCAD: the OpenCascade binding\'s declarations are unavailable:', err);
  }
}

/**
 * The pinned packages' sources (`@scope/name`), beside the engine's
 * declarations: {@link PackageTypes} registers them and follows the pins.
 */
export const packageTypes = new PackageTypes(
  (content, uri) => javascriptDefaults.addExtraLib(content, uri),
  fetchPackageTypes,
  // Setting the options, even to the same ones, restarts the TypeScript
  // worker (Monaco's WorkerManager stops it on any defaults change).
  () => javascriptDefaults.setCompilerOptions(javascriptDefaults.getCompilerOptions()),
);
