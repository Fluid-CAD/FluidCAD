import { createHash } from 'node:crypto';
import { applySpliceEdits, BreakpointMarker, enclosingStatementOf, ensureSymbolImport, getJavaScriptParser, isBreakpointStatement, type SpliceEdit } from './code-editor/index.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit/spec.ts';

/** A single, atomic move of the document's timeline stop. Null resumes the build. */
export type TimelineBreakpointSpec = {
  before: { line: number; column: number } | null;
  sourceHash: string;
};

export class TimelineBreakpoint {
  static capture(code: string, before: TimelineBreakpointSpec['before']): TimelineBreakpointSpec {
    return { before, sourceHash: this.hash(code) };
  }

  private static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  static async apply(code: string, spec: TimelineBreakpointSpec): Promise<ApplyFeatureEditResult> {
    if (this.hash(code) !== spec.sourceHash) {
      return { newCode: code, error: 'The file changed. Wait for the model to rebuild, then move the breakpoint again.' };
    }
    const tree = (await getJavaScriptParser()).parse(code);
    try {
      const edits: SpliceEdit[] = [];
      if (spec.before) {
        const { line, column } = spec.before;
        const node = tree.rootNode.descendantForPosition({ row: line - 1, column: column - 1 });
        const statement = node && enclosingStatementOf(node);
        if (!statement || isBreakpointStatement(statement)
          || !['expression_statement', 'lexical_declaration', 'variable_declaration', 'export_statement'].includes(statement.type)) {
          return { newCode: code, error: 'This feature no longer has a matching statement. Rebuild the model and try again.' };
        }
        const lineStart = code.lastIndexOf('\n', statement.startIndex - 1) + 1;
        const prefix = code.slice(lineStart, statement.startIndex);
        const indent = /^\s*$/.test(prefix) ? prefix : ' '.repeat(statement.startPosition.column);
        const lineBreak = BreakpointMarker.lineBreakOf(code);
        edits.push({ start: statement.startIndex, end: statement.startIndex, text: `breakpoint();${lineBreak}${indent}` });
      }
      // Delete exact statements, not their whole lines: inline callbacks and
      // adjacent feature statements must survive (BreakpointMarker.removals).
      // Coordinates all refer to the original buffer, so moving in either
      // direction cannot shift them.
      const markers = BreakpointMarker.statementsIn(tree);
      edits.push(...BreakpointMarker.removals(code, markers));
      let newCode = applySpliceEdits(code, edits);
      if (spec.before) {
        newCode = await ensureSymbolImport(newCode, 'breakpoint');
      } else if (markers.length > 0) {
        // Resuming takes the last stop away, and its import with it.
        newCode = await BreakpointMarker.releaseImport(newCode);
      }
      return { newCode };
    } finally {
      (tree as typeof tree & { delete?: () => void }).delete?.();
    }
  }
}
