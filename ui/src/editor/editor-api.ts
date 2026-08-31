/**
 * The editor's HTTP surface. Kept out of `ui/src/api.ts` (already ~3.6k lines
 * of modeling calls) so the editor stays one feature in one folder
 * (`feedback_split_files_for_organization`).
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export type FileKind = 'model' | 'source' | 'other';

export type WorkspaceFileEntry = {
  /** Workspace-relative, forward slashes. */
  path: string;
  absPath: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
};

export type FileContents = WorkspaceFileEntry & { content: string };

export type EngineTypeFile = { uri: string; content: string };

export type EngineSymbolEntry = { name: string; module: string };

export type EngineTypesPayload = {
  version: string;
  files: EngineTypeFile[];
  /** Symbol→module table for auto-import completions; absent on older servers. */
  symbols?: EngineSymbolEntry[];
  bytes: number;
};

/**
 * Every route here answers `{ error }` with a non-2xx on refusal — a traversal
 * attempt is a 403, a missing file a 404. Callers that can act on the reason
 * get it; the rest treat null as "couldn't".
 */
export class FileRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FileRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') {
        message = body.error;
      }
    } catch {
      // Non-JSON error body — the status line is all we have.
    }
    throw new FileRequestError(res.status, message);
  }
  return (await res.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function listWorkspaceFiles(): Promise<{ workspacePath: string; files: WorkspaceFileEntry[]; truncated: boolean }> {
  return request('/api/files/tree');
}

export function readWorkspaceFile(path: string): Promise<FileContents> {
  return request(`/api/files/read?path=${encodeURIComponent(path)}`);
}

export function writeWorkspaceFile(path: string, content: string): Promise<WorkspaceFileEntry> {
  return post('/api/files/write', { path, content });
}

/** Render this file as the current model — the scene follows. */
export function openWorkspaceFile(path: string): Promise<{ success: boolean; absPath: string }> {
  return post('/api/files/open', { path });
}

export function createWorkspaceFile(path: string, content = ''): Promise<WorkspaceFileEntry> {
  return post('/api/files/create', { path, content });
}

export function renameWorkspaceFile(path: string, newPath: string): Promise<WorkspaceFileEntry> {
  return post('/api/files/rename', { path, newPath });
}

export function deleteWorkspaceFile(path: string): Promise<{ success: boolean }> {
  return post('/api/files/delete', { path });
}

export type WorkspaceEditorState = {
  /** Open tab paths, workspace-relative, in strip order. */
  openTabs: string[];
  activeTab: string | null;
};

/**
 * Which files were open last time. Per-workspace rather than in global
 * preferences: it describes the project, not the window.
 */
export function fetchWorkspaceEditorState(): Promise<WorkspaceEditorState> {
  return request('/api/workspace/editor-state');
}

export function saveWorkspaceEditorState(state: WorkspaceEditorState): Promise<WorkspaceEditorState> {
  return post('/api/workspace/editor-state', state);
}

/** The running engine's `.d.ts` files, for the language service. */
export function fetchEngineTypes(): Promise<EngineTypesPayload> {
  return request('/api/engine/types');
}

/**
 * Settle a server-dispatched editor action. `apply-feature-edit` acks through
 * `POST /api/code/apply-feature` like every host; this is the channel for
 * `undo`/`redo`, which have no transform round-trip of their own, and for
 * `update-sketch-positions`, whose round-trip carries no editId.
 */
export function ackEdit(editId: string, error?: string): Promise<{ success: boolean }> {
  return post('/api/editor/ack', { editId, error });
}
