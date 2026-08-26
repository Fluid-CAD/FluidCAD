/**
 * Which files the engine renders as models. Mirror of `server/src/file-kind.ts`
 * (and the VS Code extension's copy) — the shell can't import across the
 * package boundary, and the rule is three suffixes.
 */

const SUFFIXES = ['.part.js', '.assembly.js', '.fluid.js'];

/** A part-design file, an assembly driver, or the legacy `.fluid.js` part. */
export function isFluidScriptFile(name: string): boolean {
  return SUFFIXES.some((suffix) => name.endsWith(suffix));
}
