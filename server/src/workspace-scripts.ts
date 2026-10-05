// The model files of the workspace as the editor holds them — what a
// cross-file analysis reads when it has to know who else names something a
// file declares (a renamed param's readers, the assemblies mating on a part's
// connector).

import { readFile } from 'fs/promises';
import { join } from 'path';
import { collectWorkspaceFiles } from './model-package/pack.ts';
import { isScriptPath } from './file-unit.ts';
import { normalizePath } from './normalize-path.ts';

/** The slice of the server this reads: the rendered file, its text, and the host's other buffers. */
export type ScriptServer = {
  getCurrentFileName(): string;
  getCurrentCode(): string | null;
  getLiveBuffer?(filePath: string): string | null;
};

export class WorkspaceScripts {
  constructor(
    private readonly server: ScriptServer,
    private readonly workspacePath: string,
  ) {}

  /**
   * A model file's text as the editor holds it: the rendered file's live
   * text, another file's host buffer when there is one, else the disk.
   * Null when the file cannot be read.
   */
  async read(filePath: string): Promise<string | null> {
    const wanted = normalizePath(filePath);
    if (wanted === normalizePath(this.server.getCurrentFileName())) {
      return this.server.getCurrentCode();
    }
    const buffer = this.server.getLiveBuffer?.(wanted) ?? null;
    if (buffer !== null) {
      return buffer;
    }
    try {
      return await readFile(wanted, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Every readable workspace script other than `filePath`, with its text.
   * Empty when the server runs without a workspace.
   */
  async others(filePath: string): Promise<{ filePath: string; code: string }[]> {
    if (this.workspacePath === '') {
      return [];
    }
    const except = normalizePath(filePath);
    const out: { filePath: string; code: string }[] = [];
    for (const rel of await collectWorkspaceFiles(this.workspacePath)) {
      const other = normalizePath(join(this.workspacePath, rel));
      if (!isScriptPath(rel) || other === except) {
        continue;
      }
      const code = await this.read(other);
      if (code !== null) {
        out.push({ filePath: other, code });
      }
    }
    return out;
  }
}
