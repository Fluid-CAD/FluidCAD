import type { AssemblyPreviewBody, InsertValue, NewVariable, PreviewDetail, PreviewWriterRequest } from '../../api';

/** What a dialog asks to preview, before its token and detail: a create of a definition, or a values edit of an insert. */
export type PreviewEdit =
  | {
    mode: 'create';
    filePath: string;
    definition: { file: string; exportName: string };
    values: Record<string, InsertValue>;
    newVariables?: NewVariable[];
  }
  | {
    mode: 'edit';
    filePath: string;
    line: number;
    /** The changed values, by id (the writer's `set`). */
    values: Record<string, InsertValue>;
    /** The ids reset to their defaults. */
    unset: string[];
    /** The occurrence's (or instance's) id: the server refuses an engine-owned row (G8). */
    row?: string;
    newVariables?: NewVariable[];
  };

/**
 * A dialog's preview request and its Apply, from one description of the
 * edit, so the two never drift: the preview renders what Apply writes
 * (`POST /api/assembly-preview` plans its edit from exactly the writer
 * request Apply posts — server `AssemblyPreviewRequest.writerRequest`,
 * which {@link writerOf} mirrors).
 */
export class PreviewRequests {
  /** The preview request for `edit`, under `token`, at `detail`. */
  static body(edit: PreviewEdit, token: string, detail: PreviewDetail): AssemblyPreviewBody {
    const common = {
      token,
      filePath: edit.filePath,
      detail,
      values: edit.values,
      ...(edit.newVariables && edit.newVariables.length > 0 ? { newVariables: edit.newVariables } : {}),
    };
    if (edit.mode === 'create') {
      return { ...common, mode: 'create', definition: edit.definition };
    }
    return {
      ...common,
      mode: 'edit',
      line: edit.line,
      ...(edit.unset.length > 0 ? { unset: edit.unset } : {}),
      ...(edit.row ? { row: edit.row } : {}),
    };
  }

  /**
   * The writer request Apply posts for `edit`: create → `POST
   * /api/part-catalog/insert` with the one insert; edit → `POST
   * /api/update-insert-params` with `set` / `unset` (and `row`).
   */
  static writerOf(edit: PreviewEdit): PreviewWriterRequest {
    const newVariables = edit.newVariables && edit.newVariables.length > 0 ? { newVariables: edit.newVariables } : {};
    if (edit.mode === 'create') {
      return {
        route: 'part-catalog/insert',
        body: {
          inserts: [{
            file: edit.definition.file,
            exportName: edit.definition.exportName,
            kind: 'value',
            ...(Object.keys(edit.values).length > 0 ? { params: edit.values } : {}),
          }],
          ...newVariables,
        },
      };
    }
    return {
      route: 'update-insert-params',
      body: {
        filePath: edit.filePath,
        sourceLine: edit.line,
        set: edit.values,
        unset: edit.unset,
        ...newVariables,
        ...(edit.row ? { row: edit.row } : {}),
      },
    };
  }

  /** Whether an edit changes nothing (an edit with no value and nothing unset). */
  static isNoChange(edit: PreviewEdit): boolean {
    return edit.mode === 'edit' && Object.keys(edit.values).length === 0 && edit.unset.length === 0;
  }

  /** The edit's identity, detail aside: two requests with one key render the same code. */
  static keyOf(edit: PreviewEdit): string {
    return PreviewRequests.canonical(edit);
  }

  private static canonical(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(each => PreviewRequests.canonical(each)).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, each]) => each !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${PreviewRequests.canonical(each)}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }
}
