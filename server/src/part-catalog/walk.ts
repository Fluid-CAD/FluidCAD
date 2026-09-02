import { join } from 'path';
import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { collectWorkspaceFiles } from '../model-package/pack.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import type { LengthUnit } from '../project-config.ts';

/** Matches any `part(` call — the cheap text prefilter before evaluating. */
const PART_CALL = /\bpart\s*\(/;

/** Matches any export declaration — the prefilter for `.assembly.js` files. */
const EXPORT_DECL = /\bexport\b/;

export type CatalogFileEntry = {
  /** Workspace-relative path, for display. */
  path: string;
  absPath: string;
  /**
   * The unit the file's parts are authored in: its `unit()` statement (read
   * statically — nothing is evaluated here), else the project unit. The
   * scan's runtime answer supersedes this once it lands; this one lets the
   * Insert dialog badge a foreign-unit file before then.
   */
  unit: LengthUnit;
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
  projectUnit: LengthUnit = 'mm',
): Promise<CatalogFileEntry[]> {
  const relFiles = await collectWorkspaceFiles(workspacePath);
  const out: CatalogFileEntry[] = [];
  for (const rel of relFiles) {
    if (!isScriptPath(rel)) {
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
      const unit = (await readDeclaredUnit(content)) ?? projectUnit;
      out.push({ path: rel, absPath, unit });
    }
  }
  return out;
}
