// AssemblyPreviewRequest: what a preview asks for, and the writer request its Apply posts.

import type { ApplyFeatureEditSpec } from '../apply-feature-edit/index.ts';
import { InsertParamsRequest } from '../insert-params-edit.ts';
import { CatalogInsertRequest, type NewVariable } from '../part-catalog/insert-request.ts';
import type { InsertParamValue } from '../part-catalog/insert-edit.ts';
import type { PackageLocation } from '../packages/package-roots.ts';
import type { DispatchRefusal } from '../edit-dispatch.ts';

/** The tier a preview's generated parts build at: `'preview'` while a control moves, `'full'` once it settles. */
export type PreviewDetail = 'preview' | 'full';

/** What every preview request carries. */
type PreviewCommon = {
  /** The preview (one dialog session); a request with another token supersedes it. */
  token: string;
  /** The assembly file the edit is for: the file on screen. */
  filePath: string;
  detail: PreviewDetail;
  /** Declarations an expression value introduced (`width = 600`), written with the edit. */
  newVariables?: NewVariable[];
};

/**
 * `POST /api/assembly-preview`, read. `create` previews inserting a
 * definition with `values` (by id); `edit` previews merging `values` into
 * the `insert()` at `line` and resetting `unset` to their defaults.
 */
export type AssemblyPreviewBody =
  | PreviewCommon & {
    mode: 'create';
    /** The definition to insert: its module (a workspace file or an installed package's) and export. */
    definition: { file: string; exportName: string };
    values: Record<string, InsertParamValue>;
  }
  | PreviewCommon & {
    mode: 'edit';
    /** The `insert()` statement's 1-based line in the file's current code. */
    line: number;
    /** The values that change, by id. */
    values: Record<string, InsertParamValue>;
    /** Ids reset to their defaults (taken out of the statement). */
    unset?: string[];
    /** The assembly-view row the edit comes from (the occurrence's id), checked like the writer checks it (G8). */
    row?: string;
  };

/** The request a preview's Apply posts: the writer's route and body (`POST /api/<route>`). */
export type PreviewWriterRequest = {
  route: 'part-catalog/insert' | 'update-insert-params';
  body: Record<string, unknown>;
};

/** A preview's edit, planned: the writer's spec (null: no change at all), and the library packages it needs pinned. */
export type PreviewEditPlan = { spec: ApplyFeatureEditSpec | null; adoptions: PackageLocation[] };

/**
 * An assembly preview's request (G4), read, and the **one** way it becomes
 * an edit: as the very request its Apply posts to the writer
 * ({@link writerRequest}), read by the writer's own parser and planned by
 * the writer's own planner — `CatalogInsertRequest` for a create (the
 * Insert dialog's `POST /api/part-catalog/insert`), `InsertParamsRequest`
 * for an edit (`POST /api/update-insert-params`). So the code a preview
 * renders is the code Apply writes, character for character.
 *
 * The rules:
 * - `token`: 1–128 of `A–Z a–z 0–9 _ . : -` (a UUID fits).
 * - `detail`: `'preview'` or `'full'`; absent means `'full'`.
 * - `values`: a plain object of literal values (or `{ expr }`), by id.
 * - create: `definition.file` and an importable `definition.exportName`; a
 *   generated definition is inserted as an exported value (`kind: 'value'`).
 * - edit: a whole `line` ≥ 1; `unset` a list of ids; `row` a string. No
 *   change at all (no value, nothing unset) previews the code as it is.
 */
export class AssemblyPreviewRequest {
  static readonly TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

  private static readonly DETAILS: readonly PreviewDetail[] = ['preview', 'full'];

  /** The body, checked; null when malformed. */
  static parse(body: unknown): AssemblyPreviewBody | null {
    const raw = (body ?? {}) as Record<string, unknown>;
    const { token, mode, filePath, detail, values, newVariables } = raw;
    if (typeof token !== 'string' || !AssemblyPreviewRequest.TOKEN.test(token)
      || typeof filePath !== 'string' || filePath === ''
      || (detail !== undefined && !(AssemblyPreviewRequest.DETAILS as readonly unknown[]).includes(detail))
      || values === null || typeof values !== 'object' || Array.isArray(values)
      || (newVariables !== undefined && !CatalogInsertRequest.isNewVariables(newVariables))) {
      return null;
    }
    const common: PreviewCommon = {
      token,
      filePath,
      detail: (detail as PreviewDetail | undefined) ?? 'full',
      ...(newVariables !== undefined ? { newVariables: newVariables as NewVariable[] } : {}),
    };
    if (mode === 'create') {
      const definition = raw.definition as { file?: unknown; exportName?: unknown } | null | undefined;
      if (!definition || typeof definition.file !== 'string' || definition.file === ''
        || typeof definition.exportName !== 'string' || !CatalogInsertRequest.IDENTIFIER.test(definition.exportName)) {
        return null;
      }
      return {
        ...common,
        mode,
        definition: { file: definition.file, exportName: definition.exportName },
        values: values as Record<string, InsertParamValue>,
      };
    }
    if (mode === 'edit') {
      const { line, unset, row } = raw;
      if (!Number.isInteger(line) || (line as number) < 1
        || (unset !== undefined && (!Array.isArray(unset) || !unset.every(id => typeof id === 'string' && id !== '')))
        || (row !== undefined && typeof row !== 'string')) {
        return null;
      }
      return {
        ...common,
        mode,
        line: line as number,
        values: values as Record<string, InsertParamValue>,
        ...(Array.isArray(unset) && unset.length > 0 ? { unset: unset as string[] } : {}),
        ...(typeof row === 'string' && row !== '' ? { row } : {}),
      };
    }
    return null;
  }

  /**
   * The request the preview's Apply posts — exactly the edit the preview
   * renders. What S6's Apply sends, and what {@link plan} reads back
   * through the writer's own parser.
   */
  static writerRequest(request: AssemblyPreviewBody): PreviewWriterRequest {
    if (request.mode === 'create') {
      return {
        route: 'part-catalog/insert',
        body: {
          inserts: [{
            file: request.definition.file,
            exportName: request.definition.exportName,
            kind: 'value',
            ...(Object.keys(request.values).length > 0 ? { params: request.values } : {}),
          }],
          ...(request.newVariables ? { newVariables: request.newVariables } : {}),
        },
      };
    }
    return {
      route: 'update-insert-params',
      body: {
        filePath: request.filePath,
        sourceLine: request.line,
        set: request.values,
        unset: request.unset ?? [],
        ...(request.newVariables ? { newVariables: request.newVariables } : {}),
        ...(request.row ? { row: request.row } : {}),
      },
    };
  }

  /**
   * The edit `request` previews in `currentFile`, planned by the writer's
   * planner from {@link writerRequest}; or why the writer would refuse it,
   * answered as it would answer.
   */
  static plan(request: AssemblyPreviewBody, currentFile: string, workspacePath: string): PreviewEditPlan | DispatchRefusal {
    const writer = AssemblyPreviewRequest.writerRequest(request);
    if (request.mode === 'create') {
      const parsed = CatalogInsertRequest.parse(writer.body);
      if (!parsed) {
        return { status: 400, reason: 'Invalid request body' };
      }
      const plan = CatalogInsertRequest.plan(currentFile, parsed.inserts, workspacePath, parsed.newVariables);
      if ('reason' in plan) {
        return { status: 422, reason: plan.reason };
      }
      return { spec: plan.spec, adoptions: plan.adoptions };
    }
    if (Object.keys(request.values).length === 0 && (request.unset ?? []).length === 0) {
      return { spec: null, adoptions: [] };
    }
    const parsed = InsertParamsRequest.parse(writer.body);
    if (!parsed) {
      return { status: 400, reason: 'Invalid request body' };
    }
    return { spec: InsertParamsRequest.spec({ ...parsed, filePath: currentFile }), adoptions: [] };
  }
}
