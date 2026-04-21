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
 * Extract `[x, y]` from an `array` node with exactly two numeric children.
 * Handles unary minus (`-5`) because tree-sitter wraps it in a `unary_expression`.
 */
function parsePointLiteral(node: TSNode): [number, number] | null {
  if (node.type !== 'array' || node.namedChildren.length !== 2) {
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
