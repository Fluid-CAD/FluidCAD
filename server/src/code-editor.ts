import { createRequire } from 'module';

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  descendantForPosition(pos: { row: number; column: number }): TSNode | null;
};

type TSTree = { rootNode: TSNode };

type TSParser = {
  setLanguage(lang: any): void;
  parse(code: string): TSTree;
};

async function loadTreeSitter() {
  const mod = await import('web-tree-sitter');
  // v0.24.x: default export IS the Parser class with .init() and .Language.
  return mod.default as any as {
    init(): Promise<void>;
    new(): TSParser;
    Language: { load(path: string): Promise<any> };
  };
}

let parser: TSParser | null = null;

async function getParser(): Promise<TSParser> {
  if (parser) {
    return parser;
  }
  const TreeSitter = await loadTreeSitter();
  await TreeSitter.init();
  parser = new TreeSitter();
  // Use Node's resolver so the lookup walks up node_modules and finds the
  // wasm regardless of whether npm hoisted `tree-sitter-wasms` next to or
  // below `fluidcad`. The relative-path approach broke when fluidcad was
  // installed from npm.
  const requireFromHere = createRequire(import.meta.url);
  const wasmPath = requireFromHere.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm');
  const lang = await TreeSitter.Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser;
}

export type BreakpointEditResult = { newCode: string; breakpointLine: number | null };
export type CodeEditResult = { newCode: string };

function splitLines(code: string): string[] {
  return code.split('\n');
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function isBlankRow(lines: string[], row: number): boolean {
  const line = lines[row];
  return line === undefined || line.trim() === '';
}

function indentOf(lines: string[], row: number): string {
  if (row < 0 || row >= lines.length) {
    return '';
  }
  const m = lines[row].match(/^(\s*)/);
  return m ? m[1] : '';
}

function* walkTree(node: TSNode): Generator<TSNode> {
  yield node;
  for (const child of node.namedChildren) {
    yield* walkTree(child);
  }
}

/**
 * Resolve a 1-indexed `sourceLine` (captured from a V8 stack trace) to the
 * outermost `call_expression` node whose invocation starts on that row.
 *
 * "Outermost" means: of all call_expression nodes starting on the resolved
 * row, return the one with the largest endIndex. That picks the whole
 * `.pick()` chain for `extrude(sk).pick()` and the only call on the row for
 * the multi-line case
 *   trim(
 *     edge().circle()
 *   )
 * — both match how the old line-based code (which found the last `)` on
 * the line) behaved for the cases it handled.
 *
 * Returns `null` when no call starts on that row, preserving the existing
 * silent-no-op contract of the edit functions.
 */
function findEditableCallAt(tree: TSTree, lines: string[], sourceLine: number): TSNode | null {
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return null;
  }
  let best: TSNode | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    if (node.startPosition.row !== row) {
      continue;
    }
    if (!best || node.endIndex > best.endIndex) {
      best = node;
    }
  }
  return best;
}

function getArgumentsNode(call: TSNode): TSNode | null {
  return call.childForFieldName('arguments');
}

/**
 * If `call` or any call in its `function` chain invokes `.pick(...)`, return
 * the call_expression for that `.pick()` invocation. Centralises the
 * "is this chain already picked?" check for addPick and removePick.
 */
function findPickCallInChain(call: TSNode): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (fn && fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (prop && prop.text === 'pick') {
        return current;
      }
      const object = fn.childForFieldName('object');
      current = object;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Structural AST check: is this node a `[x, y]` point array?
 * Accepts any two-element array regardless of whether the elements are
 * literals, variables, or expressions — the drag/splice functions only need
 * to *locate* point nodes, not read their old values.
 */
function isPointArray(node: TSNode): boolean {
  return node.type === 'array' && node.namedChildren.length === 2;
}

/**
 * Extract `[x, y]` from an `array` node with exactly two numeric children.
 * Only used where the actual numeric values are needed (e.g. `removePoint`
 * distance computation). Drag/update paths use `isPointArray` instead.
 */
function parsePointLiteral(node: TSNode): [number, number] | null {
  if (!isPointArray(node)) {
    return null;
  }
  const parts: number[] = [];
  for (const child of node.namedChildren) {
    const value = parseFloat(child.text);
    if (Number.isNaN(value)) {
      return null;
    }
    parts.push(value);
  }
  return [parts[0], parts[1]];
}

function isPointLikeArg(node: TSNode): boolean {
  if (node.type === 'number') return false;
  if (node.type === 'string' || node.type === 'template_string') return false;
  if (node.type === 'true' || node.type === 'false') return false;
  if (node.type === 'unary_expression' && node.namedChildren[0]?.type === 'number') return false;
  return true;
}

function collectChainPointArgs(call: TSNode): TSNode[] {
  const calls: TSNode[] = [];
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    calls.push(current);
    const fn = current.childForFieldName('function');
    if (fn && fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
    } else {
      break;
    }
  }
  const pointArgs: TSNode[] = [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const args = getArgumentsNode(calls[i]);
    if (args) {
      for (const child of args.namedChildren) {
        if (isPointLikeArg(child)) {
          pointArgs.push(child);
        }
      }
    }
  }
  return pointArgs;
}

function spliceCode(code: string, startIndex: number, endIndex: number, replacement: string): string {
  return code.slice(0, startIndex) + replacement + code.slice(endIndex);
}

/**
 * For point edits (insertPoint / removePoint / setPickPoints), the target is
 * always the `.pick()` call if one exists in the chain — otherwise the
 * outermost call itself. Without this, a chain like
 *   extrude(sk).pick([1, 2]).symmetric([3, 4], [5, 6])
 * would drop new points into `.symmetric(...)` instead of `.pick(...)`,
 * because `findEditableCallAt` picks the outermost (largest endIndex) call.
 * The bezier draw-mode flow has no `.pick()` in its chain, so falling back
 * to the outermost keeps bezier(...) point edits working.
 */
function resolvePointEditTarget(call: TSNode): TSNode {
  return findPickCallInChain(call) ?? call;
}

/**
 * Shared setup for the five AST-based edit functions: parse the code once,
 * split it into lines for `resolveSourceRow`, run the caller's transform,
 * and wrap the result. Returning `null` from `fn` means "no edit" and
 * yields the original code verbatim.
 */
async function withParsedCode(
  code: string,
  fn: (tree: TSTree, lines: string[]) => string | null,
): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const next = fn(tree, lines);
  return { newCode: next ?? code };
}

/**
 * Recognise a `breakpoint();` statement: an expression_statement wrapping a
 * call_expression to the bare identifier `breakpoint` with zero arguments.
 * Comments, conditional expressions, or shadowed identifiers all fall out
 * of this match because the AST disambiguates them for us.
 */
function isBreakpointStatement(node: TSNode): boolean {
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
 * Find a top-level `import { ... } from 'fluidcad'` or `'fluidcad/core'`
 * statement, regardless of whitespace, comments around it, or quote style.
 */
function findFluidCadImport(tree: TSTree): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'import_statement') {
      continue;
    }
    const source = node.childForFieldName('source');
    if (!source) {
      continue;
    }
    // `source.text` includes the surrounding quotes.
    const inner = source.text.slice(1, -1);
    if (inner === 'fluidcad' || inner === 'fluidcad/core') {
      return node;
    }
  }
  return null;
}

function findNamedImports(importNode: TSNode): TSNode | null {
  for (const node of walkTree(importNode)) {
    if (node.type === 'named_imports') {
      return node;
    }
  }
  return null;
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

  const node: TSNode | null = tree.rootNode.descendantForPosition({ row, column: 0 });
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

// ---------------------------------------------------------------------------
// Point / pick edits — AST-driven transformations. `sourceLine` locates the
// outermost call_expression on that row; edits operate on the node's
// startIndex/endIndex so multi-line calls are handled the same as single-line.
// ---------------------------------------------------------------------------

/**
 * Resolve `sourceLine` (1-indexed) to a 0-indexed row containing code.
 * Walks back over blank rows to match the existing extension behaviour.
 */
function resolveSourceRow(lines: string[], sourceLine: number): number {
  let row = sourceLine - 1;
  if (row < 0) {
    return -1;
  }
  if (row >= lines.length) {
    row = lines.length - 1;
  }
  while (row >= 0 && lines[row].trim() === '') {
    row--;
  }
  return row;
}

/**
 * Walk forward from `from` over whitespace; if a `,` follows, consume it
 * and any trailing whitespace. Returns the index up to which to delete
 * when stripping a non-last argument.
 */
function consumeTrailingSeparator(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) {
    i++;
  }
  if (i < code.length && code[i] === ',') {
    i++;
    while (i < code.length && /\s/.test(code[i])) {
      i++;
    }
    return i;
  }
  return from;
}

/**
 * Walk backward from `to` over whitespace; if a `,` precedes, consume it
 * and any preceding whitespace. Returns the index from which to start
 * deleting when stripping a non-first argument.
 */
function consumeLeadingSeparator(code: string, to: number): number {
  let i = to;
  while (i > 0 && /\s/.test(code[i - 1])) {
    i--;
  }
  if (i > 0 && code[i - 1] === ',') {
    i--;
    while (i > 0 && /\s/.test(code[i - 1])) {
      i--;
    }
    return i;
  }
  return to;
}

export function insertPoint(
  code: string,
  sourceLine: number,
  point: [number, number],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const target = resolvePointEditTarget(call);
    const args = getArgumentsNode(target);
    if (!args) {
      return null;
    }
    const pointText = `[${point[0]}, ${point[1]}]`;
    if (args.namedChildren.length === 0) {
      return spliceCode(code, args.startIndex + 1, args.endIndex - 1, pointText);
    }
    return spliceCode(code, args.endIndex - 1, args.endIndex - 1, `, ${pointText}`);
  });
}

export function addPick(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call || findPickCallInChain(call)) {
      return null;
    }
    return spliceCode(code, call.endIndex, call.endIndex, '.pick()');
  });
}

/**
 * Remove an empty `.pick()` call from the chain on the resolved row.
 * Calls with points are left untouched so concurrent/stale edits cannot
 * discard user data.
 */
export function removePick(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const pickCall = findPickCallInChain(call);
    if (!pickCall) {
      return null;
    }
    const pickArgs = getArgumentsNode(pickCall);
    if (!pickArgs || pickArgs.namedChildren.length !== 0) {
      return null;
    }
    const member = pickCall.childForFieldName('function');
    const object = member ? member.childForFieldName('object') : null;
    if (!object) {
      return null;
    }
    return spliceCode(code, object.endIndex, pickCall.endIndex, '');
  });
}

export function removePoint(
  code: string,
  sourceLine: number,
  point: [number, number],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const target = resolvePointEditTarget(call);
    const args = getArgumentsNode(target);
    if (!args || args.namedChildren.length === 0) {
      return null;
    }

    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < args.namedChildren.length; i++) {
      const parsed = parsePointLiteral(args.namedChildren[i]);
      if (!parsed) {
        continue;
      }
      const dx = parsed[0] - point[0];
      const dy = parsed[1] - point[1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) {
      return null;
    }

    const pointNode = args.namedChildren[bestIndex];
    let deleteStart = pointNode.startIndex;
    let deleteEnd = pointNode.endIndex;

    if (args.namedChildren.length > 1) {
      if (bestIndex === 0) {
        deleteEnd = consumeTrailingSeparator(code, deleteEnd);
      } else {
        deleteStart = consumeLeadingSeparator(code, deleteStart);
      }
    }

    return spliceCode(code, deleteStart, deleteEnd, '');
  });
}

export function setPickPoints(
  code: string,
  sourceLine: number,
  points: [number, number][],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const target = resolvePointEditTarget(call);
    const args = getArgumentsNode(target);
    if (!args) {
      return null;
    }
    const newArgs = points.map((p) => `[${p[0]}, ${p[1]}]`).join(', ');
    return spliceCode(code, args.startIndex + 1, args.endIndex - 1, newArgs);
  });
}

// ---------------------------------------------------------------------------
// Geometry insertion — insert a new call expression at the end of a sketch body
// ---------------------------------------------------------------------------

/**
 * Find the callback body (statement_block) inside a sketch() call.
 * Looks for the last arrow_function or function argument.
 */
function findSketchBody(call: TSNode): TSNode | null {
  const args = getArgumentsNode(call);
  if (!args) {
    return null;
  }
  for (let i = args.namedChildren.length - 1; i >= 0; i--) {
    const child = args.namedChildren[i];
    if (child.type === 'arrow_function' || child.type === 'function') {
      const body = child.childForFieldName('body');
      if (body && body.type === 'statement_block') {
        return body;
      }
    }
  }
  return null;
}

/**
 * Ensure a symbol is present in the `import { ... } from 'fluidcad'` or
 * `'fluidcad/core'` statement. Returns modified code if the symbol was added.
 */
async function ensureSymbolImport(code: string, symbol: string): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const importNode = findFluidCadImport(tree);
  if (!importNode) {
    return `import { ${symbol} } from 'fluidcad/core';\n` + code;
  }
  const namedImports = findNamedImports(importNode);
  if (!namedImports) {
    return code;
  }
  for (const spec of namedImports.namedChildren) {
    if (spec.type !== 'import_specifier') {
      continue;
    }
    const name = spec.childForFieldName('name') ?? spec.namedChild(0);
    if (name && name.text === symbol) {
      return code;
    }
  }
  const openBraceOffset = namedImports.startIndex + 1;
  const after = code[openBraceOffset];
  const needsSpace = after !== ' ' && after !== '\t' && after !== '\n';
  const insertText = needsSpace ? ` ${symbol},` : `${symbol},`;
  return code.slice(0, openBraceOffset) + insertText + code.slice(openBraceOffset);
}

/**
 * Insert a new geometry call expression at the end of a sketch's callback body.
 *
 * @param code - Full source code
 * @param sketchSourceLine - 1-indexed line where the sketch() call starts
 * @param statement - The call to insert, e.g. "line([5, 10], [20, 30])"
 */
export async function insertGeometryCall(
  code: string,
  sketchSourceLine: number,
  statement: string,
): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sketchSourceLine);
  if (!call) {
    return { newCode: code };
  }

  const body = findSketchBody(call);
  if (!body) {
    return { newCode: code };
  }

  const bodyChildren = body.namedChildren;
  let insertRow: number;
  let indent: string;

  if (bodyChildren.length > 0) {
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    insertRow = lastStmt.endPosition.row + 1;
    indent = indentOf(lines, lastStmt.startPosition.row);
  } else {
    insertRow = body.startPosition.row + 1;
    indent = indentOf(lines, body.startPosition.row) + '  ';
  }

  const newLine = statement.split('\n').map(l => `${indent}${l}`).join('\n');
  lines.splice(insertRow, 0, newLine);
  let result = joinLines(lines);

  const funcName = statement.match(/^(\w+)\s*\(/)?.[1];
  if (funcName) {
    result = await ensureSymbolImport(result, funcName);
  }

  return { newCode: result };
}

/**
 * Update a point argument of a geometry call.
 *
 * @param code - Full source code
 * @param sourceLine - 1-indexed line of the geometry call
 * @param newPosition - New [x, y] position
 * @param pointIndex - Which point argument to update (0 = first, -1 = last)
 */
export async function updateGeometryPosition(
  code: string,
  sourceLine: number,
  newPosition: [number, number],
  pointIndex: number = 0,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const pointText = `[${newPosition[0]}, ${newPosition[1]}]`;

    const pointArgs = collectChainPointArgs(call);

    const targetIdx = pointIndex >= 0 ? pointIndex : pointArgs.length + pointIndex;

    if (targetIdx >= 0 && targetIdx < pointArgs.length) {
      return spliceCode(code, pointArgs[targetIdx].startIndex, pointArgs[targetIdx].endIndex, pointText);
    }

    if (pointIndex === 0 && pointArgs.length === 0) {
      const args = getArgumentsNode(call);
      if (!args) {
        return null;
      }
      const firstArg = args.namedChildren[0];
      if (!firstArg) {
        return spliceCode(code, args.startIndex + 1, args.startIndex + 1, pointText);
      }
      return spliceCode(code, args.startIndex + 1, args.startIndex + 1, pointText + ', ');
    }

    return null;
  });
}

/**
 * Update both point arguments of a `line(start, end)` call atomically.
 * Used by body-drag of unconstrained two-point lines, where the whole line
 * is translated and both endpoints change in a single edit.
 */
export async function setLinePosition(
  code: string,
  sourceLine: number,
  newStart: [number, number],
  newEnd: [number, number],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const args = getArgumentsNode(call);
    if (!args) {
      return null;
    }
    const pointArgs: TSNode[] = [];
    for (const child of args.namedChildren) {
      if (isPointArray(child)) {
        pointArgs.push(child);
      }
    }
    if (pointArgs.length < 2) {
      return null;
    }
    const startNode = pointArgs[0];
    const endNode = pointArgs[pointArgs.length - 1];
    const startText = `[${newStart[0]}, ${newStart[1]}]`;
    const endText = `[${newEnd[0]}, ${newEnd[1]}]`;
    // Splice end first so startNode indices remain valid.
    const afterEnd = spliceCode(code, endNode.startIndex, endNode.endIndex, endText);
    return spliceCode(afterEnd, startNode.startIndex, startNode.endIndex, startText);
  });
}

/**
 * Update multiple point arguments of a geometry call chain atomically.
 * Point indices refer to the collected chain points (innermost call first).
 */
export async function setChainPositions(
  code: string,
  sourceLine: number,
  updates: { pointIndex: number; position: [number, number] }[],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const pointArgs = collectChainPointArgs(call);
    if (pointArgs.length === 0) {
      return null;
    }

    const resolved = updates
      .map(u => {
        const idx = u.pointIndex >= 0 ? u.pointIndex : pointArgs.length + u.pointIndex;
        if (idx < 0 || idx >= pointArgs.length) {
          return null;
        }
        return { node: pointArgs[idx], position: u.position };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null)
      .sort((a, b) => b.node.startIndex - a.node.startIndex);

    let result = code;
    for (const { node, position } of resolved) {
      const text = `[${position[0]}, ${position[1]}]`;
      result = spliceCode(result, node.startIndex, node.endIndex, text);
    }
    return result;
  });
}

/**
 * Update the last non-array argument of a geometry call (e.g. distance or diameter).
 * Replaces whatever expression is there (literal, variable, binary expression)
 * with the new numeric literal.
 */
export function updateDimension(
  code: string,
  sourceLine: number,
  newValue: number,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const args = getArgumentsNode(call);
    if (!args || args.namedChildren.length === 0) {
      return null;
    }
    const target = findLastNonArrayArg(args);
    if (!target) {
      return null;
    }
    return spliceCode(code, target.startIndex, target.endIndex, String(newValue));
  });
}

// ---------------------------------------------------------------------------
// Expression-aware dimension helpers
// ---------------------------------------------------------------------------

function findLastNonArrayArg(args: TSNode): TSNode | null {
  for (let i = args.namedChildren.length - 1; i >= 0; i--) {
    const child = args.namedChildren[i];
    if (child.type !== 'array') {
      return child;
    }
  }
  return null;
}

export async function getDimensionExpression(
  code: string,
  sourceLine: number,
): Promise<{ expression: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sourceLine);
  if (!call) {
    return null;
  }
  const args = getArgumentsNode(call);
  if (!args || args.namedChildren.length === 0) {
    return null;
  }
  const target = findLastNonArrayArg(args);
  if (!target) {
    return null;
  }
  return { expression: target.text };
}

export function updateDimensionExpression(
  code: string,
  sourceLine: number,
  expression: string,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const args = getArgumentsNode(call);
    if (!args || args.namedChildren.length === 0) {
      return null;
    }
    const target = findLastNonArrayArg(args);
    if (!target) {
      return null;
    }
    return spliceCode(code, target.startIndex, target.endIndex, expression);
  });
}

/**
 * Insert `const name = initializer;` at the top of the sketch arrow-function
 * body. Returns the new code and how many lines were added (for callers that
 * need to re-anchor subsequent sourceLine-based edits).
 */
export async function declareSketchVariable(
  code: string,
  sketchSourceLine: number,
  name: string,
  initializer: string,
): Promise<{ newCode: string; linesAdded: number } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sketchSourceLine);
  if (!call) {
    return null;
  }
  const body = findSketchBody(call);
  if (!body) {
    return null;
  }

  const bodyChildren = body.namedChildren;
  const insertRow = body.startPosition.row + 1;
  let indent: string;
  if (bodyChildren.length > 0) {
    indent = indentOf(lines, bodyChildren[0].startPosition.row);
  } else {
    indent = indentOf(lines, body.startPosition.row) + '  ';
  }

  const newLine = `${indent}const ${name} = ${initializer};`;
  lines.splice(insertRow, 0, newLine);
  return { newCode: joinLines(lines), linesAdded: 1 };
}

/**
 * Run an edit that may be preceded by inserting `const name = init;` at the
 * top of the sketch body. The edit receives the (possibly-mutated) code and
 * the number of lines added by the declaration, so it can re-anchor any
 * sourceLine references inside the body.
 *
 * Adopt this wrapper for any new code-edit endpoint that should support
 * "declare a variable on the same commit."
 */
async function withOptionalVariableDeclaration(
  code: string,
  sketchSourceLine: number,
  newVariable: { name: string; initializer: string } | null,
  edit: (code: string, lineShift: number) => Promise<CodeEditResult>,
): Promise<CodeEditResult> {
  if (!newVariable) {
    return edit(code, 0);
  }
  const declared = await declareSketchVariable(
    code, sketchSourceLine, newVariable.name, newVariable.initializer,
  );
  if (!declared) {
    return { newCode: code };
  }
  return edit(declared.newCode, declared.linesAdded);
}

export function insertGeometryCallWithVariable(
  code: string,
  sketchSourceLine: number,
  statement: string,
  newVariable: { name: string; initializer: string } | null,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c) => insertGeometryCall(c, sketchSourceLine, statement));
}

export function updateDimensionExpressionWithVariable(
  code: string,
  sourceLine: number,
  expression: string,
  sketchSourceLine: number,
  newVariable: { name: string; initializer: string } | null,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c, shift) => updateDimensionExpression(c, sourceLine + shift, expression));
}

export type VariableInfo = { name: string; initializer?: string };

export async function extractVariablesInScope(
  code: string,
  sketchSourceLine: number,
): Promise<VariableInfo[]> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const sketchRow = resolveSourceRow(lines, sketchSourceLine);
  if (sketchRow < 0) {
    return [];
  }

  const variables: VariableInfo[] = [];
  const seen = new Set<string>();

  function addVar(name: string, initializer?: string) {
    if (!seen.has(name)) {
      seen.add(name);
      variables.push({ name, initializer });
    }
  }

  function collectDeclarators(node: TSNode) {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        if (nameNode && nameNode.type === 'identifier') {
          const init = valueNode ? valueNode.text : undefined;
          addVar(nameNode.text, init);
        }
      }
    }
  }

  const FLUIDCAD_SOURCES = ['fluidcad', 'fluidcad/core', "'fluidcad'", "'fluidcad/core'", '"fluidcad"', '"fluidcad/core"'];

  for (const node of tree.rootNode.namedChildren) {
    if (node.startPosition.row > sketchRow) {
      break;
    }

    if (node.type === 'import_statement') {
      const source = node.childForFieldName('source');
      if (source && FLUIDCAD_SOURCES.some(s => source.text.includes(s.replace(/['"]/g, '')))) {
        continue;
      }
      for (const child of node.namedChildren) {
        if (child.type === 'import_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type === 'import_specifier' || spec.type === 'identifier') {
              const nameNode = spec.type === 'import_specifier'
                ? spec.childForFieldName('name') || spec.namedChildren[0]
                : spec;
              if (nameNode) {
                addVar(nameNode.text);
              }
            } else if (spec.type === 'named_imports') {
              for (const imp of spec.namedChildren) {
                if (imp.type === 'import_specifier') {
                  const alias = imp.childForFieldName('alias');
                  const nameN = alias || imp.childForFieldName('name') || imp.namedChildren[0];
                  if (nameN) {
                    addVar(nameN.text);
                  }
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      collectDeclarators(node);
      continue;
    }

    if (node.type === 'export_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
          collectDeclarators(child);
        }
      }
    }
  }

  const sketchCall = findEditableCallAt(tree, lines, sketchSourceLine);
  if (sketchCall) {
    const body = findSketchBody(sketchCall);
    if (body) {
      for (const stmt of body.namedChildren) {
        if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
          collectDeclarators(stmt);
        }
      }
    }
  }

  return variables;
}

export function setRectDimensions(
  code: string,
  sourceLine: number,
  startPoint: [number, number] | null,
  width: number,
  height: number,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const outerCall = findEditableCallAt(tree, lines, sourceLine);
    if (!outerCall) {
      return null;
    }

    let rectCall: TSNode | null = null;
    let current: TSNode | null = outerCall;
    while (current && current.type === 'call_expression') {
      const fn = current.childForFieldName('function');
      if (fn) {
        if (fn.type === 'identifier' && fn.text === 'rect') {
          rectCall = current;
          break;
        }
        if (fn.type === 'member_expression') {
          current = fn.childForFieldName('object');
          continue;
        }
      }
      break;
    }

    if (!rectCall) {
      return null;
    }

    const args = getArgumentsNode(rectCall);
    if (!args || args.namedChildren.length < 2) {
      return null;
    }

    const pointArgs: TSNode[] = [];
    const numericArgs: TSNode[] = [];
    for (const child of args.namedChildren) {
      if (isPointArray(child)) {
        pointArgs.push(child);
      } else {
        numericArgs.push(child);
      }
    }

    if (numericArgs.length < 2) {
      return null;
    }

    type Edit = { start: number; end: number; text: string };
    const edits: Edit[] = [];

    edits.push({ start: numericArgs[1].startIndex, end: numericArgs[1].endIndex, text: String(height) });
    edits.push({ start: numericArgs[0].startIndex, end: numericArgs[0].endIndex, text: String(width) });

    if (startPoint && pointArgs.length > 0) {
      const pointText = `[${startPoint[0]}, ${startPoint[1]}]`;
      edits.push({ start: pointArgs[0].startIndex, end: pointArgs[0].endIndex, text: pointText });
    }

    edits.sort((a, b) => b.start - a.start);

    let result = code;
    for (const edit of edits) {
      result = spliceCode(result, edit.start, edit.end, edit.text);
    }

    return result;
  });
}
