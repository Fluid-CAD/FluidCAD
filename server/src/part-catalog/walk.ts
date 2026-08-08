import { join } from 'path';
import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { collectWorkspaceFiles } from '../model-package/pack.ts';

/** The suffixes a FluidCAD script can carry (mirrors lib SCRIPT_SUFFIXES). */
const SCRIPT_SUFFIXES = ['.fluid.js', '.part.js', '.assembly.js'];

/** Matches any `part(` call — the cheap text prefilter before evaluating. */
const PART_CALL = /\bpart\s*\(/;

export type CatalogFileEntry = {
  /** Workspace-relative path, for display. */
  path: string;
  absPath: string;
};

/**
 * The workspace's part-candidate files: every FluidCAD script (gitignore
 * honored, node_modules/dot-dirs pruned) whose content mentions `part(`.
 * The prefilter keeps the Insert dialog from evaluating files that cannot
 * contain parts; `readContent` lets the caller serve live editor buffers so
 * an unsaved `part(...)` still qualifies.
 */
export async function listCandidateFiles(
  workspacePath: string,
  readContent?: (absPath: string) => string | null,
): Promise<CatalogFileEntry[]> {
  const relFiles = await collectWorkspaceFiles(workspacePath);
  const out: CatalogFileEntry[] = [];
  for (const rel of relFiles) {
    if (!SCRIPT_SUFFIXES.some(s => rel.endsWith(s))) {
      continue;
    }
    const absPath = normalizePath(join(workspacePath, rel));
    let content = readContent?.(absPath) ?? null;
    if (content === null) {
      try {
        content = await readFile(absPath, 'utf8');
      } catch {
        continue;
      }
    }
    if (PART_CALL.test(content)) {
      out.push({ path: rel, absPath });
    }
  }
  return out;
}
