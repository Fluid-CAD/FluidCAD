import { createHash } from 'node:crypto';
import { enclosingStatementOf, ensureSymbolImport, getJavaScriptParser, isBreakpointStatement, walkTree } from './code-editor/index.ts';
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
      const edits: { start: number; end: number; text: string }[] = [];
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
        const newline = code.includes('\r\n') ? '\r\n' : '\n';
        edits.push({ start: statement.startIndex, end: statement.startIndex, text: `breakpoint();${newline}${indent}` });
      }
      // Delete exact statements, not their whole lines: inline callbacks and
      // adjacent feature statements must survive. Coordinates all refer to
      // the original buffer, so moving in either direction cannot shift them.
      for (const node of walkTree(tree.rootNode)) {
        if (!isBreakpointStatement(node)) continue;
        let start = node.startIndex;
        let end = node.endIndex;
        const lineStart = code.lastIndexOf('\n', start - 1) + 1;
        const newline = code.indexOf('\n', end);
        const lineEnd = newline < 0 ? code.length : newline;
        if (/^\s*$/.test(code.slice(lineStart, start)) && /^\s*$/.test(code.slice(end, lineEnd))) {
          start = lineStart;
          end = newline < 0 ? lineEnd : newline + 1;
        }
        edits.push({ start, end, text: '' });
      }
      let newCode = code;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        newCode = newCode.slice(0, edit.start) + edit.text + newCode.slice(edit.end);
      }
      if (spec.before) newCode = await ensureSymbolImport(newCode, 'breakpoint');
      return { newCode };
    } finally {
      (tree as typeof tree & { delete?: () => void }).delete?.();
    }
  }
}
