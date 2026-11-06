import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { ModuleSpecifiers } from '../files/module-specifiers.ts';
import { normalizePath } from '../normalize-path.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';
import {
  DEFAULT_CONFIGURATION_NAME,
  findInvalidParam,
  type InsertParamValue,
  type InsertPartEntry,
  type InsertPartKind,
} from './insert-edit.ts';

/** One export the page asks to insert, as `POST /api/part-catalog/insert` carries it. */
export type InsertRequestEntry = {
  /** The module that exports it, absolute: a workspace file or an installed package's. */
  file: string;
  exportName: string;
  kind: InsertPartKind;
  /**
   * The values the statement passes. A `param()` definition's by label; a
   * generated definition's (`definePart`, `defineAssembly`) by id — the
   * same object, written the same way (`insert(gearPart, { teeth: 18 })`).
   */
  params?: Record<string, InsertParamValue>;
  /** A row of the definition's `configurations()` table; `'Default'` writes none. A generated definition has none. */
  configuration?: string;
};

/** A new variable an expression value introduced (`width = 600`), declared with the edit. */
export type NewVariable = { name: string; initializer: string };

/** The edit that inserts a basket of exports, and the library packages it needs pinned. */
export type InsertPlan = {
  /** The `insertPart` edit for the assembly file — what the writer dispatches and a preview applies in memory. */
  spec: ApplyFeatureEditSpec;
  /**
   * Each installed package a part comes from, by name. A library package
   * (K7) must be pinned before the written statement can import it
   * (`PackageAdoption.adoptForUse`); a package the project pins already
   * needs nothing (adoption is a no-op for it).
   */
  adoptions: PackageLocation[];
};

/**
 * The Insert dialog's request, read and planned: the one place that turns
 * what the page posts into the `insertPart` edit (`applyInsertPartEdit`,
 * insert-edit.ts) — so the route that writes it and an in-memory preview
 * of it compute the same code.
 *
 * The rules:
 * - Every entry names an importable export (`IDENTIFIER`), a kind the
 *   writer knows, values that render as literals (`findInvalidParam`) and,
 *   when given, a non-empty configuration name. One bad entry refuses the
 *   whole basket.
 * - Each export is imported by the specifier that reaches it from the
 *   assembly file (`ModuleSpecifiers`): a relative path for a workspace
 *   module, the package's bare name for an installed package's (only for a
 *   name its entry exports), nothing for the assembly file's own export.
 *   One that can't be reached refuses the basket with the reason.
 * - Values are written as given, keyed as given: by label for a `param()`
 *   definition, by id for a generated one. `'Default'` names no row.
 */
export class CatalogInsertRequest {
  /** What an export name must be to be imported and referenced. */
  static readonly IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  private static readonly KINDS: readonly InsertPartKind[] = ['value', 'factory', 'assembly'];

  /** The request body's basket and new variables, checked; null for a malformed body. */
  static parse(body: unknown): { inserts: InsertRequestEntry[]; newVariables?: NewVariable[] } | null {
    const { inserts, newVariables } = (body ?? {}) as { inserts?: unknown; newVariables?: unknown };
    if (!Array.isArray(inserts) || inserts.length === 0) {
      return null;
    }
    if (newVariables !== undefined && !CatalogInsertRequest.isNewVariables(newVariables)) {
      return null;
    }
    if (!inserts.every(entry => CatalogInsertRequest.isEntry(entry))) {
      return null;
    }
    return {
      inserts: inserts as InsertRequestEntry[],
      ...(newVariables !== undefined ? { newVariables: newVariables as NewVariable[] } : {}),
    };
  }

  /**
   * Plan the edit that inserts `entries` into `assemblyFile`, importing
   * each by the specifier that reaches it from there; or the reason one
   * can't be imported. `workspacePath` is the project (empty: no packages,
   * relative imports only).
   */
  static plan(
    assemblyFile: string,
    entries: readonly InsertRequestEntry[],
    workspacePath: string,
    newVariables?: NewVariable[],
  ): InsertPlan | { reason: string } {
    const assemblyAbs = normalizePath(assemblyFile);
    // One answer per request for which specifier reaches each part: a
    // relative path, or the package's bare name (only for a name its entry
    // exports, at the version the project pins, if it pins one).
    const specifiers = workspacePath ? new ModuleSpecifiers(workspacePath) : ModuleSpecifiers.LOCAL;
    const inserts: InsertPartEntry[] = [];
    const adoptions = new Map<string, PackageLocation>();
    for (const entry of entries) {
      const partAbs = normalizePath(entry.file);
      let importFrom: string | null = null;
      if (partAbs !== assemblyAbs) {
        importFrom = specifiers.specifierFor(assemblyFile, partAbs, entry.exportName);
        if (importFrom === null) {
          return { reason: specifiers.unreachableReason(partAbs, entry.exportName) ?? `${entry.exportName} can't be imported here.` };
        }
      }
      const owner = workspacePath ? PackageRoots.owner(partAbs, workspacePath) : null;
      if (owner) {
        adoptions.set(owner.name, owner);
      }
      inserts.push({
        importFrom,
        exportName: entry.exportName,
        kind: entry.kind,
        ...(entry.params && Object.keys(entry.params).length > 0 ? { params: entry.params } : {}),
        ...(typeof entry.configuration === 'string' && entry.configuration !== DEFAULT_CONFIGURATION_NAME
          ? { configuration: entry.configuration }
          : {}),
      });
    }
    const spec: ApplyFeatureEditSpec = {
      // Placeholder feature, exactly as paramEdit rides the round trip: the
      // insertPart side-channel supersedes every other field.
      feature: 'sketch',
      filePath: assemblyFile,
      producers: [],
      parts: [],
      imports: [],
      ...(newVariables !== undefined ? { newVariables } : {}),
      insertPart: { inserts },
    };
    return { spec, adoptions: [...adoptions.values()] };
  }

  private static isEntry(entry: unknown): entry is InsertRequestEntry {
    const { file, exportName, kind, params, configuration } = (entry ?? {}) as Record<string, unknown>;
    return typeof file === 'string' && file.length > 0
      && typeof exportName === 'string' && CatalogInsertRequest.IDENTIFIER.test(exportName)
      && (CatalogInsertRequest.KINDS as readonly unknown[]).includes(kind)
      && findInvalidParam(params as Record<string, InsertParamValue> | undefined) === null
      && (configuration === undefined || (typeof configuration === 'string' && configuration.trim() !== ''));
  }

  /** `[{ name, initializer }]`, both strings. */
  static isNewVariables(value: unknown): value is NewVariable[] {
    return Array.isArray(value) && value.every(nv => nv !== null && typeof nv === 'object'
      && typeof (nv as NewVariable).name === 'string'
      && typeof (nv as NewVariable).initializer === 'string');
  }
}
