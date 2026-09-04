// The statement-level dependency analysis the timeline's structural edits
// share: which names a statement binds, which calls it evaluates, whether it
// produces or implicitly consumes a sketch, and the whole-line splice that
// deletes a set of statements cleanly. `MoveToPart` (drag into a part) and
// `RemoveFeature` (delete with cascade) are its concrete transforms.

import {
  findEditableCallAt,
  isBlankRow,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import { isReferenceUse, listEngineSymbols } from './lint-fluid-js.ts';

/** The innermost call of a chain whose callee is a bare identifier, or null. */
function rootCallOf(call: TSNode): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return current;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Chain-root callees whose call creates or mutates scene state when the
 * declaration is evaluated — referencing such a binding from inside the
 * part would leave its geometry outside the part's scope, so its statement
 * must move along. Value declarations (numbers, `param()`, filter builders
 * like `face()`, helper functions — their bodies run at call time under
 * whatever container is then active) may stay behind: the moved code
 * reaches them through the module closure.
 */
const FEATURE_ROOT_CALLEES: Set<string> = (() => {
  const out = new Set(
    listEngineSymbols()
      .filter((s) => s.module === 'fluidcad/core')
      .map((s) => s.name),
  );
  out.delete('breakpoint');
  out.delete('param');
  return out;
})();

/**
 * Chain-root callees that consume the active sketch when no profile argument
 * or bound sketch reference is present (`sketch(…)` then `extrude(10)`).
 * That link is invisible to identifier analysis, so the mover pairs such a
 * statement with its nearest preceding top-level sketch statement
 * explicitly, in both directions. A missed pairing is non-fatal — it
 * surfaces as that feature's build-error badge, not a compile error.
 */
const IMPLICIT_SKETCH_CONSUMERS = new Set(['extrude', 'cut', 'revolve']);

/** Scopes whose contents run at call time, not when the statement evaluates. */
const DEFERRED_SCOPE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'class_declaration',
]);

export class StatementAnalysis {
  protected static rootCallOf(call: TSNode): TSNode | null {
    return rootCallOf(call);
  }


  protected static within(node: TSNode, container: TSNode): boolean {
    return node.startIndex >= container.startIndex && node.endIndex <= container.endIndex;
  }

  protected static sameSpan(a: TSNode, b: TSNode): boolean {
    return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
  }

  protected static rootCalleeOf(call: TSNode): string | null {
    const fn = rootCallOf(call)?.childForFieldName('function');
    return fn && fn.type === 'identifier' ? fn.text : null;
  }

  /**
   * Every call the statement runs when IT evaluates — the bodies of
   * functions it merely declares run later, under whatever container is
   * active at call time, so they don't count.
   */
  protected static *evaluatedCalls(node: TSNode): Generator<TSNode> {
    if (DEFERRED_SCOPE_TYPES.has(node.type)) {
      return;
    }
    if (node.type === 'call_expression') {
      yield node;
    }
    for (const child of node.namedChildren) {
      yield* StatementAnalysis.evaluatedCalls(child);
    }
  }

  protected static isSketchCall(call: TSNode): boolean {
    const fn = call.childForFieldName('function');
    return fn?.type === 'identifier' && fn.text === 'sketch';
  }

  /** The `sketch(…)` call whose callback body contains `node`, or null outside every sketch. */
  protected static enclosingSketchCall(node: TSNode): TSNode | null {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (cur.type === 'call_expression' && StatementAnalysis.isSketchCall(cur)) {
        return cur;
      }
    }
    return null;
  }

  protected static declaresPart(stmt: TSNode): boolean {
    for (const call of StatementAnalysis.evaluatedCalls(stmt)) {
      if (StatementAnalysis.rootCalleeOf(call) === 'part') {
        return true;
      }
    }
    return false;
  }

  protected static isValueLike(stmt: TSNode): boolean {
    for (const call of StatementAnalysis.evaluatedCalls(stmt)) {
      const callee = StatementAnalysis.rootCalleeOf(call);
      if (callee !== null && FEATURE_ROOT_CALLEES.has(callee)) {
        return false;
      }
    }
    return true;
  }

  protected static isSketchProducer(stmt: TSNode): boolean {
    for (const call of StatementAnalysis.evaluatedCalls(stmt)) {
      if (StatementAnalysis.rootCalleeOf(call) === 'sketch') {
        return true;
      }
    }
    return false;
  }

  protected static isImplicitConsumer(
    tree: TSTree,
    lines: string[],
    declByName: Map<string, TSNode>,
    stmt: TSNode,
  ): boolean {
    const call = findEditableCallAt(tree, lines, stmt.startPosition.row + 1);
    if (!call || !StatementAnalysis.within(call, stmt)) {
      return false;
    }
    const callee = StatementAnalysis.rootCalleeOf(call);
    if (!callee || !IMPLICIT_SKETCH_CONSUMERS.has(callee)) {
      return false;
    }
    const args = rootCallOf(call)?.childForFieldName('arguments');
    if (!args) {
      return true;
    }
    for (const node of walkTree(args)) {
      if (node.type === 'call_expression' && StatementAnalysis.rootCalleeOf(node) === 'sketch') {
        return false;
      }
      if (node.type === 'identifier' && isReferenceUse(node)) {
        const decl = declByName.get(node.text);
        if (decl && StatementAnalysis.isSketchProducer(decl)) {
          return false;
        }
      }
    }
    return true;
  }

  protected static nearestPrecedingSketch(topLevel: TSNode[], stmt: TSNode): TSNode | null {
    let best: TSNode | null = null;
    for (const candidate of topLevel) {
      if (candidate.startIndex >= stmt.startIndex) {
        break;
      }
      if (StatementAnalysis.isSketchProducer(candidate)) {
        best = candidate;
      }
    }
    return best;
  }

  protected static declaredNames(stmt: TSNode): string[] {
    if (stmt.type === 'export_statement') {
      const decl = stmt.childForFieldName('declaration');
      return decl ? StatementAnalysis.declaredNames(decl) : [];
    }
    const out: string[] = [];
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
      for (const decl of stmt.namedChildren) {
        if (decl.type !== 'variable_declarator') {
          continue;
        }
        const name = decl.childForFieldName('name');
        if (!name) {
          continue;
        }
        if (name.type === 'identifier') {
          out.push(name.text);
          continue;
        }
        for (const n of walkTree(name)) {
          if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
            out.push(n.text);
          }
        }
      }
    } else if (
      stmt.type === 'function_declaration' ||
      stmt.type === 'generator_function_declaration' ||
      stmt.type === 'class_declaration'
    ) {
      const name = stmt.childForFieldName('name');
      if (name) {
        out.push(name.text);
      }
    }
    return out;
  }

  protected static importedNames(root: TSNode): Set<string> {
    const out = new Set<string>();
    for (const stmt of root.namedChildren) {
      if (stmt.type !== 'import_statement') {
        continue;
      }
      for (const node of walkTree(stmt)) {
        if (node.type === 'import_specifier') {
          const local = node.childForFieldName('alias') ?? node.childForFieldName('name');
          if (local) {
            out.add(local.text);
          }
        } else if (node.type === 'namespace_import' || node.type === 'import_clause') {
          for (const child of node.namedChildren) {
            if (child.type === 'identifier') {
              out.add(child.text);
            }
          }
        }
      }
    }
    return out;
  }

  protected static labelFor(stmt: TSNode, fallback: string): string {
    const names = StatementAnalysis.declaredNames(stmt);
    if (names.length > 0) {
      return names[0];
    }
    for (const call of StatementAnalysis.evaluatedCalls(stmt)) {
      const callee = StatementAnalysis.rootCalleeOf(call);
      if (callee) {
        return callee;
      }
    }
    return fallback;
  }

  /**
   * The byte ranges deleting the moved statements removes, expressed over
   * the ORIGINAL text — `removeStatement`'s hygiene generalized to a set:
   * whole lines when a statement stands alone on them, statements separated
   * only by blank rows merged into one span (deleting them one by one would
   * strand those blanks), one following blank row consumed when a deletion
   * would double up blanks, and the preceding newline when a span closes
   * the file.
   */
  protected static removalEdits(
    code: string,
    lines: string[],
    moved: TSNode[],
  ): { start: number; end: number; text: string }[] {
    const lineStarts: number[] = new Array(lines.length);
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      lineStarts[i] = offset;
      offset += lines[i].length + 1;
    }

    const edits: { start: number; end: number; text: string }[] = [];
    const spans: { startRow: number; endRow: number }[] = [];
    for (const stmt of moved) {
      const startRow = stmt.startPosition.row;
      const endRow = stmt.endPosition.row;
      const alone =
        lines[startRow].slice(0, stmt.startPosition.column).trim() === '' &&
        lines[endRow].slice(stmt.endPosition.column).trim() === '';
      if (!alone) {
        // Sharing a line with other code: excise just the statement's range.
        edits.push({ start: stmt.startIndex, end: stmt.endIndex, text: '' });
        continue;
      }
      const previous = spans[spans.length - 1];
      const gapAllBlank = previous
        ? lines.slice(previous.endRow + 1, startRow).every((l) => l.trim() === '')
        : false;
      if (previous && gapAllBlank) {
        previous.endRow = endRow;
      } else {
        spans.push({ startRow, endRow });
      }
    }

    for (const span of spans) {
      let lastRow = span.endRow;
      if (span.startRow > 0 && isBlankRow(lines, span.startRow - 1) && isBlankRow(lines, lastRow + 1)) {
        lastRow += 1;
      }
      if (lastRow + 1 < lines.length) {
        edits.push({ start: lineStarts[span.startRow], end: lineStarts[lastRow + 1], text: '' });
      } else {
        // The span closes the file: consume the preceding newline instead.
        edits.push({ start: span.startRow > 0 ? lineStarts[span.startRow] - 1 : 0, end: code.length, text: '' });
      }
    }
    return edits;
  }

}
