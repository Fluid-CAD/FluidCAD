// breakpoint() statements: finding, adding, removing, toggling and clearing them.

import { findFluidCadImport, findNamedImports } from './imports.ts';
import { indentOf, isBlankRow, joinLines, splitLines, type CodeEditResult } from './lines.ts';
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

function findBreakpointStatementAt(tree: TSTree, row: number): TSNode | null {
  for (const node of walkTree(tree.rootNode)) {
    if (node.startPosition.row > row) {
      // Trees are ordered; nothing further down can start at our row.
      // (A later sibling deeper than expression_statement won't appear at this row.)
    }
    if (isBreakpointStatement(node) && node.startPosition.row === row) {
      return node;
    }
  }
  return null;
}

function findAllBreakpointStatements(tree: TSTree): TSNode[] {
  const out: TSNode[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (isBreakpointStatement(node)) {
      out.push(node);
    }
  }
  return out;
}

/**
 * Tree-sitter resolution: given a 0-indexed reference row, return the row
 * immediately after the enclosing top-level statement ends.
 *
 * "Top-level" = parent is the program root or a statement_block, so
 * breakpoints inside a function body still land after the enclosing
 * statement within that body.
 */
function findBreakpointInsertLineFromTree(
  tree: TSTree,
  lines: string[],
  referenceRow: number,
): number {
  let row = referenceRow;
  while (row >= 0 && isBlankRow(lines, row)) {
    row--;
  }
  if (row < 0) {
    return referenceRow + 1;
  }

  // Resolve at the first non-blank column: column 0 of an indented statement
  // is leading whitespace, which tree-sitter attributes to the enclosing
  // block — the walk below would then escalate past the statement's own
  // block to the whole enclosing call (e.g. the sketch) instead.
  const column = lines[row].length - lines[row].trimStart().length;
  const node: TSNode | null = tree.rootNode.descendantForPosition({ row, column });
  if (!node || node === tree.rootNode) {
    return referenceRow + 1;
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
    return referenceRow + 1;
  }

  return current.endPosition.row + 1;
}

/**
 * Add `breakpoint` to an existing `import { ... } from 'fluidcad/core'`
 * statement, or insert a new import line at the top. Returns the new code
 * plus how many lines were added at the top (0 or 1).
 */
async function ensureBreakpointImport(code: string): Promise<{ newCode: string; lineShift: number }> {
  const p = await getParser();
  const tree = p.parse(code);
  const importNode = findFluidCadImport(tree);

  if (!importNode) {
    const importLine = `import { breakpoint } from 'fluidcad/core';\n`;
    return { newCode: importLine + code, lineShift: 1 };
  }

  const namedImports = findNamedImports(importNode);
  if (!namedImports) {
    // `import 'fluidcad/core'` (side-effect) or default-only — leave alone.
    return { newCode: code, lineShift: 0 };
  }

  for (const spec of namedImports.namedChildren) {
    if (spec.type !== 'import_specifier') {
      continue;
    }
    const name = spec.childForFieldName('name') ?? spec.namedChild(0);
    if (name && name.text === 'breakpoint') {
      return { newCode: code, lineShift: 0 };
    }
  }

  // Insert immediately after the `{` of the named_imports node.
  const openBraceOffset = namedImports.startIndex + 1;
  const after = code[openBraceOffset];
  const needsSpace = after !== ' ' && after !== '\t' && after !== '\n';
  const insertText = needsSpace ? ' breakpoint,' : 'breakpoint,';
  return {
    newCode: code.slice(0, openBraceOffset) + insertText + code.slice(openBraceOffset),
    lineShift: 0,
  };
}

/**
 * Insert `breakpoint();` into the lines array at `row`. Adds a blank line
 * after if the following line is non-blank. Returns the row where the
 * statement landed.
 */
function insertBreakpointLine(lines: string[], row: number, indent: string): number {
  const breakpointText = `${indent}breakpoint();`;
  if (row >= lines.length) {
    lines.push(breakpointText);
    return lines.length - 1;
  }
  const following = lines[row];
  if (following !== undefined && following.trim() !== '') {
    lines.splice(row, 0, breakpointText, '');
  } else {
    lines.splice(row, 0, breakpointText);
  }
  return row;
}

export async function addBreakpoint(code: string, referenceRow: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const insertLine = findBreakpointInsertLineFromTree(tree, lines, referenceRow);

  if (findBreakpointStatementAt(tree, insertLine)) {
    return { newCode: code, breakpointLine: insertLine };
  }

  const indentRow = Math.max(0, Math.min(insertLine - 1, lines.length - 1));
  const indent = indentOf(lines, indentRow);

  const insertedRow = insertBreakpointLine(lines, insertLine, indent);
  const interim = joinLines(lines);

  const { newCode, lineShift } = await ensureBreakpointImport(interim);
  return { newCode, breakpointLine: insertedRow + lineShift };
}

export async function removeBreakpoint(code: string, line: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const node = findBreakpointStatementAt(tree, line);
  if (!node) {
    return { newCode: code, breakpointLine: null };
  }
  const lines = splitLines(code);
  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  lines.splice(startRow, endRow - startRow + 1);
  return { newCode: joinLines(lines), breakpointLine: null };
}

export async function toggleBreakpoint(code: string, cursorRow: number): Promise<BreakpointEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  if (findBreakpointStatementAt(tree, cursorRow)) {
    return removeBreakpoint(code, cursorRow);
  }
  if (findBreakpointStatementAt(tree, cursorRow + 1)) {
    return removeBreakpoint(code, cursorRow + 1);
  }
  return addBreakpoint(code, cursorRow);
}

export async function clearBreakpoints(code: string): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const stmts = findAllBreakpointStatements(tree);
  if (stmts.length === 0) {
    return { newCode: code };
  }

  const rowsToDelete = new Set<number>();
  for (const s of stmts) {
    for (let r = s.startPosition.row; r <= s.endPosition.row; r++) {
      rowsToDelete.add(r);
    }
  }

  const lines = splitLines(code);
  const filtered = lines.filter((_, i) => !rowsToDelete.has(i));
  return { newCode: joinLines(filtered) };
}
