// Which file a script frame names, against a render's entry document. Imports
// `fs` directly like lib/project-unit.ts: the browser bundle stubs the module
// (with no realpathSync), and the comparison falls back to the spelling.

import * as fs from "fs";

/**
 * A render's entry file, matched against the file a `part()` call (or any
 * captured statement) recorded. Two spellings name one file when they are
 * equal once normalized — no `virtual:live-render:` prefix (a live editor
 * buffer), forward slashes, an uppercase drive letter — or, in Node, when
 * they resolve to the same real path: a workspace opened through a
 * symlinked directory hands the host the link's spelling of the entry,
 * while Vite names the modules it loads by their real path (macOS's
 * `/var` → `/private/var` is one such link). A path that does not exist
 * (an unsaved buffer) keeps its spelling. Real paths are resolved once per
 * file per instance — one instance serves one render pass.
 */
export class EntryFile {
  private readonly spellings: Set<string>;
  private readonly verdicts = new Map<string, boolean>();

  constructor(entryFile: string) {
    const normalized = EntryFile.normalize(entryFile);
    this.spellings = new Set([normalized, EntryFile.real(normalized)]);
  }

  /** Whether `filePath` names the entry file. */
  matches(filePath: string): boolean {
    const known = this.verdicts.get(filePath);
    if (known !== undefined) {
      return known;
    }
    const normalized = EntryFile.normalize(filePath);
    const verdict = this.spellings.has(normalized) || this.spellings.has(EntryFile.real(normalized));
    this.verdicts.set(filePath, verdict);
    return verdict;
  }

  /** One spelling per file, without touching the file system. */
  static normalize(path: string): string {
    const virtualPrefix = 'virtual:live-render:';
    const virtualIdx = path.lastIndexOf(virtualPrefix);
    let normalized = virtualIdx === -1 ? path : path.slice(virtualIdx + virtualPrefix.length);
    normalized = normalized.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
      normalized = normalized[0].toUpperCase() + normalized.slice(1);
    }
    return normalized;
  }

  /** The file's real path, normalized; the path itself without Node or when it does not resolve. */
  private static real(path: string): string {
    if (typeof process === "undefined" || typeof fs.realpathSync !== "function") {
      return path;
    }
    try {
      return EntryFile.normalize(fs.realpathSync(path));
    } catch {
      return path;
    }
  }
}
