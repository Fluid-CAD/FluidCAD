import { isParamsFile } from '../file-kind.ts';
import type { WorkspaceFileEventType } from './workspace-watcher.ts';

/**
 * Keeps a `*.params.js` file's live buffer from masking the file once it is
 * edited on disk by something that is not an editor host — VS Code or any
 * other program saving it, a `git checkout`, an agent writing files.
 *
 * A params file's buffer is set by whoever last rendered it: a value written
 * from the Parameters column, the in-page editor. From then on the buffer is
 * what the catalog scans and what the module loader evaluates, over the
 * disk. Where nothing replaces it (the desktop app has no CLI watcher, and
 * the column edits a params file without ever opening it as an editor
 * model), a later save from outside left the column and the render on the
 * old text: a `group` or `description` typed into the file never showed
 * (GH #95).
 *
 * So a change on disk whose text differs from the buffer is rendered the way
 * the CLI watcher's live-update is — folded into the open model, which sets
 * the buffer and refreshes the catalog. The page's own save is not: it comes
 * back through the watcher too, and the page renders what it writes.
 */
export class ParamsDiskEdits {
  constructor(private readonly deps: {
    /** The live buffer held for a file, or null. */
    getBuffer: (absPath: string) => string | null;
    /** The file's text on disk, or null when it cannot be read. */
    readFile: (absPath: string) => Promise<string | null>;
    /** Whether `code` is what the page itself just wrote to the file. */
    isPageWrite: (absPath: string, code: string) => boolean;
    /** Fold the file's new text into the open model (`keepCurrent`). */
    render: (absPath: string, code: string) => Promise<unknown>;
  }) {}

  /**
   * A workspace file was added, changed or removed on disk. Resolves whether
   * its text was adopted over a buffer that no longer matched it.
   */
  async note(type: WorkspaceFileEventType, absPath: string): Promise<boolean> {
    if (type === 'file-removed' || !isParamsFile(absPath)) {
      return false;
    }
    if (this.deps.getBuffer(absPath) === null) {
      return false; // No buffer: every reader already reads the disk.
    }
    const code = await this.deps.readFile(absPath);
    // Compared after the read: a render may have set the buffer meanwhile.
    if (code === null || code === this.deps.getBuffer(absPath) || this.deps.isPageWrite(absPath, code)) {
      return false;
    }
    try {
      await this.deps.render(absPath, code);
    } catch (err: any) {
      console.warn(`FluidCAD: could not pick up the change to ${absPath}: ${err?.message ?? err}`);
    }
    return true;
  }
}
