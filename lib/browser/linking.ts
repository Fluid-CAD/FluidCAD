import * as fluidcadRoot from "../index.js";
import * as core from "../core/index.js";
import * as filters from "../filters/index.js";
import * as constraints from "../core/constraints/index.js";
import * as shapes from "../core/shapes/index.js";
import * as math from "../math/index.js";

/**
 * The engine's public module namespaces, keyed by the import specifiers user
 * models write. Must mirror the root package.json `exports` map — a model
 * compiled in the browser can only reach what the desktop resolver would
 * have offered it.
 */
const ENGINE_NAMESPACES: Record<string, Record<string, unknown>> = {
  "fluidcad": fluidcadRoot as unknown as Record<string, unknown>,
  "fluidcad/core": core as unknown as Record<string, unknown>,
  "fluidcad/filters": filters as unknown as Record<string, unknown>,
  "fluidcad/constraints": constraints as unknown as Record<string, unknown>,
  "fluidcad/shapes": shapes as unknown as Record<string, unknown>,
  "fluidcad/math": math as unknown as Record<string, unknown>,
};

export const ENGINE_NAMESPACE_SPECIFIERS = Object.keys(ENGINE_NAMESPACES);

/**
 * Expose the live namespaces on globalThis for the shim modules produced by
 * `engineShimModuleSource`. Import maps don't work in workers and a blob
 * module's source is inert text — globalThis is the only bridge back to this
 * bundle's single engine instance (two lib instances would mean two scene
 * managers and a broken registry).
 */
export function installEngineNamespaces(): void {
  (globalThis as { __fluidcad?: unknown }).__fluidcad = ENGINE_NAMESPACES;
}

/**
 * Source text of a module that re-exports one engine namespace from
 * globalThis. The in-browser bundler resolves each bare `fluidcad/*` import
 * in model code to one of these instead of bundling a second lib copy.
 */
export function engineShimModuleSource(specifier: string): string {
  const ns = ENGINE_NAMESPACES[specifier];
  if (!ns) {
    throw new Error(`Unknown fluidcad subpath: ${specifier}`);
  }
  const lines: string[] = [];
  for (const name of Object.keys(ns)) {
    if (name === "default") {
      lines.push(`export default globalThis.__fluidcad[${JSON.stringify(specifier)}].default;`);
    } else {
      lines.push(`export const ${name} = globalThis.__fluidcad[${JSON.stringify(specifier)}][${JSON.stringify(name)}];`);
    }
  }
  return lines.join("\n") + "\n";
}
