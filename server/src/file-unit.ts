import { readUnitStatement } from './code-editor.ts';
import { parseProjectUnit, type LengthUnit } from './project-config.ts';

/** The suffixes a FluidCAD script can carry (mirrors lib SCRIPT_SUFFIXES). */
export const SCRIPT_SUFFIXES = ['.fluid.js', '.part.js', '.assembly.js'];

/** Whether a path names a FluidCAD script — the only files that can declare a unit. */
export function isScriptPath(filePath: string): boolean {
  return SCRIPT_SUFFIXES.some(suffix => filePath.endsWith(suffix));
}

/**
 * A file's declared unit, read statically from its `unit('…')` statement —
 * no execution, so it works for files that don't evaluate (a broken import,
 * an engine that predates units) and from engine-free paths like `pack`.
 * Null when the file declares none, or declares something that isn't a
 * length unit (the lint reports that; readers fall back to the project
 * unit, which is what the runtime does for an undeclared file).
 */
export async function readDeclaredUnit(code: string): Promise<LengthUnit | null> {
  const statement = await readUnitStatement(code);
  if (!statement) {
    return null;
  }
  return parseProjectUnit(statement.unit);
}
