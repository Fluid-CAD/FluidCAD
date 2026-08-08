import { join } from 'path';
import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { collectWorkspaceFiles } from '../model-package/pack.ts';

/** The suffixes a FluidCAD script can carry (mirrors lib SCRIPT_SUFFIXES). */
const SCRIPT_SUFFIXES = ['.fluid.js', '.part.js', '.assembly.js'];

/** Matches any `part(` call — the cheap text prefilter before evaluating. */
const PART_CALL = /\bpart\s*\(/;

/** Matches any export declaration — the prefilter for `.assembly.js` files. */
const EXPORT_DECL = /\bexport\b/;

export type CatalogFileEntry = {
  /** Workspace-relative path, for display. */
  path: string;
  absPath: string;
};

/**
 * The workspace's candidate files: every FluidCAD script (gitignore honored,
 * node_modules/dot-dirs pruned) that can hold something insertable — a
 * part-kind file mentioning `part(`, or an `.assembly.js` file declaring
 * exports (exported factories are potential sub-assemblies; a root assembly
 * like `index.assembly.js` exports nothing and is skipped). The prefilter
 * keeps the Insert dialog from evaluating files that cannot qualify;
 * `readContent` lets the caller serve live editor buffers so an unsaved
 * edit still counts.
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
    // Assembly files: only exports are insertable, and a root assembly
    // (top-level inserts, no exports) would evaluate its whole document for
    // nothing — so exports alone qualify.
    const qualifies = rel.endsWith('.assembly.js')
      ? EXPORT_DECL.test(content)
      : PART_CALL.test(content);
    if (qualifies) {
      out.push({ path: rel, absPath });
    }
  }
  return out;
}
