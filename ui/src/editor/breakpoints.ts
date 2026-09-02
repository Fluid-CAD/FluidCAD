import { monaco } from './monaco-setup';
import type { WorkspaceModels } from './models';
import { postCodeEdit } from './host/transforms';

/**
 * The breakpoint gutter. Monaco has no breakpoint concept of its own, so this
 * is a glyph-margin decoration plus a click handler — but the decoration is
 * only ever a **view of the code**.
 *
 * The source of truth is the `breakpoint()` call in the file: toggling POSTs
 * `/api/code/toggle-breakpoint` and the `newCode` that comes back is what
 * actually contains the marker. So the dots are re-derived after every change
 * rather than tracked, and an edit that moves a line can't desynchronise them.
 */

const BREAKPOINT_LINE = /^\s*breakpoint\s*\(\s*\)\s*;?\s*$/;

const GLYPH_CLASS = 'fluidcad-breakpoint-glyph';

export interface BreakpointsDeps {
  models: WorkspaceModels;
  /** Apply `newCode` the same way every other transform result is applied. */
  applyCode(absPath: string, newCode: string): void;
}

export class Breakpoints {
  private collections = new Map<string, monaco.editor.IEditorDecorationsCollection>();
  private editor: monaco.editor.IStandaloneCodeEditor | null = null;

  constructor(private readonly deps: BreakpointsDeps) {}

  /** Wire the gutter to an editor. Called once, when Monaco is created. */
  attach(editor: monaco.editor.IStandaloneCodeEditor): void {
    this.editor = editor;
    editor.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        return;
      }
      const line = event.target.position?.lineNumber;
      const model = editor.getModel();
      const entry = model ? this.deps.models.findByModel(model) : undefined;
      if (line && entry) {
        void this.toggle(entry.absPath, line);
      }
    });
    editor.onDidChangeModel(() => this.refreshCurrent());
  }

  /**
   * Toggle at `line` (1-based). The server decides where the marker really
   * goes — a click between statements resolves to the next one — so the
   * cursor row it takes is 0-based, matching `/api/code/toggle-breakpoint`.
   */
  async toggle(absPath: string, line: number): Promise<void> {
    const entry = this.deps.models.get(absPath);
    if (!entry) {
      return;
    }
    const result = await postCodeEdit('toggle-breakpoint', {
      code: entry.model.getValue(),
      cursorRow: Math.max(0, line - 1),
    });
    if (!result || typeof result.newCode !== 'string') {
      return;
    }
    this.deps.applyCode(absPath, result.newCode);
    this.refresh(absPath);
  }

  /** Re-derive the dots for `absPath` from its current text. */
  refresh(absPath: string): void {
    const entry = this.deps.models.get(absPath);
    if (!entry || !this.editor || this.editor.getModel() !== entry.model) {
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const lines = entry.model.getLinesContent();
    for (const [index, text] of lines.entries()) {
      if (!BREAKPOINT_LINE.test(text)) {
        continue;
      }
      decorations.push({
        range: new monaco.Range(index + 1, 1, index + 1, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: GLYPH_CLASS,
          glyphMarginHoverMessage: { value: 'Rendering stops here. Click to remove.' },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    let collection = this.collections.get(absPath);
    if (!collection) {
      collection = this.editor.createDecorationsCollection();
      this.collections.set(absPath, collection);
    }
    collection.set(decorations);
  }

  /** `absPath` is gone (renamed away): drop the dots that were drawn for it. */
  forget(absPath: string): void {
    this.collections.get(absPath)?.clear();
    this.collections.delete(absPath);
  }

  private refreshCurrent(): void {
    const model = this.editor?.getModel();
    const entry = model ? this.deps.models.findByModel(model) : undefined;
    if (entry) {
      this.refresh(entry.absPath);
    }
  }

  /** After any render — the code may have changed under us. */
  refreshAll(): void {
    this.refreshCurrent();
  }
}
