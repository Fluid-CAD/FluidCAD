import {
  addBreakpoint, breakpointRemovalEdit, findAllBreakpointStatements, getJavaScriptParser, type BreakpointSite,
} from './code-editor/index.ts';
import type { ApplyFeatureEditResult } from './apply-feature-edit/spec.ts';

/**
 * The edit-feature gesture's pause: a `breakpoint();` after the statement on
 * `referenceRow` (0-based), every other stop kept.
 *
 * `lift` is the stop an open edit dialog holds the build on — the one its
 * double-click placed — when the gesture lands on another row while that
 * dialog is open. Lifting it here, in the same source edit as the new stop,
 * is what keeps the hand-off to one render: left to the old dialog's own
 * cancel it would be a second edit racing the first, and its unpaused render
 * landed after the new dialog's rollback and cleared the ghost it had just
 * drawn. A lift that names the very stop the new row would get leaves the
 * code untouched (the new dialog adopts it; no render follows).
 */
export type PauseAfterSpec = {
  referenceRow: number;
  lift?: BreakpointSite | null;
};

export class PauseAfter {
  static async apply(code: string, spec: PauseAfterSpec): Promise<ApplyFeatureEditResult> {
    const lifted = spec.lift ? await this.findStop(code, spec.lift) : null;
    if (!lifted) {
      return addBreakpoint(code, spec.referenceRow);
    }
    const probe = await addBreakpoint(code, spec.referenceRow);
    if (probe.newCode === code && probe.breakpointLine === lifted.row) {
      // The lifted stop is exactly where the new one goes — the same row
      // double-clicked again.
      return probe;
    }
    // Lift first, then place: a lift above the referenced row moves it up by
    // the lines the lift took out (an inline stop takes none).
    const removed = code.slice(lifted.start, lifted.end);
    const removedLines = removed.split('\n').length - 1;
    const withoutLifted = code.slice(0, lifted.start) + code.slice(lifted.end);
    const referenceRow = lifted.row < spec.referenceRow ? spec.referenceRow - removedLines : spec.referenceRow;
    return addBreakpoint(withoutLifted, referenceRow);
  }

  /** The exact `breakpoint();` at `site`, or null — never another stop in its place. */
  private static async findStop(code: string, site: BreakpointSite): Promise<{ start: number; end: number; row: number } | null> {
    const tree = (await getJavaScriptParser()).parse(code);
    try {
      const node = findAllBreakpointStatements(tree)
        .find(n => n.startPosition.row === site.line - 1 && n.startPosition.column === site.column - 1);
      if (!node) {
        return null;
      }
      const edit = breakpointRemovalEdit(code, node);
      return { start: edit.start, end: edit.end, row: node.startPosition.row };
    } finally {
      (tree as typeof tree & { delete?: () => void }).delete?.();
    }
  }
}
