import { createHash } from 'node:crypto';
import {
  applySpliceEdits, BreakpointMarker, enclosingStatementOf, ensureSymbolImport, findActiveBreakpointStatement,
  getJavaScriptParser, isBreakpointStatement, type BreakpointSite, type SpliceEdit,
} from './code-editor/index.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit/spec.ts';

/**
 * Which existing `breakpoint();` statements an edit takes out of the file.
 * A document may hold several: the build pauses on the first one it reaches
 * (the ACTIVE one) and the rest stay pending for after it. Several stops
 * only ever come from editing a feature (Edit feature / double-click places
 * one and leaves the user's own in place); the history bar's drag keeps a
 * single stop.
 * - `active`: the one the build paused on (`active`), else the first in
 *   document order — Continue: the build runs on to the next pending stop.
 * - `all`: every one — a move of the bar (the moved stop is the only one
 *   left) or continue to the end of history.
 */
export type BreakpointRemoval = 'active' | 'all';

/** One atomic edit of the document's breakpoints. */
export type TimelineBreakpointSpec = {
  /** The statement the build should pause before next, or null to add no stop. */
  before: BreakpointSite | null;
  /** Absent on a spec from an older client: `all`. */
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
      remove: remove ?? 'all',
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
    const remove = spec.remove ?? 'all';
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
      const doomed = remove === 'active'
        ? [findActiveBreakpointStatement(tree, spec.active)].filter((n): n is NonNullable<typeof n> => n !== null)
        : BreakpointMarker.statementsIn(tree);
      edits.push(...BreakpointMarker.removals(code, doomed));
      let newCode = applySpliceEdits(code, edits);
      if (spec.before) {
        newCode = await ensureSymbolImport(newCode, 'breakpoint');
      } else if (doomed.length > 0) {
        // Taking a stop away may take the last use of its import with it;
        // a pending stop further down keeps it (BreakpointMarker.releaseImport).
        newCode = await BreakpointMarker.releaseImport(newCode);
      }
      return { newCode };
    } finally {
      (tree as typeof tree & { delete?: () => void }).delete?.();
    }
  }
}
