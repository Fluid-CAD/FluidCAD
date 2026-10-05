import type { TimelineEntry, TimelineRow } from '../../../lib/dist/common/timeline.js';
import { CallSites } from '../code-editor/index.ts';
import { normalizePath } from '../normalize-path.ts';

type Snapshot = { rows: TimelineRow[]; sources: Map<string, string> };
type ReadSource = (path: string) => string | null;

/**
 * Per-session history of evaluated labels and structure. No engine objects or
 * shapes survive here. A pause keeps the last complete evaluation; a cold
 * pause has no history. Source text only relocates KNOWN rows, never discovers
 * features or evaluates their names.
 */
export class TimelineHistory {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly paused = new Map<string, TimelineEntry[]>();

  delete(session: string): void {
    this.snapshots.delete(session);
    this.setCurrent(session);
  }

  get(session: string): TimelineEntry[] | undefined {
    return this.paused.get(session);
  }

  /** Restore a cached render's display, or clear it for a new complete scene. */
  setCurrent(session: string, entries?: TimelineEntry[]): void {
    if (entries) this.paused.set(session, entries);
    else this.paused.delete(session);
  }

  sourceFiles(session: string): string[] {
    return [...(this.snapshots.get(session)?.sources.keys() ?? [])];
  }

  async update(session: string, result: readonly TimelineRow[], paused: boolean, read: ReadSource): Promise<TimelineEntry[] | undefined> {
    if (!paused) {
      const rows = result.map(TimelineHistory.metadata);
      const sources = new Map<string, string>();
      for (const row of rows) {
        const path = row.sourceLocation?.filePath;
        if (path && !sources.has(path)) {
          const code = read(path);
          if (code !== null) sources.set(path, code);
        }
      }
      this.snapshots.set(session, { rows, sources });
      this.setCurrent(session);
      return undefined;
    }
    const snapshot = this.snapshots.get(session);
    if (!snapshot) return undefined;
    // Freeze the reads before the parser's asynchronous initialization can
    // yield to another editor update.
    const currentSources = new Map([...snapshot.sources.keys()].map(path => [path, read(path)]));
    const relocated = new Map<string, { before: CallSites; after: CallSites; unchanged: boolean }>();
    for (const [path, code] of snapshot.sources) {
      const current = currentSources.get(path)!;
      if (current === null) continue;
      const before = await CallSites.parse(code);
      relocated.set(path, { before, after: current === code ? before : await CallSites.parse(current), unchanged: current === code });
    }
    const key = (row: TimelineRow, loc = row.sourceLocation): string | null => {
      if (!loc) return null;
      const path = TimelineHistory.path(loc.filePath);
      const site = relocated.get(path)?.after.at(loc);
      if (!site) return null;
      return JSON.stringify([path, site.line, site.column, loc.occurrence ?? 0, row.type, row.uniqueType]);
    };
    const bySource = new Map<string, number[]>();
    const byId = new Map(result.map((row, i) => [row.id, i]));
    result.forEach((row, i) => {
      const k = key(row);
      if (k) {
        const list = bySource.get(k) ?? [];
        list.push(i);
        bySource.set(k, list);
      }
    });
    const oldToLive = new Map<string, number>();
    const pending = new Map<string, TimelineRow>();
    for (const row of snapshot.rows) {
      let live = byId.get(row.id);
      const loc = row.sourceLocation;
      const file = loc && relocated.get(loc.filePath);
      const position = loc && file && (file.unchanged ? loc : file.before.relocate(loc, file.after));
      const nextLoc = position && loc ? { ...loc, ...position } : undefined;
      const k = nextLoc ? key(row, nextLoc) : null;
      const candidates = k ? bySource.get(k) : undefined;
      if (live === undefined && candidates?.length === 1) live = candidates[0];
      if (live !== undefined) {
        oldToLive.set(row.id, live);
      } else if (nextLoc && !candidates?.length) {
        pending.set(row.id, { ...row, sourceLocation: nextLoc });
      }
    }

    // A missing/deleted container cannot donate children to another scope.
    for (const row of snapshot.rows) {
      if (!pending.has(row.id) || !row.parentId) continue;
      const liveParent = oldToLive.get(row.parentId);
      if (liveParent !== undefined) pending.get(row.id)!.parentId = result[liveParent].id;
      else if (!pending.has(row.parentId)) pending.delete(row.id);
    }

    // Retain live sibling order. Historical siblings go before the next
    // surviving sibling, or at the scope's tail when the pause cut it off.
    const children = new Map<string | null, TimelineEntry[]>();
    const beforeLive = new Map<number, TimelineEntry[]>();
    const tails = new Map<string | null, TimelineEntry[]>();
    const nextSibling = new Map<string | null, number>();
    for (let i = snapshot.rows.length - 1; i >= 0; i--) {
      const old = snapshot.rows[i];
      const live = oldToLive.get(old.id);
      const row = pending.get(old.id);
      if (live !== undefined) {
        nextSibling.set(result[live].parentId ?? null, live);
      } else if (row) {
        const parent = row.parentId ?? null;
        const next = nextSibling.get(parent);
        const list = (next === undefined ? tails.get(parent) : beforeLive.get(next)) ?? [];
        list.push({ kind: 'unevaluated', row });
        if (next === undefined) tails.set(parent, list);
        else beforeLive.set(next, list);
      }
    }
    result.forEach((row, index) => {
      const parent = row.parentId ?? null;
      const list = children.get(parent) ?? [];
      for (const entry of beforeLive.get(index)?.reverse() ?? []) list.push(entry);
      list.push({ kind: 'evaluated', index });
      children.set(parent, list);
    });
    for (const [parent, tail] of tails) {
      const list = children.get(parent) ?? [];
      for (const entry of tail.reverse()) list.push(entry);
      children.set(parent, list);
    }
    const entries: TimelineEntry[] = [];
    const seen = new Set<string>();
    const visit = (parent: string | null) => {
      for (const entry of children.get(parent) ?? []) {
        const row = entry.kind === 'evaluated' ? result[entry.index] : entry.row;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        entries.push(entry);
        visit(row.id);
      }
    };
    visit(null);
    this.setCurrent(session, entries);
    return entries;
  }

  private static path(path: string): string {
    return normalizePath(path.replace('virtual:live-render:', ''));
  }

  private static metadata(row: TimelineRow): TimelineRow {
    const { id, parentId, name, type, uniqueType, isContainer, hideChildren, internal, sourceLocation } = row;
    return { id, parentId, name, type, uniqueType, isContainer, hideChildren, internal,
      ...(sourceLocation ? { sourceLocation: { ...sourceLocation, filePath: TimelineHistory.path(sourceLocation.filePath) } } : {}) };
  }
}
