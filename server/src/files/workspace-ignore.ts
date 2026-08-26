import fs from 'fs';
import path from 'path';
import ignoreFactory, { type Ignore } from 'ignore';

/**
 * Which workspace paths the editor should never see. Two layers:
 *
 * - **Always skipped**, regardless of what git thinks: `node_modules` (huge,
 *   never edited), `.git`, and `.fluidcad` (this tool's own state directory).
 * - **`.gitignore`**, honoured per directory the way git does it — a nested
 *   `.gitignore` applies to its own subtree only.
 *
 * Shared by the tree walk and the file watcher so the page's file list and the
 * change events it receives describe the same set of files
 * (`feedback_reusable_helpers`).
 */

const ALWAYS_IGNORED = new Set(['node_modules', '.git', '.fluidcad']);

// `ignore`'s CJS default export isn't callable under this repo's ESM typings —
// the same cast `model-package/pack.ts` uses.
const ignore = ignoreFactory as unknown as (options?: object) => Ignore;

export interface WorkspaceIgnore {
  /** @param relPath workspace-relative, forward slashes. */
  isIgnored(relPath: string, isDirectory: boolean): boolean;
  /** Drop cached `.gitignore` contents — call when one of them changes. */
  reset(): void;
}

export function createWorkspaceIgnore(workspacePath: string): WorkspaceIgnore {
  // dirRel ('' for the root) → its own .gitignore matcher, or null if it has none.
  let matchers = new Map<string, Ignore | null>();

  function matcherFor(dirRel: string): Ignore | null {
    if (!matchers.has(dirRel)) {
      let matcher: Ignore | null = null;
      try {
        const raw = fs.readFileSync(path.join(workspacePath, dirRel, '.gitignore'), 'utf8');
        matcher = ignore().add(raw);
      } catch {
        matcher = null; // No .gitignore here — the common case.
      }
      matchers.set(dirRel, matcher);
    }
    return matchers.get(dirRel) ?? null;
  }

  return {
    isIgnored(relPath, isDirectory) {
      const parts = relPath.split('/').filter((part) => part !== '' && part !== '.');
      if (parts.length === 0) {
        return false;
      }
      if (parts.some((part) => ALWAYS_IGNORED.has(part))) {
        return true;
      }
      for (let i = 0; i < parts.length; i++) {
        const matcher = matcherFor(parts.slice(0, i).join('/'));
        if (!matcher) {
          continue;
        }
        const subject = parts.slice(i).join('/');
        if (matcher.ignores(isDirectory ? `${subject}/` : subject)) {
          return true;
        }
      }
      return false;
    },

    reset() {
      matchers = new Map();
    },
  };
}
