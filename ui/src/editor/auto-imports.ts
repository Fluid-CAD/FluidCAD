import { monaco } from './monaco-setup';
import type { EngineSymbolEntry } from './editor-api';

type WorkspaceExport = { name: string; kind: monaco.languages.CompletionItemKind };

/**
 * Auto-import completions for the engine's public API — the one IntelliSense
 * behaviour VS Code has that Monaco's bundled TypeScript service doesn't.
 * tsserver suggests `extrude` before it is imported and inserts the
 * `import { … } from "fluidcad/core"` line on accept; Monaco's suggest
 * adapter calls the language service with auto-imports disabled and discards
 * the code actions that would carry the import edit, and both ends live
 * inside the shipped worker.
 *
 * So instead of forking that worker, this provider offers the engine symbols
 * itself. The table comes from the server's import linter via
 * `/api/engine/types`, which means what the editor suggests and what the
 * `missing-imports` write guard accepts are the same list by construction.
 * Each suggestion carries an `additionalTextEdits` that either merges the
 * name into an existing `import { … } from "fluidcad/…"` or adds a new
 * import line, so accepting one behaves exactly like VS Code.
 *
 * The same treatment covers the project's own files: every workspace source
 * is already a loaded Monaco model (`WorkspaceModels` loads them eagerly so
 * the TS service can cross-complete), so their top-level `export`s are
 * scanned right out of the models and offered with a relative specifier
 * (`./constants.js`) — multi-file models importing each other this way is a
 * supported engine feature, unlike arbitrary npm packages.
 *
 * Symbols already bound in the file (imported, or shadowed by a top-level
 * declaration) are not offered — the TS service completes those on its own,
 * and a second entry would either duplicate the list or insert a clashing
 * import.
 */
export class AutoImportCompletions implements monaco.languages.CompletionItemProvider {
  /** Named-import statement, per module: `import { a, b as c } from "m"`. */
  private static readonly NAMED_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g;

  /** Any top-level import statement, for "where does a new line go". */
  private static readonly IMPORT_STMT_RE = /^[ \t]*import\s[^;]*;/gm;

  /** Top-level bindings that shadow an engine name (linter's philosophy: top level only). */
  private static readonly DECLARATION_RE =
    /^[ \t]*(?:export\s+)?(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/gm;

  /** Top-level `export const|function|class name` (default exports have no importable name — skipped). */
  private static readonly EXPORT_DECL_RE =
    /^[ \t]*export\s+(?:async\s+)?(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

  /** `export { a, b as c }` clauses — re-export form included, it still exports from this file. */
  private static readonly EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}/gm;

  /** Per-file export scan, invalidated by the model's own version counter. */
  private readonly exportCache = new Map<
    string,
    { versionId: number; exports: WorkspaceExport[] }
  >();

  constructor(private readonly symbols: readonly EngineSymbolEntry[]) {}

  provideCompletionItems(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): monaco.languages.CompletionList {
    const word = model.getWordUntilPosition(position);
    const line = model.getLineContent(position.lineNumber);
    // Member access (`shape.ext…`) and import clauses complete through the TS
    // service; an auto-import entry there is noise at best, a double import
    // at worst.
    const charBeforeWord = line[word.startColumn - 2];
    if (charBeforeWord === '.' || /^\s*import\b/.test(line)) {
      return { suggestions: [] };
    }

    const text = model.getValue();
    const bound = AutoImportCompletions.collectBoundNames(text);
    const range = new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    );

    const suggestions: monaco.languages.CompletionItem[] = [];
    for (const symbol of this.symbols) {
      if (bound.has(symbol.name)) {
        continue;
      }
      suggestions.push({
        label: { label: symbol.name, description: symbol.module },
        kind: monaco.languages.CompletionItemKind.Function,
        detail: `Auto import from "${symbol.module}"`,
        insertText: symbol.name,
        // TS sortText tiers: locals "11", globals/keywords "15",
        // auto-imports "16" — this slots in exactly where tsserver puts its
        // own auto-import suggestions, below everything in scope.
        sortText: `16${symbol.name}`,
        range,
        additionalTextEdits: [AutoImportCompletions.importEdit(model, text, symbol)],
      });
    }

    for (const found of this.workspaceExports(model)) {
      if (bound.has(found.name)) {
        continue;
      }
      suggestions.push({
        label: { label: found.name, description: found.specifier },
        kind: found.kind,
        detail: `Auto import from "${found.specifier}"`,
        insertText: found.name,
        sortText: `16${found.name}`,
        range,
        additionalTextEdits: [
          AutoImportCompletions.importEdit(model, text, {
            name: found.name,
            module: found.specifier,
          }),
        ],
      });
    }
    return { suggestions };
  }

  /**
   * Exports of every other workspace model, each paired with the relative
   * specifier that imports it from the current file.
   */
  private workspaceExports(
    current: monaco.editor.ITextModel,
  ): Array<WorkspaceExport & { specifier: string }> {
    const found: Array<WorkspaceExport & { specifier: string }> = [];
    for (const other of monaco.editor.getModels()) {
      if (other === current || other.uri.scheme !== 'file' || other.getLanguageId() !== 'javascript') {
        continue;
      }
      const specifier = AutoImportCompletions.relativeSpecifier(current.uri.path, other.uri.path);
      for (const exported of this.exportsOf(other)) {
        found.push({ ...exported, specifier });
      }
    }
    return found;
  }

  private exportsOf(model: monaco.editor.ITextModel): WorkspaceExport[] {
    const key = model.uri.toString();
    const cached = this.exportCache.get(key);
    if (cached && cached.versionId === model.getVersionId()) {
      return cached.exports;
    }
    const text = model.getValue();
    const exports: WorkspaceExport[] = [];
    for (const match of text.matchAll(AutoImportCompletions.EXPORT_DECL_RE)) {
      exports.push({ name: match[2], kind: AutoImportCompletions.kindFor(match[1]) });
    }
    for (const match of text.matchAll(AutoImportCompletions.EXPORT_LIST_RE)) {
      for (const spec of match[1].split(',')) {
        // `export { a as b }` exports `b`; `default` has no importable name.
        const name = spec.split(/\bas\b/).pop()?.trim();
        if (name && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)) {
          exports.push({ name, kind: monaco.languages.CompletionItemKind.Variable });
        }
      }
    }
    this.exportCache.set(key, { versionId: model.getVersionId(), exports });
    return exports;
  }

  private static kindFor(declaration: string): monaco.languages.CompletionItemKind {
    if (declaration === 'function') {
      return monaco.languages.CompletionItemKind.Function;
    }
    if (declaration === 'class') {
      return monaco.languages.CompletionItemKind.Class;
    }
    return monaco.languages.CompletionItemKind.Variable;
  }

  /** `./sibling.js` or `../parts/arm.fluid.js`, posix-style like the model URIs. */
  private static relativeSpecifier(fromFile: string, toFile: string): string {
    const fromDirs = fromFile.split('/').slice(0, -1).filter(Boolean);
    const toParts = toFile.split('/').filter(Boolean);
    const toName = toParts.pop();
    let shared = 0;
    while (
      shared < fromDirs.length &&
      shared < toParts.length &&
      fromDirs[shared] === toParts[shared]
    ) {
      shared++;
    }
    const up = fromDirs.length - shared;
    const down = [...toParts.slice(shared), toName].join('/');
    if (up === 0) {
      return `./${down}`;
    }
    return `${'../'.repeat(up)}${down}`;
  }

  /**
   * Names the file already binds at the top level: import locals (the alias
   * when renamed) plus declared `const`/`function`/`class` names.
   */
  private static collectBoundNames(text: string): Set<string> {
    const bound = new Set<string>();
    for (const match of text.matchAll(AutoImportCompletions.NAMED_IMPORT_RE)) {
      for (const spec of match[1].split(',')) {
        const local = spec.split(/\bas\b/).pop()?.trim();
        if (local) {
          bound.add(local);
        }
      }
    }
    for (const match of text.matchAll(AutoImportCompletions.DECLARATION_RE)) {
      bound.add(match[1]);
    }
    return bound;
  }

  /**
   * The edit that makes the accepted symbol resolve: extend the module's
   * existing named import if there is one, otherwise a fresh import line
   * after the last import (or at the very top of the file).
   */
  private static importEdit(
    model: monaco.editor.ITextModel,
    text: string,
    symbol: EngineSymbolEntry,
  ): monaco.editor.ISingleEditOperation {
    for (const match of text.matchAll(AutoImportCompletions.NAMED_IMPORT_RE)) {
      if (match[3] !== symbol.module) {
        continue;
      }
      const inner = match[1];
      const innerStart = match.index + match[0].indexOf('{') + 1;
      if (inner.trim() === '') {
        // `{}` or `{ }` — replace the whole gap so the result is `{ name }`.
        const start = model.getPositionAt(innerStart);
        const end = model.getPositionAt(innerStart + inner.length);
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          text: ` ${symbol.name} `,
        };
      }
      // Insert before the closing brace's leading whitespace:
      // `{ sketch }` → `{ sketch, rect }`.
      const insertAt = model.getPositionAt(innerStart + inner.replace(/\s+$/, '').length);
      return {
        range: new monaco.Range(
          insertAt.lineNumber,
          insertAt.column,
          insertAt.lineNumber,
          insertAt.column,
        ),
        text: `, ${symbol.name}`,
      };
    }

    const quote = AutoImportCompletions.preferredQuote(text);
    const statement = `import { ${symbol.name} } from ${quote}${symbol.module}${quote};`;
    let lastImportEnd = -1;
    for (const match of text.matchAll(AutoImportCompletions.IMPORT_STMT_RE)) {
      lastImportEnd = match.index + match[0].length;
    }
    if (lastImportEnd >= 0) {
      // End of the last import's line (past any trailing comment), so the
      // edit is valid even when that import is the final line of the file.
      const line = model.getPositionAt(lastImportEnd).lineNumber;
      const column = model.getLineMaxColumn(line);
      return {
        range: new monaco.Range(line, column, line, column),
        text: `\n${statement}`,
      };
    }
    // No imports yet: the new line opens the file, with a blank line before
    // whatever code is there now.
    const firstLineEmpty = model.getLineContent(1).trim() === '';
    return {
      range: new monaco.Range(1, 1, 1, 1),
      text: firstLineEmpty ? `${statement}\n` : `${statement}\n\n`,
    };
  }

  /** Match the file's existing import quoting; `"` for a fresh file, like the lint suggestion. */
  private static preferredQuote(text: string): string {
    const match = /import\s[^;]*?from\s*(['"])/.exec(text);
    return match ? match[1] : '"';
  }
}

let registered = false;

/**
 * Idempotent: the provider is global to the language, not to an editor.
 * Registered even when the engine table is empty (older server) — the
 * workspace-export half needs no server support at all.
 */
export function registerAutoImports(symbols: readonly EngineSymbolEntry[] | undefined): void {
  if (registered) {
    return;
  }
  registered = true;
  monaco.languages.registerCompletionItemProvider(
    'javascript',
    new AutoImportCompletions(symbols ?? []),
  );
}
