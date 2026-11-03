import { join } from 'path';
import { readFile } from 'fs/promises';
import { normalizePath } from '../normalize-path.ts';
import { WorkspaceFiles } from '../files/workspace-files.ts';
import { isScriptPath, readDeclaredUnit } from '../file-unit.ts';
import type { LengthUnit } from '../project-config.ts';
import { PackageOffers, type PackageRef } from '../packages/package-offers.ts';

/** Matches any `part(` or `definePart(` call — the cheap text prefilter before evaluating. */
const PART_CALL = /\b(?:part|definePart)\s*\(/;

/** Matches any export declaration — the prefilter for `.assembly.js` files. */
const EXPORT_DECL = /\bexport\b/;

/** Matches a `definePart(` or `defineAssembly(` call — the prefilter for files that may define generated parts or assemblies. */
const GENERATED_CALL = /\b(?:definePart|defineAssembly)\s*\(/;

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
 * part-kind file mentioning `part(` or `definePart(`, or an `.assembly.js`
 * file declaring exports (exported factories and `defineAssembly`
 * definitions are potential sub-assemblies; a root assembly like
 * `index.assembly.js` exports nothing and is skipped). The prefilter
 * keeps the Insert dialog from evaluating files that cannot qualify;
 * `readContent` lets the caller serve live editor buffers so an unsaved
 * edit still counts. `generatedOnly` narrows the list to the files that
 * call `definePart(` or `defineAssembly(` — the only ones that can define
 * a generated part or assembly (the assembly toolbar's Custom dropdown).
 */
export async function listCandidateFiles(
  workspacePath: string,
  readContent?: (absPath: string) => string | null,
  projectUnit: LengthUnit = 'mm',
  options: { generatedOnly?: boolean } = {},
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
    if (qualifies && (!options.generatedOnly || GENERATED_CALL.test(content))) {
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
  /**
   * `generatedOnly` keeps the modules whose manifest entries include a
   * generated definition (`definitionKind: 'generated'`) — what the
   * assembly toolbar's Custom dropdown lists.
   */
  static list(workspacePath: string, options: { generatedOnly?: boolean } = {}): CatalogFileEntry[] {
    const out: CatalogFileEntry[] = [];
    for (const offer of PackageOffers.of(workspacePath || null)) {
      if (offer.problem !== undefined) {
        continue;
      }
      const entries = options.generatedOnly
        ? offer.manifest.parts.filter((entry) => entry.definitionKind === 'generated')
        : offer.manifest.parts;
      const modules = [...new Set(entries.map((entry) => entry.module))];
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
