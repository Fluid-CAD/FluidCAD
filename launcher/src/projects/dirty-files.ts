/**
 * Which of a project's editor buffers hold unsaved changes, asked of its
 * engine. The page reports them (`editor-dirty-state`) and
 * `GET /api/editor/dirty-files` lists them, on every engine a launcher runs.
 * Asked before anything tears a project's page down: the desktop app turns
 * the answer into a question for the user (`shell/src/window/unsaved-guard.ts`),
 * `npx fluidcad`, which has no dialog to show, refuses to close a project that
 * has any.
 */

export type DirtyFile = { path: string; lastModifiedMs: number };

export type DirtyProbe = { reachable: true; files: DirtyFile[] } | { reachable: false };

const PROBE_TIMEOUT_MS = 2_000;

/** Ask the engine at `engineUrl` which buffers are dirty. Any failure is "unreachable". */
export async function probeDirtyFiles(engineUrl: string | null): Promise<DirtyProbe> {
  if (!engineUrl) {
    return { reachable: false };
  }
  try {
    const response = await fetch(`${engineUrl}/api/editor/dirty-files`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      return { reachable: false };
    }
    const list: unknown = await response.json();
    if (!Array.isArray(list)) {
      return { reachable: false };
    }
    const files = list
      .filter((entry): entry is DirtyFile => typeof entry?.path === 'string')
      .map((entry) => ({ path: entry.path, lastModifiedMs: Number(entry.lastModifiedMs) || 0 }));
    return { reachable: true, files };
  } catch {
    return { reachable: false };
  }
}
