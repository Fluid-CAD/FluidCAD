// Model bodies: finding the enclosing part and landing parameter declarations.

import { assemblyBodies } from './assembly.ts';

import { declareTopLevelStatements } from './declarations.ts';
import { indentOf, isBlankRow, resolveSourceRow, spliceCode, splitLines, type SpliceEdit } from './lines.ts';
import { chainRootCallee, findEditableCallAt, stringLiteralValue, walkTree } from './nodes.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';
import { findSketchBody, statementRemovalEdit } from './statements.ts';

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
 * Whether a new variable's initializer is a part-level declaration — a
 * `param()` or a `property()` call — which lands in the part body it
 * belongs to ({@link landInPartBody}) rather than beside the statement.
 */
export function isPartLevelInitializer(initializer: string): boolean {
  return /\b(?:param|property)\s*\(/.test(initializer);
}

/** The `fluidcad/core` symbols the rendered declaration `statements` call: `param`, `property`. */
export function declarationImports(statements: string[]): ('param' | 'property')[] {
  const symbols: ('param' | 'property')[] = [];
  if (statements.some((s) => /\bparam\s*\(/.test(s))) {
    symbols.push('param');
  }
  if (statements.some((s) => /\bproperty\s*\(/.test(s))) {
    symbols.push('property');
  }
  return symbols;
}

/** A `property('Label', 'name', value);` statement of a part body that binds no variable. */
export type BareProperty = { statement: TSNode; call: TSNode; name: string; value: TSNode | null };

/**
 * The `property()` declarations `body` publishes without binding a
 * variable — each a statement of its own, the way the Parameters panel
 * writes them. Only one whose name is a string literal is addressable.
 */
export function bareProperties(body: TSNode): BareProperty[] {
  const found: BareProperty[] = [];
  for (const statement of body.namedChildren) {
    if (statement.type !== 'expression_statement') {
      continue;
    }
    const call = statement.namedChildren[0];
    const fn = call?.childForFieldName('function');
    if (!call || call.type !== 'call_expression' || fn?.type !== 'identifier' || fn.text !== 'property') {
      continue;
    }
    const args = call.childForFieldName('arguments');
    const key = args?.namedChild(1);
    const name = key ? stringLiteralValue(key) : null;
    if (!args || name === null) {
      continue;
    }
    found.push({ statement, call, name, value: args.namedChild(2) });
  }
  return found;
}

/** The names an expression reads — every identifier in it, `Math` included. */
export function freeIdentifiers(node: TSNode): Set<string> {
  const names = new Set<string>();
  for (const child of walkTree(node)) {
    if (child.type === 'identifier') {
      names.add(child.text);
    }
  }
  return names;
}

/** Whether a declaration statement binds one of `names`. */
function declaresAnyOf(node: TSNode, names: Set<string>): boolean {
  if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
    return false;
  }
  return node.namedChildren.some((child) => {
    const name = child.type === 'variable_declarator' ? child.childForFieldName('name') : null;
    return name?.type === 'identifier' && names.has(name.text);
  });
}

const PROPERTY_BIND_RE = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*property\s*\(/;

/**
 * A statement lifted out of its place to be put down elsewhere: the edit
 * that takes it out, and the text that goes back in. One alone on its
 * lines takes them whole — a comment trailing it on the last line
 * included, and one blank line of the two it would leave touching, as
 * {@link statementRemovalEdit} does; one sharing a line with other code
 * travels on its own.
 */
function statementMove(code: string, lines: string[], statement: TSNode): { removal: SpliceEdit; moved: string } {
  const { row: startRow, column } = statement.startPosition;
  const { row: endRow, column: endColumn } = statement.endPosition;
  const trailing = lines[endRow].slice(endColumn).trim();
  const wholeLines = lines[startRow].slice(0, column).trim() === ''
    && (trailing === '' || trailing.startsWith('//'));
  if (!wholeLines) {
    return { removal: { start: statement.startIndex, end: statement.endIndex, text: '' }, moved: statement.text };
  }
  const moved = [lines[startRow].slice(column), ...lines.slice(startRow + 1, endRow + 1)].join('\n');
  if (trailing === '') {
    return { removal: statementRemovalEdit(code, lines, statement), moved };
  }
  const offsets: number[] = [0];
  for (const line of lines) {
    offsets.push(offsets[offsets.length - 1] + line.length + 1);
  }
  const collapse = startRow > 0 && isBlankRow(lines, startRow - 1)
    && endRow + 1 < lines.length && isBlankRow(lines, endRow + 1);
  const lastRow = collapse ? endRow + 1 : endRow;
  const start = lastRow + 1 < lines.length ? offsets[startRow] : Math.max(offsets[startRow] - 1, 0);
  const end = lastRow + 1 < lines.length ? offsets[lastRow + 1] : code.length;
  return { removal: { start, end, text: '' }, moved };
}

/**
 * Bind the property `statement` names (`const <name> = property(…)`) in
 * `body`: an expression field's first use of a `property()` the body
 * publishes as a bare statement. That statement is the declaration — it
 * keeps its label, its value and any comment on its line — so it takes
 * the `const <name> =` and moves to where the body can read it: after
 * the leading `param()` block, and after the last declaration its value
 * reads, whichever is later; above the first statement when there is
 * neither. Already there, it is prefixed in place. A name the body
 * publishes no bare property for declares a new one, landed like a
 * `param()`.
 */
function bindPropertyInBody(code: string, lines: string[], body: TSNode, statement: string): string {
  const name = PROPERTY_BIND_RE.exec(statement)?.[1];
  const bare = name === undefined ? null : bareProperties(body).find((p) => p.name === name) ?? null;
  if (!bare) {
    return declareInPartBody(code, lines, body, [statement]);
  }
  const others = body.namedChildren.filter(
    (c) => c.type !== 'comment' && c.startIndex !== bare.statement.startIndex,
  );
  let anchor: TSNode | null = null;
  for (const node of others) {
    if (!isParamDeclarationStatement(node)) {
      break;
    }
    anchor = node;
  }
  const reads = bare.value ? freeIdentifiers(bare.value) : new Set<string>();
  for (const node of others) {
    if (declaresAnyOf(node, reads) && (!anchor || node.endIndex > anchor.endIndex)) {
      anchor = node;
    }
  }
  const prefix = `const ${bare.name} = `;
  // Already right after the anchor (or first, with none) and ahead of
  // every other statement: nothing moves.
  const next = anchor ? others.find((n) => n.startIndex > anchor.endIndex) ?? null : others[0] ?? null;
  const inPlace = (anchor === null || bare.statement.startIndex > anchor.endIndex)
    && (next === null || next.startIndex > bare.statement.startIndex);
  if (inPlace) {
    return spliceCode(code, bare.statement.startIndex, bare.statement.startIndex, prefix);
  }

  const { removal, moved } = statementMove(code, lines, bare.statement);
  const text = prefix + moved;
  let at: number;
  let insertion: string;
  if (anchor) {
    at = anchor.endIndex;
    insertion = `\n${indentOf(lines, anchor.startPosition.row)}${text}`;
  } else {
    at = others[0].startIndex;
    insertion = `${text}\n${indentOf(lines, others[0].startPosition.row)}`;
  }
  const removed = spliceCode(code, removal.start, removal.end, '');
  if (at >= removal.end) {
    at -= removal.end - removal.start;
  }
  return spliceCode(removed, at, at, insertion);
}

/**
 * Land declaration `statements` in the part body `locate` finds: the
 * `const <name> = property(…)` ones bind a property the body publishes
 * ({@link bindPropertyInBody}), each over a fresh parse since a bind moves
 * text; the rest — `param()` declarations — go at the top of the body
 * ({@link declareInPartBody}). A body `locate` no longer finds leaves the
 * code as it stands.
 */
async function landInPartBody(
  code: string,
  locate: (tree: TSTree, lines: string[]) => TSNode | null,
  statements: string[],
): Promise<string> {
  const binds = statements.filter((s) => PROPERTY_BIND_RE.test(s));
  const rest = statements.filter((s) => !PROPERTY_BIND_RE.test(s));
  const p = await getParser();
  let working = code;
  for (const bind of binds) {
    const lines = splitLines(working);
    const body = locate(p.parse(working), lines);
    if (!body) {
      return working;
    }
    working = bindPropertyInBody(working, lines, body, bind);
  }
  if (rest.length > 0) {
    const lines = splitLines(working);
    const body = locate(p.parse(working), lines);
    if (body) {
      working = declareInPartBody(working, lines, body, rest);
    }
  }
  return working;
}

/**
 * Declare `param()` variables where a part body reads them. With `partLine`
 * (1-based line of a `part()` statement) they go at the top of that part's
 * callback body ({@link declareInPartBody}); without one — a statement that
 * lives outside every part, in a file that has none — at top level after the
 * imports, the spot `param()` will refuse at render but the only one left.
 * `statements` are rendered `const … = param(…)` lines, in declaration order;
 * a `const … = property(…)` among them binds the body's bare property of
 * that name instead ({@link bindPropertyInBody}).
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
  const part = findPartAt(tree, splitLines(code), partLine);
  if ('error' in part) {
    return part;
  }
  // The part's line holds through every landing: each one edits its body.
  const locate = (t: TSTree, lines: string[]): TSNode | null => {
    const found = findPartAt(t, lines, partLine);
    return 'error' in found ? null : found.body;
  };
  return { newCode: await landInPartBody(code, locate, statements) };
}

/**
 * {@link declareParamStatements} for a caller that knows a statement, not a
 * part: the declarations go into the part body enclosing `statementLine`
 * (1-based) — the sketch a dimension was typed in, the feature a dialog
 * edited — or its enclosing assembly body. Top-level fallback serves legacy callers.
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
    // A bind moves a line of the body, but never the statement out of it:
    // the row stays inside the same body, which is all the locator reads.
    return landInPartBody(code, (t) => findEnclosingPart(t, row)?.body ?? null, statements);
  }
  const assemblyBody = assemblyBodies(tree.rootNode)
    .filter(body => body.startPosition.row <= row && body.endPosition.row >= row)
    .sort((a, b) => b.startIndex - a.startIndex)[0];
  if (assemblyBody) {
    return declareInPartBody(code, lines, assemblyBody, statements);
  }
  return declareTopLevelStatements(code, tree, statements);
}
