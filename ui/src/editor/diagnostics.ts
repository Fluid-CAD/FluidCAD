import { monaco } from './monaco-setup';
import type { WorkspaceModels } from './models';
import type { SceneObjectRender } from '../types';

/**
 * Build failures as editor markers. Ported from
 * `extension/vscode/src/diagnostics.ts`; two sources, same as there:
 *
 * - the `compileError` on `scene-rendered` — the module didn't run at all,
 * - per-object `objectErrors` — the module ran and one feature failed to
 *   build, each carrying its own `sourceLocation`.
 *
 * Published under their own owner so they sit alongside the TypeScript
 * service's markers instead of replacing them: a `checkJs` squiggle and a
 * kernel build failure are different information and the user wants both.
 */

const OWNER = 'fluidcad';

export type CompileError = {
  message: string;
  filePath?: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export class Diagnostics {
  /** Models we last set markers on, so a clean render clears them all. */
  private marked = new Set<string>();

  constructor(private readonly models: WorkspaceModels) {}

  update(objects: SceneObjectRender[], compileError: CompileError | null): void {
    const byFile = new Map<string, monaco.editor.IMarkerData[]>();

    const add = (filePath: string, line: number, column: number, message: string) => {
      const list = byFile.get(filePath) ?? [];
      list.push({
        severity: monaco.MarkerSeverity.Error,
        message,
        source: 'FluidCAD',
        startLineNumber: Math.max(1, line),
        startColumn: Math.max(1, column),
        endLineNumber: Math.max(1, line),
        // To end of line — the failure belongs to the whole statement, and the
        // server reports where it starts, not how far it runs.
        endColumn: Number.MAX_SAFE_INTEGER,
      });
      byFile.set(filePath, list);
    };

    for (const object of objects) {
      if (object.hasError && object.errorMessage && object.sourceLocation) {
        const loc = object.sourceLocation;
        add(loc.filePath, loc.line, loc.column, object.errorMessage);
      }
    }

    if (compileError) {
      const loc = compileError.sourceLocation;
      const filePath = loc?.filePath ?? compileError.filePath;
      if (filePath) {
        add(filePath, loc?.line ?? 1, loc?.column ?? 1, compileError.message);
      }
    }

    // Clear first, so a file that just went clean loses its marker even
    // though nothing in this render mentions it.
    for (const absPath of this.marked) {
      const entry = this.models.get(absPath);
      if (entry && !byFile.has(absPath)) {
        monaco.editor.setModelMarkers(entry.model, OWNER, []);
      }
    }
    this.marked.clear();

    for (const [absPath, markers] of byFile) {
      const entry = this.models.get(absPath);
      if (entry) {
        monaco.editor.setModelMarkers(entry.model, OWNER, markers);
        this.marked.add(absPath);
      }
    }
  }

  /** The server went away — its verdicts are stale, so stop showing them. */
  clear(): void {
    for (const absPath of this.marked) {
      const entry = this.models.get(absPath);
      if (entry) {
        monaco.editor.setModelMarkers(entry.model, OWNER, []);
      }
    }
    this.marked.clear();
  }
}
