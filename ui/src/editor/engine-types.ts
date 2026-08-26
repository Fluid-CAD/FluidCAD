import { javascriptDefaults } from 'monaco-editor/languages/features/typescript/register.js';
import { fetchEngineTypes } from './editor-api';
import { registerAutoImports } from './auto-imports';

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
