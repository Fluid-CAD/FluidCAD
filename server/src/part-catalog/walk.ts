import { join } from 'path';
import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { WorkspaceFiles } from '../files/workspace-files.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import type { LengthUnit } from '../project-config.ts';
import { PackageOffers, type PackageRef } from '../packages/package-offers.ts';

/** Matches any `part(` call — the cheap text prefilter before evaluating. */
const PART_CALL = /\bpart\s*\(/;

/** Matches any export declaration — the prefilter for `.assembly.js` files. */
const EXPORT_DECL = /\bexport\b/;

export type CatalogFileEntry = {
  /** Workspace-relative path, for display; a package's file reads `@scope/name/<module>`. */
  path: string;
  absPath: string;
  /**
   * The unit the file's parts are authored in: its `unit()` statement (read
   * statically — nothing is evaluated here), else the project unit. The
   * scan's runtime answer supersedes this once it lands; this one lets the
   * Insert dialog badge a foreign-unit file before then.
   */
  unit: LengthUnit;
  /**
   * The installed package the file belongs to, and whether the project
   * pins it (`dependency`) or it is a library offer (`library`, K7) —
   * inserting a part from one pins the package first. Absent for the
   * workspace's own files.
   */
  package?: PackageRef;
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
  const relFiles = await WorkspaceFiles.collect(workspacePath);
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

/**
 * The installed packages' part files the Insert dialog lists beside the
 * workspace's (research §5): every module holding a part or assembly the
 * package exports, of each package the project's catalogs offer
 * ({@link PackageOffers}: the pinned ones, then the library's newest
 * unpinned ones). Read from the manifests — nothing is evaluated until the
 * dialog scans a file — and each file is in the package's unit (its own
 * `unit()`, else the package's). A package this engine can't use is left
 * out: its parts would not render.
 */
export class PackagePartFiles {
  static list(workspacePath: string): CatalogFileEntry[] {
    const out: CatalogFileEntry[] = [];
    for (const offer of PackageOffers.of(workspacePath || null)) {
      if (offer.problem !== undefined) {
        continue;
      }
      const modules = [...new Set(offer.manifest.parts.map((entry) => entry.module))];
      for (const module of modules) {
        out.push({
          path: `${offer.name}/${module}`,
          absPath: normalizePath(join(offer.directory, module)),
          unit: offer.manifest.fileUnits?.[module] ?? offer.manifest.unit ?? 'mm',
          package: { name: offer.name, version: offer.version, availability: offer.availability },
        });
      }
    }
    return out;
  }
}
