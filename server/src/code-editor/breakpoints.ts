// breakpoint() statements: finding, adding, removing, toggling and clearing them.

import { countIdentifierUses, ensureSymbolImport, removeSymbolImport } from './imports.ts';
import { applySpliceEdits, isBlankRow, splitLines, type CodeEditResult, type SpliceEdit } from './lines.ts';
import { walkTree } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';

export type BreakpointEditResult = { newCode: string; breakpointLine: number | null };

/**
 * Recognise a `breakpoint();` statement: an expression_statement wrapping a
 * call_expression to the bare identifier `breakpoint` with zero arguments.
 * Comments, conditional expressions, or shadowed identifiers all fall out
 * of this match because the AST disambiguates them for us.
 */
export function isBreakpointStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'breakpoint') {
    return false;
  }
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length !== 0) {
    return false;
  }
  return true;
}

/**
 * Where a marker goes after the statement at a reference row: the row it
 * takes, and the row whose indentation it copies.
 */
type MarkerPlacement = { row: number; indentRow: number };

/** The span one marker (or a run of marker lines) takes out of the text. */
type MarkerRange = { start: number; end: number; wholeLines: boolean };

/**
 * The whole footprint of a `breakpoint();` marker in a file, and the exact
 * inverse of placing it. Placing one adds two things: the statement on a
 * line of its own (indented like the statement it follows, ended by the
 * file's own line break), and `breakpoint` in the core import when the file
 * doesn't bring it in yet. Removing one takes back exactly that: the
 * marker's line with its line break, and the import once nothing calls
 * `breakpoint` anymore. So an edit dialog that opens (placing a marker) and
 * closes (removing it) gives the file back byte for byte, and an Apply in
 * between leaves only the statement's own change.
 *
 * Removal reads what to take from the text around the marker, never from
 * line numbers remembered since it was placed: an Apply that rewrites the
 * edited statement, or adds imports, may move it.
 */
export class BreakpointMarker {
  /** The line break the file uses: `\r\n` when it has any, else `\n`. */
  static lineBreakOf(code: string): string {
    return code.includes('\r\n') ? '\r\n' : '\n';
  }

  /** Every `breakpoint();` statement in the tree, in source order. */
  static statementsIn(tree: TSTree): TSNode[] {
    const out: TSNode[] = [];
    for (const node of walkTree(tree.rootNode)) {
      if (isBreakpointStatement(node)) {
        out.push(node);
      }
    }
    return out;
  }

  /** The `breakpoint();` statement starting on 0-based `row`, if any. */
  static statementAt(tree: TSTree, row: number): TSNode | null {
    return this.statementsIn(tree).find(node => node.startPosition.row === row) ?? null;
  }

  /**
   * The edit that puts a marker on a line of its own at 0-based `row`,
   * ahead of whatever that row holds. A row past the end of a file whose
   * last line has no line break makes the marker the new last line: the
   * break goes in front of it instead, and still belongs to the marker.
   */
  static insertion(code: string, row: number, indent: string): SpliceEdit {
    const lineBreak = this.lineBreakOf(code);
    const start = this.rowStart(code, row);
    if (start < 0) {
      return { start: code.length, end: code.length, text: `${lineBreak}${indent}breakpoint();` };
    }
    return { start, end: start, text: `${indent}breakpoint();${lineBreak}` };
  }

  /**
   * The edits that take `markers` back out of `code`:
   * - a marker alone on its line(s) takes the whole line and its line break
   *   (on a last line without one, the break before it), which is exactly
   *   what {@link insertion} added — whatever sits next to it (code, a blank
   *   line, the body's closing brace) stays as it was;
   * - a marker sharing its line with code (`extrude(5); breakpoint();`)
   *   takes only its own text, so the code around it survives.
   */
  static removals(code: string, markers: TSNode[]): SpliceEdit[] {
    const ranges = markers.map(marker => this.removalRange(code, marker)).sort((a, b) => a.start - b.start);
    // Markers on consecutive lines go as one run of lines.
    const runs: MarkerRange[] = [];
    for (const range of ranges) {
      const last = runs[runs.length - 1];
      if (last && last.wholeLines && range.wholeLines && range.start <= last.end) {
        last.end = Math.max(last.end, range.end);
      } else {
        runs.push({ ...range });
      }
    }
    return runs.map(({ start, end, wholeLines }) => {
      // A run ending a file that has no final line break has no break of its
      // own to take: the one before it was placed with it.
      if (wholeLines && end === code.length && !code.endsWith('\n') && start > 0) {
        start--;
        if (start > 0 && code[start - 1] === '\r') {
          start--;
        }
      }
      return { start, end, text: '' };
    });
  }

  /**
   * Drop `breakpoint` from the core import once nothing in the file calls
   * it — the other half of what placing the first marker added. A file that
   * still uses the identifier keeps its import.
   */
  static async releaseImport(code: string): Promise<string> {
    const tree = (await getParser()).parse(code);
    if (countIdentifierUses(tree, 'breakpoint') > 0) {
      return code;
    }
    return removeSymbolImport(code, 'breakpoint');
  }

  /**
   * Tree-sitter resolution: given a 0-indexed reference row, the row right
   * after the enclosing top-level statement ends, and the statement's own
   * first row for the marker's indentation.
   *
   * "Top-level" = parent is the program root or a statement_block, so
   * breakpoints inside a function body still land after the enclosing
   * statement within that body.
   */
  static placementAfter(tree: TSTree, lines: string[], referenceRow: number): MarkerPlacement {
    const fallback = { row: referenceRow + 1, indentRow: Math.max(0, Math.min(referenceRow, lines.length - 1)) };
    let row = referenceRow;
    while (row >= 0 && isBlankRow(lines, row)) {
      row--;
    }
    if (row < 0) {
      return fallback;
    }

    // Resolve at the first non-blank column: column 0 of an indented statement
    // is leading whitespace, which tree-sitter attributes to the enclosing
    // block — the walk below would then escalate past the statement's own
    // block to the whole enclosing call (e.g. the sketch) instead.
    const column = lines[row].length - lines[row].trimStart().length;
    const node: TSNode | null = tree.rootNode.descendantForPosition({ row, column });
    if (!node || node === tree.rootNode) {
      return fallback;
    }

    let current: TSNode | null = node;
    while (current?.parent) {
      const pt = current.parent.type;
      if (pt === 'program' || pt === 'statement_block') {
        break;
      }
      current = current.parent;
    }

    if (!current) {
      return fallback;
    }

    return { row: current.endPosition.row + 1, indentRow: current.startPosition.row };
  }

  /** The leading spaces and tabs of 0-based `row`. */
  static indentAt(lines: string[], row: number): string {
    return lines[row]?.match(/^[ \t]*/)?.[0] ?? '';
  }

  /** What one marker takes: its whole line(s) with the break after them, or only its own text. */
  private static removalRange(code: string, marker: TSNode): MarkerRange {
    const lineStart = code.lastIndexOf('\n', marker.startIndex - 1) + 1;
    const lineBreak = code.indexOf('\n', marker.endIndex);
    const lineEnd = lineBreak < 0 ? code.length : lineBreak;
    const alone = /^[ \t]*$/.test(code.slice(lineStart, marker.startIndex))
      && /^\s*$/.test(code.slice(marker.endIndex, lineEnd));
    if (!alone) {
      return { start: marker.startIndex, end: marker.endIndex, wholeLines: false };
    }
    return { start: lineStart, end: lineBreak < 0 ? code.length : lineBreak + 1, wholeLines: true };
  }

  /** Offset where 0-based `row` starts, or -1 when the file has no such row. */
  private static rowStart(code: string, row: number): number {
    let offset = 0;
    for (let r = 0; r < row; r++) {
      const lineBreak = code.indexOf('\n', offset);
      if (lineBreak < 0) {
        return -1;
      }
      offset = lineBreak + 1;
    }
    return offset;
  }
}

export async function addBreakpoint(code: string, referenceRow: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const { row, indentRow } = BreakpointMarker.placementAfter(tree, lines, referenceRow);

  if (BreakpointMarker.statementAt(tree, row)) {
    return { newCode: code, breakpointLine: row };
  }

  const placed = applySpliceEdits(code, [BreakpointMarker.insertion(code, row, BreakpointMarker.indentAt(lines, indentRow))]);
  const newCode = await ensureSymbolImport(placed, 'breakpoint');
  // A new import line lands among the imports, above the marker.
  return { newCode, breakpointLine: row + splitLines(newCode).length - splitLines(placed).length };
}

export async function removeBreakpoint(code: string, line: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const node = BreakpointMarker.statementAt(tree, line);
  if (!node) {
    return { newCode: code, breakpointLine: null };
  }
  const removed = applySpliceEdits(code, BreakpointMarker.removals(code, [node]));
  return { newCode: await BreakpointMarker.releaseImport(removed), breakpointLine: null };
}

export async function toggleBreakpoint(code: string, cursorRow: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  if (BreakpointMarker.statementAt(tree, cursorRow)) {
    return removeBreakpoint(code, cursorRow);
  }
  if (BreakpointMarker.statementAt(tree, cursorRow + 1)) {
    return removeBreakpoint(code, cursorRow + 1);
  }
  return addBreakpoint(code, cursorRow);
}

export async function clearBreakpoints(code: string): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const stmts = BreakpointMarker.statementsIn(tree);
  if (stmts.length === 0) {
    return { newCode: code };
  }
  const removed = applySpliceEdits(code, BreakpointMarker.removals(code, stmts));
  return { newCode: await BreakpointMarker.releaseImport(removed) };
}
