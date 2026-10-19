import { createHash } from 'node:crypto';
import {
  breakpointRemovalEdit, enclosingStatementOf, ensureSymbolImport, findActiveBreakpointStatement,
  findAllBreakpointStatements, getJavaScriptParser, isBreakpointStatement, type BreakpointSite,
} from './code-editor/index.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit/spec.ts';

/**
 * Which existing `breakpoint();` statements an edit takes out of the file.
 * A document may hold several: the build pauses on the first one it reaches
 * (the ACTIVE one) and the rest stay pending for after it.
 * - `passed`: every statement before the target — a move. A stop later in
 *   the file is left pending, so dragging the bar up to an earlier feature
 *   never loses the pause the user had set further down.
 * - `active`: the one the build paused on (`active`), else the first in
 *   document order — Continue: the build runs on to the next pending stop.
 * - `all`: continue to the end of history.
 */
export type BreakpointRemoval = 'passed' | 'active' | 'all';

/** One atomic edit of the document's breakpoints. */
export type TimelineBreakpointSpec = {
  /** The statement the build should pause before next, or null to add no stop. */
  before: BreakpointSite | null;
  /** Absent on a spec from an older client: `passed` with a target, `all` without. */
  remove?: BreakpointRemoval;
  /** The breakpoint the build is paused on — `remove: 'active'` names it. */
  active?: BreakpointSite | null;
  /**
   * Hash of the code `before` was captured against. Only a move checks it:
   * the target is a position, and a position in a file that changed since
   * means something else. A removal is resolved against the buffer it edits.
   */
  sourceHash: string;
};

export class TimelineBreakpoint {
  static capture(code: string, before: BreakpointSite | null, remove?: BreakpointRemoval, active?: BreakpointSite | null): TimelineBreakpointSpec {
    return {
      before,
      remove: remove ?? (before ? 'passed' : 'all'),
      ...(active ? { active } : {}),
      sourceHash: this.hash(code),
    };
  }

  private static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  static async apply(code: string, spec: TimelineBreakpointSpec): Promise<ApplyFeatureEditResult> {
    if (spec.before && this.hash(code) !== spec.sourceHash) {
      return { newCode: code, error: 'The file changed. Wait for the model to rebuild, then move the breakpoint again.' };
    }
    const remove = spec.remove ?? (spec.before ? 'passed' : 'all');
    const tree = (await getJavaScriptParser()).parse(code);
    try {
      const edits: { start: number; end: number; text: string }[] = [];
      let insertAt = Number.POSITIVE_INFINITY;
      if (spec.before) {
        const { line, column } = spec.before;
        const node = tree.rootNode.descendantForPosition({ row: line - 1, column: column - 1 });
        const statement = node && enclosingStatementOf(node);
        if (!statement || isBreakpointStatement(statement)
          || !['expression_statement', 'lexical_declaration', 'variable_declaration', 'export_statement'].includes(statement.type)) {
          return { newCode: code, error: 'This feature no longer has a matching statement. Rebuild the model and try again.' };
        }
        insertAt = statement.startIndex;
        const lineStart = code.lastIndexOf('\n', statement.startIndex - 1) + 1;
        const prefix = code.slice(lineStart, statement.startIndex);
        const indent = /^\s*$/.test(prefix) ? prefix : ' '.repeat(statement.startPosition.column);
        const newline = code.includes('\r\n') ? '\r\n' : '\n';
        edits.push({ start: statement.startIndex, end: statement.startIndex, text: `breakpoint();${newline}${indent}` });
      }
      // Delete exact statements, not their whole lines: inline callbacks and
      // adjacent feature statements must survive. Coordinates all refer to
      // the original buffer, so moving in either direction cannot shift them.
      const doomed = remove === 'active'
        ? [findActiveBreakpointStatement(tree, spec.active)].filter((n): n is NonNullable<typeof n> => n !== null)
        : findAllBreakpointStatements(tree).filter(node => remove === 'all' || node.startIndex < insertAt);
      for (const node of doomed) {
        edits.push(breakpointRemovalEdit(code, node));
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
