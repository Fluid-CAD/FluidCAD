// Moving timeline feature statements into a `part()` callback body — the
// analysis and splice behind the timeline's multi-select drag-drop.
//
// The dangerous half is the analysis, not the splice: the selection can
// depend on statements that are not selected (a moved extrude consuming an
// unmoved sketch), and unselected code can depend on the moved bindings (a
// fillet chaining off a moved const). A naive text move then produces a
// ReferenceError, the render fails to compile, and the timeline keeps
// serving the previous scene's rows against a buffer whose line numbers no
// longer match. `analyze` therefore refuses or names the companion
// statements the move must include — computed to a fixpoint — before a
// single byte is touched; the route's dry-run turns that list into the UI's
// "Also moves: …" confirm, and `apply` refuses unless the set is closed.

import {
  enclosingStatementOf,
  findEditableCallAt,
  findSketchBody,
  getJavaScriptParser,
  isUnitStatement,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import { isReferenceUse } from './lint-fluid-js.ts';
import { StatementAnalysis } from './statement-analysis.ts';
import { resolvePartBodyInsertion, type ApplyFeatureEditResult } from './apply-feature-edit.ts';

export type MoveToPartSpec = {
  /** The selected statements, by timeline source line, with drift guards. */
  statements: { line: number; expectedText: string }[];
  /** The `part(...)` call site whose callback body receives them. */
  part: { line: number; column: number };
};

/** One statement the move must also include, for the UI's confirm list. */
export type MoveNeed = { name: string; line: number };

export type MoveToPartAnalysis =
  | { ok: true }
  | { ok: false; reason: string; needs?: MoveNeed[] };

type ResolvedMove = {
  tree: TSTree;
  lines: string[];
  /** The moved statements — selection plus companions — in document order. */
  moved: TSNode[];
  /** Companions beyond the requested selection, for the confirm dialog. */
  needs: MoveNeed[];
};

export class MoveToPart extends StatementAnalysis {
  /**
   * Resolve the requested timeline lines against `code`, deduping rows that
   * share a statement and capturing each statement's exact text as the drift
   * guard the transform re-checks against the live buffer.
   */
  static async captureStatements(
    code: string,
    requestLines: number[],
  ): Promise<{ statements: { line: number; expectedText: string }[] } | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);
    const seen = new Set<number>();
    const statements: { line: number; expectedText: string }[] = [];
    for (const line of requestLines) {
      const call = findEditableCallAt(tree, lines, line);
      const stmt = call ? enclosingStatementOf(call) : null;
      if (!call || !stmt) {
        return { error: `no feature call found at line ${line} — is the file in sync with the last render?` };
      }
      if (seen.has(stmt.startIndex)) {
        continue;
      }
      seen.add(stmt.startIndex);
      statements.push({ line, expectedText: code.slice(stmt.startIndex, stmt.endIndex) });
    }
    return { statements };
  }

  /** Pure analysis for the route's dry-run: never touches the code. */
  static async analyze(code: string, spec: MoveToPartSpec): Promise<MoveToPartAnalysis> {
    const resolved = await MoveToPart.resolve(code, spec);
    if ('error' in resolved) {
      return { ok: false, reason: resolved.error };
    }
    if (resolved.needs.length > 0) {
      return { ok: false, reason: MoveToPart.needsMessage(resolved.needs), needs: resolved.needs };
    }
    return { ok: true };
  }

  /**
   * The transform half: refuses unless the moved set is dependency-closed,
   * then splices — every removal range and the insertion offset are
   * positions in the ORIGINAL text, applied in descending order, so the
   * part may sit above or below the moved statements.
   */
  static async apply(code: string, spec: MoveToPartSpec): Promise<ApplyFeatureEditResult> {
    const resolved = await MoveToPart.resolve(code, spec);
    if ('error' in resolved) {
      return { newCode: code, error: resolved.error };
    }
    if (resolved.needs.length > 0) {
      return { newCode: code, error: MoveToPart.needsMessage(resolved.needs) };
    }
    const { tree, lines, moved } = resolved;
    const insertion = resolvePartBodyInsertion(spec.part, [], lines, tree);
    if ('error' in insertion) {
      return { newCode: code, error: insertion.error };
    }

    const indent = insertion.indent;
    const pieces = moved.map((s) => MoveToPart.reindent(code.slice(s.startIndex, s.endIndex), indent));
    const block = insertion.wrap(pieces.join(`\n${indent}`));

    const edits = MoveToPart.removalEdits(code, lines, moved);
    edits.push({ start: insertion.index, end: insertion.index, text: block });
    edits.sort((a, b) => b.start - a.start);
    let newCode = code;
    for (const e of edits) {
      newCode = spliceCode(newCode, e.start, e.end, e.text);
    }
    return { newCode };
  }

  private static needsMessage(needs: MoveNeed[]): string {
    const listed = needs.map((n) => `'${n.name}' (line ${n.line})`).join(', ');
    return `moving these features also requires: ${listed}`;
  }

  private static async resolve(code: string, spec: MoveToPartSpec): Promise<ResolvedMove | { error: string }> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const lines = splitLines(code);

    const partCall = findEditableCallAt(tree, lines, spec.part.line);
    if (!partCall || MoveToPart.rootCalleeOf(partCall) !== 'part') {
      return { error: `no part() call found at line ${spec.part.line} — is the file in sync with the last render?` };
    }
    const body = findSketchBody(partCall);
    if (!body) {
      return { error: 'the part at that line has no callback body to move features into' };
    }
    const partStatement = enclosingStatementOf(partCall);

    const byStart = new Map<number, TSNode>();
    for (const sel of spec.statements) {
      const call = findEditableCallAt(tree, lines, sel.line);
      const stmt = call ? enclosingStatementOf(call) : null;
      if (!call || !stmt) {
        return { error: `no feature call found at line ${sel.line} — is the file in sync with the last render?` };
      }
      if (code.slice(stmt.startIndex, stmt.endIndex) !== sel.expectedText) {
        return { error: `the code at line ${sel.line} changed since the timeline rendered — wait for the render and drop again` };
      }
      if (MoveToPart.within(stmt, body)) {
        // Already a member of the target part: a no-op, not an error.
        continue;
      }
      if (stmt.parent?.type !== 'program') {
        return { error: `the feature at line ${sel.line} is inside another scope — only top-level features can move into a part` };
      }
      if (partStatement && MoveToPart.sameSpan(stmt, partStatement)) {
        return { error: 'a part cannot be moved into itself' };
      }
      if (MoveToPart.declaresPart(stmt)) {
        return { error: `the feature at line ${sel.line} declares a part() — parts cannot nest inside parts` };
      }
      // A unit() statement is file metadata, not a feature: it is never a
      // timeline row, but a stale or hand-built request could still name
      // its line, and inside a part() body it would be a runtime error.
      if (isUnitStatement(stmt)) {
        return { error: `unit() at line ${sel.line} declares the whole file's unit — it stays at the top level and cannot move into a part` };
      }
      byStart.set(stmt.startIndex, stmt);
    }
    if (byStart.size === 0) {
      return { error: 'those features are already inside that part' };
    }

    const topLevel = tree.rootNode.namedChildren;
    const imports = MoveToPart.importedNames(tree.rootNode);
    const declByName = new Map<string, TSNode>();
    for (const stmt of topLevel) {
      for (const name of MoveToPart.declaredNames(stmt)) {
        declByName.set(name, stmt);
      }
    }

    const moved = new Map(byStart);
    const needs: MoveNeed[] = [];
    const inMoved = (node: TSNode): boolean => {
      for (const stmt of moved.values()) {
        if (MoveToPart.within(node, stmt)) {
          return true;
        }
      }
      return false;
    };
    const addCompanion = (stmt: TSNode, name: string): string | null => {
      if (moved.has(stmt.startIndex)) {
        return null;
      }
      if (partStatement && MoveToPart.sameSpan(stmt, partStatement)) {
        return `'${name}' is used by the target part() statement itself — restructure the code first`;
      }
      if (MoveToPart.declaresPart(stmt)) {
        return `'${name}' would drag the part declared at line ${stmt.startPosition.row + 1} along — parts cannot nest inside parts`;
      }
      moved.set(stmt.startIndex, stmt);
      needs.push({ name, line: stmt.startPosition.row + 1 });
      return null;
    };

    for (let changed = true; changed; ) {
      changed = false;
      const movedNames = new Set<string>();
      for (const stmt of moved.values()) {
        for (const name of MoveToPart.declaredNames(stmt)) {
          movedNames.add(name);
        }
      }

      // Outward: a reference to a moved binding from code that stays behind
      // breaks outright once the declaration lives inside the callback. A
      // top-level consumer can come along; a reference in any nested scope
      // (another part's body, the target part's own body — which runs before
      // the appended declaration — a function) cannot be fixed by moving
      // more statements, so it refuses.
      for (const node of walkTree(tree.rootNode)) {
        if (node.type !== 'identifier' || !movedNames.has(node.text) || !isReferenceUse(node)) {
          continue;
        }
        if (inMoved(node)) {
          continue;
        }
        const stmt = enclosingStatementOf(node);
        if (!stmt) {
          continue;
        }
        if (stmt.parent?.type !== 'program') {
          return {
            error: `'${node.text}' is still used at line ${node.startPosition.row + 1}, inside a scope that cannot see the moved declaration — deselect '${node.text}' or restructure the code first`,
          };
        }
        const err = addCompanion(stmt, MoveToPart.labelFor(stmt, node.text));
        if (err) {
          return { error: err };
        }
        changed = true;
      }

      // Inward: a moved statement reaching back to a top-level feature
      // binding would leave that geometry outside the part — bring its
      // statement along. Value declarations and part bindings (cross-part
      // references are how parts consume each other) stay behind.
      for (const stmt of [...moved.values()]) {
        for (const node of walkTree(stmt)) {
          if (node.type !== 'identifier' || !isReferenceUse(node)) {
            continue;
          }
          const name = node.text;
          if (movedNames.has(name) || imports.has(name)) {
            continue;
          }
          const decl = declByName.get(name);
          if (!decl || moved.has(decl.startIndex)) {
            continue;
          }
          if (MoveToPart.declaresPart(decl) || MoveToPart.isValueLike(decl)) {
            continue;
          }
          const err = addCompanion(decl, name);
          if (err) {
            return { error: err };
          }
          changed = true;
        }
      }

      // Implicit sketch consumption, both directions.
      for (const stmt of [...moved.values()]) {
        if (!MoveToPart.isImplicitConsumer(tree, lines, declByName, stmt)) {
          continue;
        }
        const producer = MoveToPart.nearestPrecedingSketch(topLevel, stmt);
        if (producer && !moved.has(producer.startIndex)) {
          const err = addCompanion(producer, MoveToPart.labelFor(producer, 'sketch'));
          if (err) {
            return { error: err };
          }
          changed = true;
        }
      }
      for (const stmt of topLevel) {
        if (moved.has(stmt.startIndex) || !MoveToPart.isImplicitConsumer(tree, lines, declByName, stmt)) {
          continue;
        }
        const producer = MoveToPart.nearestPrecedingSketch(topLevel, stmt);
        if (producer && moved.has(producer.startIndex)) {
          const err = addCompanion(stmt, MoveToPart.labelFor(stmt, 'feature'));
          if (err) {
            return { error: err };
          }
          changed = true;
        }
      }
    }

    return {
      tree,
      lines,
      moved: [...moved.values()].sort((a, b) => a.startIndex - b.startIndex),
      needs,
    };
  }


  /** Re-base a top-level statement's continuation lines onto `indent`. */
  private static reindent(text: string, indent: string): string {
    return text
      .split('\n')
      .map((line, i) => {
        if (i === 0) {
          return line;
        }
        return line.trim() === '' ? '' : indent + line;
      })
      .join('\n');
  }
}
