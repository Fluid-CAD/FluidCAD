// part() bodies: finding the enclosing part and landing parameter declarations inside it.

import { declareTopLevelStatements } from './declarations.ts';
import { indentOf, resolveSourceRow, spliceCode, splitLines } from './lines.ts';
import { chainRootCallee, findEditableCallAt, walkTree } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';
import { findSketchBody } from './statements.ts';

/** A `part()` call and the callback body its statements run in. */
export type PartBody = { call: TSNode; body: TSNode };

/**
 * The `part()` whose callback body spans `row` (0-based) — the part a
 * statement on that row belongs to, and so the part whose body a `param()`
 * that statement reads has to be declared in. Null for a row outside every
 * part body: the file's top level, an assembly body.
 */
export function findEnclosingPart(tree: TSTree, row: number): PartBody | null {
  let best: PartBody | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || chainRootCallee(node) !== 'part') {
      continue;
    }
    const body = findSketchBody(node);
    if (!body || body.startPosition.row > row || body.endPosition.row < row) {
      continue;
    }
    // The innermost body wins; a chain's outer and inner calls share one.
    if (!best || body.startIndex > best.body.startIndex) {
      best = { call: node, body };
    }
  }
  return best;
}

/**
 * The `part()` call starting on `partLine` (1-based, as the render captured
 * the statement) and its callback body, or why there is none — the message
 * every part-addressed edit reports.
 */
export function findPartAt(tree: TSTree, lines: string[], partLine: number): PartBody | { error: string } {
  if (!Number.isInteger(partLine) || partLine < 1) {
    return { error: 'malformed part target: bad part line' };
  }
  const call = findEditableCallAt(tree, lines, partLine);
  if (!call || chainRootCallee(call) !== 'part') {
    return { error: `no part() call found at line ${partLine} — is the file in sync with the last render?` };
  }
  const body = findSketchBody(call);
  if (!body) {
    return { error: 'the part at that line has no callback body to declare the parameter in' };
  }
  return { call, body };
}

/** A `const x = param(…)` / `param(…);` statement — one of a body's leading declaration block. */
function isParamDeclarationStatement(node: TSNode): boolean {
  // Only a statement whose OWN value is the `param()` call counts — a
  // `const x = param(…)` or a bare `param(…)`. A statement that merely
  // contains one deeper down (a sketch body with an inline `param()` in a
  // dimension) is geometry, and a declaration spliced after it would be
  // read before it is initialized.
  if (node.type === 'expression_statement') {
    const expr = node.namedChildren[0];
    return expr !== undefined && isParamCall(expr);
  }
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
    return false;
  }
  return node.namedChildren.some((child) => {
    if (child.type !== 'variable_declarator') {
      return false;
    }
    const value = child.childForFieldName('value');
    return value !== null && isParamCall(value);
  });
}

function isParamCall(node: TSNode): boolean {
  if (node.type !== 'call_expression') {
    return false;
  }
  const fn = node.childForFieldName('function');
  return fn?.type === 'identifier' && fn.text === 'param';
}

/**
 * Put `statements` at the top of a part's callback `body`. Declarations read
 * as a block at the top of the body, so they go after the last of the body's
 * leading `param()` declarations when it has any, and above the first
 * statement otherwise — never at the end, where the features that should
 * read them have already run. An empty body opens up around them, a
 * one-line `{}` included.
 */
export function declareInPartBody(code: string, lines: string[], body: TSNode, statements: string[]): string {
  if (statements.length === 0) {
    return code;
  }
  const existing = body.namedChildren.filter((c) => c.type !== 'comment');
  if (existing.length === 0) {
    const baseIndent = indentOf(lines, body.startPosition.row);
    const indent = baseIndent + '  ';
    const text = statements.join(`\n${indent}`);
    const singleLine = body.startPosition.row === body.endPosition.row;
    const opened = singleLine
      ? `\n${indent}${text}\n${baseIndent}`
      : `\n${indent}${text}`;
    return spliceCode(code, body.startIndex + 1, body.startIndex + 1, opened);
  }
  let lastParam: TSNode | null = null;
  for (const node of existing) {
    if (!isParamDeclarationStatement(node)) {
      break;
    }
    lastParam = node;
  }
  if (lastParam) {
    const indent = indentOf(lines, lastParam.startPosition.row);
    const text = statements.join(`\n${indent}`);
    return spliceCode(code, lastParam.endIndex, lastParam.endIndex, `\n${indent}${text}`);
  }
  const first = existing[0];
  const indent = indentOf(lines, first.startPosition.row);
  const text = statements.join(`\n${indent}`);
  return spliceCode(code, first.startIndex, first.startIndex, `${text}\n${indent}`);
}

/**
 * Declare `param()` variables where a part body reads them. With `partLine`
 * (1-based line of a `part()` statement) they go at the top of that part's
 * callback body ({@link declareInPartBody}); without one — a statement that
 * lives outside every part, in a file that has none — at top level after the
 * imports, the spot `param()` will refuse at render but the only one left.
 * `statements` are rendered `const … = param(…)` lines, in declaration order.
 */
export async function declareParamStatements(
  code: string,
  partLine: number | null,
  statements: string[],
): Promise<{ newCode: string } | { error: string }> {
  if (statements.length === 0) {
    return { newCode: code };
  }
  const p = await getParser();
  const tree = p.parse(code);
  if (partLine === null) {
    return { newCode: declareTopLevelStatements(code, tree, statements) };
  }
  const lines = splitLines(code);
  const part = findPartAt(tree, lines, partLine);
  if ('error' in part) {
    return part;
  }
  return { newCode: declareInPartBody(code, lines, part.body, statements) };
}

/**
 * {@link declareParamStatements} for a caller that knows a statement, not a
 * part: the declarations go into the part body enclosing `statementLine`
 * (1-based) — the sketch a dimension was typed in, the feature a dialog
 * edited — or at top level when no part encloses it.
 */
export async function declareParamStatementsFor(
  code: string,
  statementLine: number,
  statements: string[],
): Promise<string> {
  if (statements.length === 0) {
    return code;
  }
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const row = resolveSourceRow(lines, statementLine);
  const part = row >= 0 ? findEnclosingPart(tree, row) : null;
  if (part) {
    return declareInPartBody(code, lines, part.body, statements);
  }
  return declareTopLevelStatements(code, tree, statements);
}
