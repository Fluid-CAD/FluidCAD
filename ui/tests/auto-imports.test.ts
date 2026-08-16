// Auto-import completions (`auto-imports.ts`): the Monaco-side answer to
// VS Code suggesting unimported FluidCAD symbols. What matters is the edit
// each suggestion carries — merged into the right existing import, or a new
// import line in the right place with the file's own quote style — and that
// symbols already bound in the file are never offered twice.

import { describe, it, expect, vi } from 'vitest';

// The real setup module pulls in Vite `?worker` imports that have no meaning
// under vitest; the provider only needs Range and the CompletionItemKind enum.
vi.mock('../src/editor/monaco-setup', () => ({
  monaco: {
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    languages: {
      CompletionItemKind: { Function: 1 },
      registerCompletionItemProvider: vi.fn(),
    },
  },
}));

import { AutoImportCompletions } from '../src/editor/auto-imports';

const SYMBOLS = [
  { name: 'rect', module: 'fluidcad/core' },
  { name: 'extrude', module: 'fluidcad/core' },
  { name: 'face', module: 'fluidcad/filters' },
];

/** The slice of ITextModel the provider touches, backed by a plain string. */
function fakeModel(text: string) {
  const lines = text.split('\n');
  const lineStart = (lineNumber: number) => {
    let offset = 0;
    for (let i = 0; i < lineNumber - 1; i++) {
      offset += lines[i].length + 1;
    }
    return offset;
  };
  return {
    getValue: () => text,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLineMaxColumn: (n: number) => (lines[n - 1] ?? '').length + 1,
    getPositionAt: (offset: number) => {
      let line = 1;
      while (line < lines.length && lineStart(line + 1) <= offset) {
        line++;
      }
      return { lineNumber: line, column: offset - lineStart(line) + 1 };
    },
    getWordUntilPosition: (pos: { lineNumber: number; column: number }) => {
      const lineText = lines[pos.lineNumber - 1] ?? '';
      let start = pos.column - 1;
      while (start > 0 && /[\w$]/.test(lineText[start - 1])) {
        start--;
      }
      return {
        word: lineText.slice(start, pos.column - 1),
        startColumn: start + 1,
        endColumn: pos.column,
      };
    },
  } as any;
}

/** End of the text, as a position — where the user is typing in these tests. */
function caretAtEnd(text: string) {
  const lines = text.split('\n');
  return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
}

function complete(text: string, position = caretAtEnd(text)) {
  const provider = new AutoImportCompletions(SYMBOLS);
  return provider.provideCompletionItems(fakeModel(text), position as any);
}

/** Apply a suggestion's import edit to the text, so assertions read as files. */
function applyImportEdit(text: string, item: any): string {
  const [edit] = item.additionalTextEdits;
  const lines = text.split('\n');
  const offsetOf = (lineNumber: number, column: number) => {
    let offset = column - 1;
    for (let i = 0; i < lineNumber - 1; i++) {
      offset += lines[i].length + 1;
    }
    return offset;
  };
  const start = offsetOf(edit.range.startLineNumber, edit.range.startColumn);
  const end = offsetOf(edit.range.endLineNumber, edit.range.endColumn);
  return text.slice(0, start) + edit.text + text.slice(end);
}

function suggestion(list: { suggestions: any[] }, name: string) {
  return list.suggestions.find((s) => s.label.label === name);
}

describe('AutoImportCompletions', () => {
  it('merges into an existing named import from the same module', () => {
    const text = 'import { sketch } from "fluidcad/core";\n\nconst s = re';
    const item = suggestion(complete(text), 'rect');
    expect(item).toBeDefined();
    expect(applyImportEdit(text, item)).toBe(
      'import { sketch, rect } from "fluidcad/core";\n\nconst s = re',
    );
  });

  it('adds a new import line after the last import, matching its quote style', () => {
    const text = "import { sketch } from 'fluidcad/core';\n\nconst f = fa";
    const item = suggestion(complete(text), 'face');
    expect(applyImportEdit(text, item)).toBe(
      "import { sketch } from 'fluidcad/core';\nimport { face } from 'fluidcad/filters';\n\nconst f = fa",
    );
  });

  it('opens the file with the import when there are none yet', () => {
    const text = 'const s = re';
    const item = suggestion(complete(text), 'rect');
    expect(applyImportEdit(text, item)).toBe(
      'import { rect } from "fluidcad/core";\n\nconst s = re',
    );
  });

  it('does not offer names the file already binds', () => {
    const text =
      'import { rect } from "fluidcad/core";\nconst extrude = 1;\nre';
    const list = complete(text);
    expect(suggestion(list, 'rect')).toBeUndefined();
    expect(suggestion(list, 'extrude')).toBeUndefined();
    expect(suggestion(list, 'face')).toBeDefined();
  });

  it('treats a renamed import as binding the alias, not the original', () => {
    const text = 'import { rect as r } from "fluidcad/core";\nre';
    // `rect` itself is unbound, so it is offered again (a second specifier in
    // the same clause is valid JS).
    const item = suggestion(complete(text), 'rect');
    expect(applyImportEdit(text, item)).toBe(
      'import { rect as r, rect } from "fluidcad/core";\nre',
    );
  });

  it('stays silent after a dot and inside import statements', () => {
    const memberAccess = 'const x = shape.re';
    expect(complete(memberAccess).suggestions).toHaveLength(0);
    const importLine = 'import { re';
    expect(complete(importLine).suggestions).toHaveLength(0);
  });

  it('sorts into the auto-import tier, below in-scope entries', () => {
    const item = suggestion(complete('re'), 'rect');
    expect(item.sortText).toBe('16rect');
    expect(item.insertText).toBe('rect');
    expect(item.label.description).toBe('fluidcad/core');
  });
});
