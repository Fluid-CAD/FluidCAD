import path from 'path';
import { DERIVED_OP_CALLEES, SOLVED_CONSTRAINT_KINDS } from './sketch-symbols.ts';
import { parseProjectUnit } from './project-config.ts';
import { ASSEMBLY_UNIT_MESSAGE, unknownUnitMessage } from './unit-lint.ts';

export type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  parent: TSNode | null;
  previousNamedSibling: TSNode | null;
  namedChildren: TSNode[];
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  descendantForPosition(pos: { row: number; column: number }): TSNode | null;
};

export type TSTree = { rootNode: TSNode };

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

/**
 * Public alias for `getParser()` so other modules in this package (e.g.
 * `lint-fluid-js.ts`) can reuse the same wasm-backed parser instance instead
 * of loading the JavaScript grammar twice.
 */
export async function getJavaScriptParser(): Promise<TSParser> {
  return getParser();
}

/**
 * Whether `text` is safe to embed as a single call argument: one line, no
 * statement separators or comments, balanced brackets, and no top-level
 * comma or assignment that would change the argument list's shape.
 */
export function isExpressionText(text: unknown): text is string {
  if (typeof text !== 'string') {
    return false;
  }
  const t = text.trim();
  if (!t || t.length > 200 || /[;\r\n`]/.test(t) || t.includes('//') || t.includes('/*')) {
    return false;
  }
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quote !== null) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const open = stack.pop();
      if ((ch === ')' && open !== '(') || (ch === ']' && open !== '[') || (ch === '}' && open !== '{')) {
        return false;
      }
    } else if (stack.length === 0) {
      if (ch === ',') {
        return false;
      }
      // A top-level assignment would leak a statement into the argument;
      // comparison (`==`, `<=`, `>=`, `!=`) and arrows are fine.
      if (ch === '=' && t[i + 1] !== '=' && t[i + 1] !== '>' && !/[=!<>]/.test(t[i - 1] ?? '')) {
        return false;
      }
    }
  }
  return quote === null && stack.length === 0;
}


async function getParser(): Promise<TSParser> {
  if (parser) {
    return parser;
  }
  const TreeSitter = await loadTreeSitter();
  await TreeSitter.init();
  const fresh = new TreeSitter();
  // The JavaScript grammar is vendored in this package (`server/vendor/`)
  // rather than pulled from `tree-sitter-wasms`, which ships 50 MB of grammars
  // for every language to deliver the one file we load. Resolving it against
  // our own directory — the same trick `UI_DIST` uses in `index.ts` — works
  // from `server/src` (the --experimental-transform-types dev path) and from
  // `server/dist` (the packaged build) alike, since both sit one level under
  // `server/`. This must not regress to a lookup that depends on where npm
  // hoisted a dependency: that is what broke the earlier relative-path
  // approach when fluidcad was installed from npm.
  const wasmPath = path.resolve(import.meta.dirname, '../vendor/tree-sitter-javascript.wasm');
  const lang = await TreeSitter.Language.load(wasmPath);
  fresh.setLanguage(lang);
  // Cache only after the language is attached: a parser cached mid-init would
  // make every later parse() throw an opaque "Parsing failed" instead of the
  // load error that actually broke it.
  parser = fresh;
  return parser;
}

export type BreakpointEditResult = { newCode: string; breakpointLine: number | null };
export type CodeEditResult = { newCode: string };

export function splitLines(code: string): string[] {
  return code.split('\n');
}

export function joinLines(lines: string[]): string {
  return lines.join('\n');
}

export function isBlankRow(lines: string[], row: number): boolean {
  const line = lines[row];
  return line === undefined || line.trim() === '';
}

export function indentOf(lines: string[], row: number): string {
  if (row < 0 || row >= lines.length) {
    return '';
  }
  const m = lines[row].match(/^(\s*)/);
  return m ? m[1] : '';
}

export function* walkTree(node: TSNode): Generator<TSNode> {
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
 *   fillet(4,
 *     edge().circle()
 *   )
 * — both match how the old line-based code (which found the last `)` on
 * the line) behaved for the cases it handled.
 *
 * Returns `null` when no call starts on that row, preserving the existing
 * silent-no-op contract of the edit functions.
 */
export function findEditableCallAt(tree: TSTree, lines: string[], sourceLine: number): TSNode | null {
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
 * If `call` or any call in its `function` chain invokes `.<memberName>(...)`,
 * return the call_expression for that invocation.
 */
function findMemberCallInChain(call: TSNode, memberName: string): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (fn && fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (prop && prop.text === memberName) {
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
 * If `call` or any call in its `function` chain invokes `.pick(...)`, return
 * the call_expression for that `.pick()` invocation. Centralises the
 * "is this chain already picked?" check for addPick and removePick.
 */
function findPickCallInChain(call: TSNode): TSNode | null {
  return findMemberCallInChain(call, 'pick');
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

/**
 * An `[x, y]` array literal — the only point form with per-axis source text.
 * `isPointLikeArg` deliberately also accepts identifiers and lazy accessors,
 * which the expression editor must refuse rather than clobber.
 */
function isPointLiteral(node: TSNode): boolean {
  return node.type === 'array' && node.namedChildren.length === 2;
}

/** The Nth chain point argument, when it is an editable `[x, y]` literal. */
function pointLiteralAt(call: TSNode, pointIndex: number): TSNode | null {
  const pointArgs = collectChainPointArgs(call);
  const idx = pointIndex >= 0 ? pointIndex : pointArgs.length + pointIndex;
  if (idx < 0 || idx >= pointArgs.length) {
    return null;
  }
  const node = pointArgs[idx];
  return isPointLiteral(node) ? node : null;
}

/**
 * The innermost call of a member chain — the geometry call that owns the
 * point argument. A missing point must be inserted there: for
 * `rect(16, 166).centered('horizontal')` the start point belongs to
 * `rect(...)`, not to the chained modifier the line's outermost call is.
 */
function chainBaseCall(call: TSNode): TSNode {
  let current = call;
  while (current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    const object = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    if (object && object.type === 'call_expression') {
      current = object;
    } else {
      break;
    }
  }
  return current;
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

export function spliceCode(code: string, startIndex: number, endIndex: number, replacement: string): string {
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
 * Recognise a `unit('in');` statement: an expression_statement wrapping a
 * call to the bare identifier `unit` with exactly one string-literal
 * argument. The literal form is the only legal one (a document's unit must
 * be readable without running the file), so a `unit(someVar)` is not a unit
 * statement here — the lint reports it instead.
 */
export function isUnitStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'unit') {
    return false;
  }
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length !== 1) {
    return false;
  }
  return args.namedChildren[0].type === 'string';
}

/** The literal a unit statement declares (`unit('in')` → `in`), quotes stripped. */
export function unitStatementLiteral(node: TSNode): string {
  const literal = node.namedChild(0)!.childForFieldName('arguments')!.namedChildren[0];
  return literal.text.slice(1, -1);
}

/** The file's first top-level unit statement, if any. */
export function findTopLevelUnitStatement(tree: TSTree): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (isUnitStatement(node)) {
      return node;
    }
  }
  return null;
}

export type UnitStatement = {
  /** The declared literal, verbatim — validation is the lint's job. */
  unit: string;
  /** Zero-based row the statement starts on. */
  row: number;
  startIndex: number;
  endIndex: number;
};

/**
 * Read a file's `unit('…')` declaration without executing it — the first
 * top-level one, which is the only one the runtime accepts. Null when the
 * file declares none (an mm document, or one on the project unit).
 */
export async function readUnitStatement(code: string): Promise<UnitStatement | null> {
  const p = await getParser();
  const node = findTopLevelUnitStatement(p.parse(code));
  if (!node) {
    return null;
  }
  return {
    unit: unitStatementLiteral(node),
    row: node.startPosition.row,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
  };
}

/** The set-unit transform can refuse (assembly file, unknown unit) — the
 * refusal rides `error` beside the untouched code, like apply-feature. */
export type SetUnitResult = CodeEditResult & { error?: string };

/**
 * Make a part file declare `unit('<unit>')` — the literal only, never the
 * numbers (a document's numbers ARE its unit; docs/unit-system-plan.md §2).
 * An existing top-level statement has its literal replaced in place, so
 * comments and quote style around it survive; a file without one gets
 * `unit('…');` directly after its last import — the spot
 * `findTopLevelDeclarationAnchor` treats as the unit's home, above any
 * `param()` declarations — and `unit` added to the core import. `filePath`,
 * when given, refuses assembly files: their lengths are in the project unit
 * and the runtime would reject the statement anyway.
 *
 * `unit: null` un-declares instead — the chip's "Same as project" pick: the
 * statement's line goes, and `unit` leaves the core import when nothing
 * else in the file uses the identifier (see `clearDocumentUnit`).
 */
export async function setDocumentUnit(code: string, unit: string | null, filePath?: string): Promise<SetUnitResult> {
  if (typeof filePath === 'string' && /\.assembly\.js$/i.test(filePath)) {
    return { newCode: code, error: ASSEMBLY_UNIT_MESSAGE };
  }
  if (unit === null) {
    return { newCode: await clearDocumentUnit(code) };
  }
  const canonical = parseProjectUnit(unit);
  if (canonical === null) {
    return { newCode: code, error: unknownUnitMessage(String(unit)) };
  }
  const p = await getParser();
  const tree = p.parse(code);
  const existing = findTopLevelUnitStatement(tree);
  if (existing) {
    const literal = existing.namedChild(0)!.childForFieldName('arguments')!.namedChildren[0];
    if (literal.text.slice(1, -1) === canonical) {
      return { newCode: code };
    }
    // Keep the author's quote character; only the word inside changes.
    const quote = literal.text[0] === '"' ? '"' : "'";
    return { newCode: spliceCode(code, literal.startIndex, literal.endIndex, `${quote}${canonical}${quote}`) };
  }
  const statement = `unit('${canonical}');`;
  const lastImport = findLastImport(tree);
  const withStatement = lastImport
    ? spliceCode(code, lastImport.endIndex, lastImport.endIndex, `\n${statement}`)
    : `${statement}\n${code}`;
  // Import second: it splices after the last import, i.e. above the
  // statement just placed there, so "imports, then unit()" holds either way.
  return { newCode: await ensureSymbolImport(withStatement, 'unit', 'fluidcad/core') };
}

/**
 * Remove a file's top-level `unit('…')` statement so it follows the project
 * unit again. The whole line goes (a unit statement owns its line — it was
 * placed that way and the runtime wants it alone before any geometry), and
 * `unit` is dropped from the core import unless another `unit` identifier
 * is still in use somewhere. A file that declares none is returned as is,
 * so the caller can skip the write.
 */
export async function clearDocumentUnit(code: string): Promise<string> {
  const p = await getParser();
  const statement = findTopLevelUnitStatement(p.parse(code));
  if (!statement) {
    return code;
  }
  const withoutStatement = removeStatementLine(code, statement);
  if (countIdentifierUses(p.parse(withoutStatement), 'unit') > 0) {
    return withoutStatement;
  }
  return removeSymbolImport(withoutStatement, 'unit', 'fluidcad/core');
}

/**
 * Delete the line(s) a top-level statement spans, newline included. A blank
 * line on each side collapses to one: the statement usually sits between
 * the imports and the first geometry with its own breathing room, and
 * leaving both gaps would stack two blank lines where there was one.
 */
function removeStatementLine(code: string, node: TSNode): string {
  let start = node.startIndex;
  while (start > 0 && code[start - 1] !== '\n') {
    start--;
  }
  let end = node.endIndex;
  while (end < code.length && code[end] !== '\n') {
    end++;
  }
  if (end < code.length) {
    end++;
  }
  if (start >= 2 && code.slice(start - 2, start) === '\n\n' && code[end] === '\n') {
    end++;
  }
  return code.slice(0, start) + code.slice(end);
}

/**
 * How many `identifier` nodes named `symbol` the tree holds outside import
 * statements — the uses an import specifier exists for. Property names
 * (`x.unit`) are `property_identifier`s in the grammar and don't count.
 */
function countIdentifierUses(tree: TSTree, symbol: string): number {
  let count = 0;
  const visit = (n: TSNode): void => {
    if (n.type === 'import_statement') {
      return;
    }
    if (n.type === 'identifier' && n.text === symbol) {
      count++;
    }
    for (const child of n.namedChildren) {
      visit(child);
    }
  };
  visit(tree.rootNode);
  return count;
}

/**
 * Drop `symbol` from the named imports of `module` (the default accepts both
 * core spellings, as `ensureSymbolImport` does). The import statement's line
 * goes with it when `symbol` was the only thing it brought in; a missing
 * specifier is a no-op.
 */
export async function removeSymbolImport(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  // Unlike ensureSymbolImport, which only needs SOME import of the module,
  // the specifier can sit in any of them — a file may spell the core module
  // both ways across two lines — so every matching import is searched.
  const accepts = (source: string): boolean => module === 'fluidcad/core'
    ? source === 'fluidcad' || source === 'fluidcad/core'
    : source === module;
  let importNode: TSNode | null = null;
  let specs: TSNode[] = [];
  let index = -1;
  for (const node of tree.rootNode.namedChildren) {
    const source = node.type === 'import_statement' ? node.childForFieldName('source') : null;
    if (!source || !accepts(source.text.slice(1, -1))) {
      continue;
    }
    const namedImports = findNamedImports(node);
    if (!namedImports) {
      continue;
    }
    specs = namedImports.namedChildren.filter((n) => n.type === 'import_specifier');
    index = specs.findIndex((spec) => (spec.childForFieldName('name') ?? spec.namedChild(0))?.text === symbol);
    if (index >= 0) {
      importNode = node;
      break;
    }
  }
  if (!importNode) {
    return code;
  }
  const clause = importNode.namedChildren.find((n) => n.type === 'import_clause');
  const bringsOnlyThis = specs.length === 1 && clause?.namedChildren.length === 1;
  if (bringsOnlyThis) {
    return removeStatementLine(code, importNode);
  }
  const spec = specs[index];
  // A non-last specifier takes the comma after it; the last takes the one
  // before, so `{ a, unit }` reads `{ a }` and `{unit, a }` reads `{ a }`.
  const isLast = index === specs.length - 1;
  const start = isLast ? consumeLeadingSeparator(code, spec.startIndex) : spec.startIndex;
  const end = isLast ? spec.endIndex : consumeTrailingSeparator(code, spec.endIndex);
  const withoutSpec = spliceCode(code, start, end, '');
  // `{unit, a }` (the shape ensureSymbolImport writes) becomes `{a }` — put
  // the space back so the brace pair reads evenly.
  const braceOffset = findNamedImports(importNode)!.startIndex + 1;
  if (!isLast && index === 0 && withoutSpec[braceOffset] !== ' ' && withoutSpec[braceOffset] !== '\n') {
    return spliceCode(withoutSpec, braceOffset, braceOffset, ' ');
  }
  return withoutSpec;
}

/**
 * Recognise a solved-sketch constraint statement (`coincident(…);`,
 * `distance(…);`, …): an expression_statement whose call's chain-base callee
 * is one of the constraint commands. Geometry inserts before the first of
 * these — the geometry-then-constraints layout convention (plan §0.2).
 */
export function isSolvedConstraintStatement(node: TSNode): boolean {
  if (node.type !== 'expression_statement') {
    return false;
  }
  const call = node.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = chainBaseCall(call).childForFieldName('function');
  return !!fn && fn.type === 'identifier' && SOLVED_CONSTRAINT_KINDS.has(fn.text);
}

/**
 * Recognise a derived-op statement (`offset(…);`, `const f = fillet(4, …);`)
 * — the TAIL region of a solved sketch body (geometry → constraints →
 * derived ops). Derived ops may be const-bound (their result is a pickable
 * producer), so both statement forms qualify.
 */
export function isDerivedOpStatement(node: TSNode): boolean {
  let call: TSNode | null = null;
  if (node.type === 'expression_statement') {
    call = node.namedChild(0);
  } else if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
    call = declarator?.childForFieldName('value') ?? null;
  }
  if (!call || call.type !== 'call_expression') {
    return false;
  }
  const fn = chainBaseCall(call).childForFieldName('function');
  return !!fn && fn.type === 'identifier' && DERIVED_OP_CALLEES.has(fn.text);
}

/**
 * Every sketch is a solved sketch since P7 removed the mode flag — the old
 * literal-`, true` detection is gone and every sketch call gets the solved
 * layout conventions (geometry → constraints → derived ops).
 */
export function isSolvedSketchCall(_call: TSNode): boolean {
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

/** Find a top-level import statement whose source is exactly `module`. */
function findImportForModule(tree: TSTree, module: string): TSNode | null {
  for (const node of tree.rootNode.namedChildren) {
    if (node.type !== 'import_statement') {
      continue;
    }
    const source = node.childForFieldName('source');
    if (source && source.text.slice(1, -1) === module) {
      return node;
    }
  }
  return null;
}

/** The last top-level import statement, if any. */
function findLastImport(tree: TSTree): TSNode | null {
  let last: TSNode | null = null;
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      last = node;
    }
  }
  return last;
}

/**
 * Where a generated top-level declaration goes: after the last import, or
 * after the file's `unit()` statement when that sits below the imports.
 * `unit()` must stay the first statement after the imports (before any
 * geometry, and above `param()` declarations by convention), so nothing is
 * ever inserted between the imports and it.
 */
export function findTopLevelDeclarationAnchor(tree: TSTree): TSNode | null {
  const lastImport = findLastImport(tree);
  const unitStatement = findTopLevelUnitStatement(tree);
  if (unitStatement && (!lastImport || unitStatement.endIndex > lastImport.endIndex)) {
    return unitStatement;
  }
  return lastImport;
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
 * Append `.guide()` to the call chain on the resolved row — the Guide
 * toolbar toggle converting an already-drawn statement to construction
 * geometry.
 */
export function addGuide(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call || findMemberCallInChain(call, 'guide')) {
      return null;
    }
    return spliceCode(code, call.endIndex, call.endIndex, '.guide()');
  });
}

/**
 * Remove the `.guide()` call from the chain on the resolved row — the Guide
 * toggle converting selected construction geometry back to real geometry.
 * Only an argument-less `.guide()` is stripped, mirroring `removePick`.
 */
export function removeGuide(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const guideCall = findMemberCallInChain(call, 'guide');
    if (!guideCall) {
      return null;
    }
    const guideArgs = getArgumentsNode(guideCall);
    if (!guideArgs || guideArgs.namedChildren.length !== 0) {
      return null;
    }
    const member = guideCall.childForFieldName('function');
    const object = member ? member.childForFieldName('object') : null;
    if (!object) {
      return null;
    }
    return spliceCode(code, object.endIndex, guideCall.endIndex, '');
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
// Statement removal — delete a feature statement at a timeline row's source line
// ---------------------------------------------------------------------------

/** Nearest ancestor that is a direct child of a statement_block or program. */
export function enclosingStatementOf(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.parent) {
    if (current.parent.type === 'statement_block' || current.parent.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Remove the whole statement containing the call at `sourceLine` (the
 * timeline "Remove" action) — including a `const x = …` binding, chained
 * calls, and every line a multi-line statement spans. A doubled blank line
 * left by the deletion is collapsed. References to a removed binding are
 * the user's to resolve — except inside a sketch body and in assembly
 * files, where the route's sweeps (`SketchDeleteSweep`,
 * `removeStatementWithAssemblySweep`) take the dependants along.
 */
export function removeStatement(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const statement = enclosingStatementOf(call);
    if (!statement) {
      return null;
    }
    return removeStatementNode(code, lines, statement);
  });
}

/**
 * The splice behind {@link removeStatement} for an already-resolved
 * statement node: `lines` must be `splitLines(code)` of the same `code` the
 * node was parsed from.
 */
export function removeStatementNode(code: string, lines: string[], statement: TSNode): string {
  const startRow = statement.startPosition.row;
  const endRow = statement.endPosition.row;
  const aloneOnItsLines =
    lines[startRow].slice(0, statement.startPosition.column).trim() === '' &&
    lines[endRow].slice(statement.endPosition.column).trim() === '';
  if (!aloneOnItsLines) {
    // Sharing a line with other code: excise just the statement's range.
    return spliceCode(code, statement.startIndex, statement.endIndex, '');
  }
  const remaining = lines.slice(0, startRow).concat(lines.slice(endRow + 1));
  if (startRow > 0 && isBlankRow(remaining, startRow - 1) && isBlankRow(remaining, startRow)) {
    remaining.splice(startRow, 1);
  }
  return joinLines(remaining);
}

// ---------------------------------------------------------------------------
// Feature renaming — set/update/clear the chained .name('…') on a statement
// ---------------------------------------------------------------------------

/**
 * Set, update, or clear the `.name('…')` chain of the feature statement at
 * `sourceLine` (the timeline "Rename" action). A non-empty `name` rewrites
 * an existing `.name()` argument in place or appends `.name('…')` at the end
 * of the chain — dialog edits leave trailing chains they don't recognize
 * untouched, so the name survives them there. An empty or null `name`
 * removes the chain, reverting the feature to its default display name.
 */
export function setFeatureName(
  code: string,
  sourceLine: number,
  name: string | null,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const nameCall = findMemberCallInChain(call, 'name');
    // A display name is a single line: collapse any pasted whitespace runs
    // (newlines would break the generated string literal).
    const value = (name ?? '').replace(/\s+/g, ' ').trim();
    if (value === '') {
      if (!nameCall) {
        return null;
      }
      const member = nameCall.childForFieldName('function');
      const object = member ? member.childForFieldName('object') : null;
      if (!object) {
        return null;
      }
      return spliceCode(code, object.endIndex, nameCall.endIndex, '');
    }
    const quoted = `'${quoteForSingleQuotes(value)}'`;
    if (nameCall) {
      const args = getArgumentsNode(nameCall);
      if (!args) {
        return null;
      }
      return spliceCode(code, args.startIndex + 1, args.endIndex - 1, quoted);
    }
    return spliceCode(code, call.endIndex, call.endIndex, `.name(${quoted})`);
  });
}

// ---------------------------------------------------------------------------
// Geometry insertion — insert a new call expression at the end of a sketch body
// ---------------------------------------------------------------------------

/**
 * Find the callback body (statement_block) inside a sketch() call.
 * Looks for the last arrow_function or function argument, walking down a
 * member chain when the outermost call is a chained modifier — for
 * `sketch('xz', () => {...}).reusable()` the callback belongs to
 * `sketch(...)`, not to the `.reusable()` call the line resolves to.
 */
export function findSketchBody(call: TSNode): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const args = getArgumentsNode(current);
    if (args) {
      for (let i = args.namedChildren.length - 1; i >= 0; i--) {
        const child = args.namedChildren[i];
        if (child.type === 'arrow_function' || child.type === 'function') {
          const body = child.childForFieldName('body');
          if (body && body.type === 'statement_block') {
            return body;
          }
        }
      }
    }
    const fn = current.childForFieldName('function');
    current = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
  }
  return null;
}

/**
 * Every identifier the file binds at any depth: import bindings (named,
 * aliased, default, namespace) plus `const`/`let`/`var` declarators
 * (destructuring included), function and class declarations. Conservative
 * on purpose — a name bound anywhere is treated as taken, so a generated
 * top-level binding never shadows or collides with one the author wrote.
 */
export function collectBoundNames(tree: TSTree): Set<string> {
  const names = new Set<string>();
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      for (const spec of walkTree(node)) {
        if (spec.type === 'import_specifier') {
          const local = spec.childForFieldName('alias') ?? spec.childForFieldName('name') ?? spec.namedChild(0);
          if (local) {
            names.add(local.text);
          }
        } else if (spec.type === 'namespace_import') {
          const id = spec.namedChildren.find(c => c.type === 'identifier');
          if (id) {
            names.add(id.text);
          }
        } else if (spec.type === 'import_clause') {
          for (const child of spec.namedChildren) {
            if (child.type === 'identifier') {
              names.add(child.text);
            }
          }
        }
      }
    }
  }
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'function_declaration' || node.type === 'class_declaration') {
      const name = node.childForFieldName('name');
      if (name) {
        names.add(name.text);
      }
      continue;
    }
    if (node.type !== 'variable_declarator') {
      continue;
    }
    const pattern = node.childForFieldName('name');
    if (!pattern) {
      continue;
    }
    if (pattern.type === 'identifier') {
      names.add(pattern.text);
      continue;
    }
    // Destructuring: `const { a, b: c } = …` binds a and c; `[x, y]` binds
    // both. Property keys parse as property_identifier, so every plain
    // identifier inside the pattern is a binding.
    for (const n of walkTree(pattern)) {
      if (n.type === 'shorthand_property_identifier_pattern' || n.type === 'identifier') {
        names.add(n.text);
      }
    }
  }
  return names;
}

/** The specifier of `module`'s import that brings in `symbol`, if any. */
function findImportSpecifier(tree: TSTree, symbol: string, module: string): TSNode | null {
  const importNode = module === 'fluidcad/core'
    ? findFluidCadImport(tree)
    : findImportForModule(tree, module);
  const namedImports = importNode ? findNamedImports(importNode) : null;
  if (!namedImports) {
    return null;
  }
  for (const spec of namedImports.namedChildren) {
    if (spec.type !== 'import_specifier') {
      continue;
    }
    const name = spec.childForFieldName('name') ?? spec.namedChild(0);
    if (name && name.text === symbol) {
      return spec;
    }
  }
  return null;
}

/**
 * `./side-plate.fluid.js` → `sidePlate`: the module's file stem, camel-cased,
 * with the `.fluid`/`.part`/`.assembly` kind suffix dropped. Empty when the
 * stem holds no identifier characters.
 */
function moduleStemIdentifier(module: string): string {
  const base = module.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '').replace(/\.(fluid|part|assembly)$/, '');
  const words = stem.split(/[^A-Za-z0-9_$]+/).filter(w => w.length > 0);
  const ident = words
    .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() : word.charAt(0).toUpperCase()) + word.slice(1))
    .join('');
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ident) ? ident : '';
}

/**
 * The local name that importing `symbol` from `module` binds — or would
 * bind — in this file. An existing specifier wins, aliased or not
 * (`{ part as platePart }` → `platePart`). Otherwise the export's own name
 * when nothing in the file binds it yet; else a fresh alias: the module's
 * file stem (`part` from `./bracket.fluid.js` → `bracket`), then stem +
 * Symbol (`bracketPart`), then `symbol2`, `symbol3`, … — whichever is free
 * first. Pass the result to `ensureSymbolImport` as `alias` so the emitted
 * import binds exactly the name the generated statement references.
 *
 * Two files exporting the same name (`part`, `main`) or an export that
 * shares a name with a local declaration or a `fluidcad/core` symbol would
 * otherwise render a duplicate binding and break the whole module.
 */
export async function importLocalName(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const existing = findImportSpecifier(tree, symbol, module);
  if (existing) {
    const local = existing.childForFieldName('alias') ?? existing.childForFieldName('name') ?? existing.namedChild(0);
    return local?.text ?? symbol;
  }
  const bound = collectBoundNames(tree);
  if (!bound.has(symbol)) {
    return symbol;
  }
  const stem = moduleStemIdentifier(module);
  const candidates: string[] = [];
  if (stem && stem !== symbol) {
    candidates.push(stem, `${stem}${symbol.charAt(0).toUpperCase()}${symbol.slice(1)}`);
  }
  for (const candidate of candidates) {
    if (!bound.has(candidate)) {
      return candidate;
    }
  }
  for (let n = 2; ; n++) {
    const candidate = `${symbol}${n}`;
    if (!bound.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Ensure a symbol is present in the named imports for `module`. The default
 * module accepts both the `'fluidcad'` and `'fluidcad/core'` spellings; other
 * modules (e.g. `'fluidcad/filters'`) are matched exactly, and a missing
 * import statement is added after the last existing import.
 * Returns modified code if the symbol was added.
 *
 * `alias` (from `importLocalName`) renders the specifier as `symbol as
 * alias` when it differs from the symbol, so a name already bound elsewhere
 * in the file is never re-declared. An existing specifier for the symbol
 * is left as it is, whatever it binds.
 */
export async function ensureSymbolImport(
  code: string,
  symbol: string,
  module = 'fluidcad/core',
  alias?: string,
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const specifier = alias && alias !== symbol ? `${symbol} as ${alias}` : symbol;
  const importNode = module === 'fluidcad/core'
    ? findFluidCadImport(tree)
    : findImportForModule(tree, module);
  if (!importNode) {
    const statement = `import { ${specifier} } from '${module}';`;
    const lastImport = findLastImport(tree);
    if (lastImport) {
      return spliceCode(code, lastImport.endIndex, lastImport.endIndex, `\n${statement}`);
    }
    return `${statement}\n` + code;
  }
  const namedImports = findNamedImports(importNode);
  if (!namedImports) {
    return code;
  }
  if (findImportSpecifier(tree, symbol, module)) {
    return code;
  }
  // Match the import's own spacing: `{ a }` → `{ unit, a }`, `{a}` →
  // `{unit, a}`, and a multi-line list gets its own indented line.
  const openBraceOffset = namedImports.startIndex + 1;
  const after = code[openBraceOffset];
  let insertText: string;
  if (after === '\n' || after === '\r') {
    const nextLineStart = code.indexOf('\n', openBraceOffset) + 1;
    const indent = code.slice(nextLineStart).match(/^[ \t]*/)?.[0] ?? '';
    insertText = `\n${indent}${specifier},`;
  } else if (after === ' ' || after === '\t') {
    insertText = ` ${specifier},`;
  } else {
    insertText = `${specifier}, `;
  }
  return code.slice(0, openBraceOffset) + insertText + code.slice(openBraceOffset);
}

/**
 * Insert a new geometry call expression at the end of a sketch's callback
 * body — before the body's first `breakpoint();` if it has one, since a
 * paused build never runs statements after the breakpoint and the drawn
 * geometry would silently vanish.
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

  // Solved-sketch layout convention (plan §0.2, amended P6): the body reads
  // geometry → constraints → derived ops. Geometry inserts before the first
  // constraint OR derived-op statement; a derived op appends at the true body
  // end (a pause-before edit of it then sees the fully solved sketch). Both
  // land before an active breakpoint and before a trailing return —
  // statements after either never run. Legacy sketches keep the old body-end
  // behavior: pen statements are order-sensitive.
  const solved = isSolvedSketchCall(call);
  const stmtCallee = statement.trim().match(/^(\w+)\s*\(/)?.[1];
  const insertingDerivedOp = solved && !!stmtCallee && DERIVED_OP_CALLEES.has(stmtCallee);
  const breakpointStmt = bodyChildren.find(isBreakpointStatement);
  const firstRegionStmt = insertingDerivedOp
    ? undefined
    : bodyChildren.find(s => isSolvedConstraintStatement(s) || (solved && isDerivedOpStatement(s)));
  if (firstRegionStmt
    && (!breakpointStmt || firstRegionStmt.startPosition.row < breakpointStmt.startPosition.row)) {
    insertRow = firstRegionStmt.startPosition.row;
    indent = indentOf(lines, firstRegionStmt.startPosition.row);
  } else if (breakpointStmt) {
    insertRow = breakpointStmt.startPosition.row;
    indent = indentOf(lines, breakpointStmt.startPosition.row);
  } else if (bodyChildren.length > 0) {
    const lastStmt = bodyChildren[bodyChildren.length - 1];
    insertRow = solved && lastStmt.type === 'return_statement'
      ? lastStmt.startPosition.row
      : lastStmt.endPosition.row + 1;
    indent = indentOf(lines, lastStmt.startPosition.row);
  } else {
    insertRow = body.startPosition.row + 1;
    indent = indentOf(lines, body.startPosition.row) + '  ';
  }

  const newLine = statement.split('\n').map(l => `${indent}${l}`).join('\n');
  lines.splice(insertRow, 0, newLine);
  let result = joinLines(lines);

  // A multi-line statement (e.g. `move(…);\ntext(…)`) needs every line's
  // callee imported, not just the first.
  for (const stmtLine of statement.split('\n')) {
    const funcName = stmtLine.trim().match(/^(\w+)\s*\(/)?.[1];
    if (funcName) {
      result = await ensureSymbolImport(result, funcName);
    }
  }

  return { newCode: result };
}

// ---------------------------------------------------------------------------
// Load insertion — append a load() call for a freshly imported model
// ---------------------------------------------------------------------------

/** Escape a file name for embedding in a single-quoted JS string literal. */
export function quoteForSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The text a string literal node denotes, with its surrounding quotes dropped. */
export function stringLiteralValue(node: TSNode): string | null {
  if (node.type !== 'string') {
    return null;
  }
  const fragment = node.namedChildren.find(c => c.type === 'string_fragment');
  return fragment ? fragment.text : '';
}

/**
 * Find an existing `load('<fileName>')` call anywhere in the file, so a
 * re-import of the same model updates the geometry on disk without stacking
 * a second identical statement into the scene.
 */
function findLoadCallFor(tree: TSTree, fileName: string): TSNode | null {
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'identifier' || fn.text !== 'load') {
      continue;
    }
    const arg = getArgumentsNode(node)?.namedChild(0);
    if (arg && stringLiteralValue(arg) === fileName) {
      return node;
    }
  }
  return null;
}

/**
 * Append `load('<fileName>')` as a new top-level statement — what the import
 * flow calls so the model lands in the scene without the user pasting the
 * expression themselves. The call goes after the last top-level statement so
 * the model shows up at the end of the timeline, separated by a blank line,
 * and the `load` import is pulled in. A no-op when the file already loads
 * that model.
 *
 * @param code - Full source code
 * @param fileName - Extension-less name of the imported model, e.g. "bracket"
 */
export async function insertLoadCall(code: string, fileName: string): Promise<CodeEditResult> {
  const p = await getParser();
  if (findLoadCallFor(p.parse(code), fileName)) {
    return { newCode: code };
  }

  const withImport = await ensureSymbolImport(code, 'load');
  const tree = p.parse(withImport);
  const lines = splitLines(withImport);
  const children = tree.rootNode.namedChildren;
  const last = children[children.length - 1];
  const insertRow = last ? last.endPosition.row + 1 : lines.length;

  const statement = `load('${quoteForSingleQuotes(fileName)}');`;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The numeric value of a `number` (or unary-minus number) node, else null. */
function numericLiteralValue(node: TSNode): number | null {
  if (node.type !== 'number'
    && !(node.type === 'unary_expression' && node.namedChildren[0]?.type === 'number')) {
    return null;
  }
  const value = parseFloat(node.text);
  return Number.isNaN(value) ? null : value;
}

type SpliceEdit = { start: number; end: number; text: string };

/** Apply edits over disjoint ranges, splicing back-to-front. */
function applySpliceEdits(code: string, edits: SpliceEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = code;
  for (const edit of sorted) {
    result = spliceCode(result, edit.start, edit.end, edit.text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Solved-sketch batch position write-back (sketch-rewrite P4)
// ---------------------------------------------------------------------------

export type SketchPositionPointEdit = {
  /** Index into the statement's chain point args (collectChainPointArgs). */
  pointIndex: number;
  position: [number, number];
  /** The literal's statement-time value from the render payload. A mismatch
   * means the buffer changed since the drag's render — refuse everything. */
  expected?: [number, number];
};

export type SketchPositionEdit = {
  sourceLine: number;
  points?: SketchPositionPointEdit[];
  /** Scalar dimension of the base call (circle diameter), same guard. */
  scalar?: { value: number; expected?: number };
};

export type SketchPositionsResult = { newCode: string; error?: string };

/** Statement-time literals are echoed back verbatim through the payload, so
 * agreement is float-exact; the tolerance only absorbs JSON round-tripping. */
const POSITION_DRIFT_TOL = 1e-6;

/**
 * Splice every drifted literal of a solved-sketch drag across multiple
 * statements in ONE parse and ONE edit (one buffer write, one undo step in
 * both editor hosts). All-or-nothing: any drifted or unresolvable statement
 * refuses the whole batch with the offending line named. Non-literal point
 * slots (accessors, identifiers, expressions) are skipped silently — they
 * are solver-derived and the re-solve re-derives them from the spliced
 * literals.
 */
export async function updateSketchPositions(
  code: string,
  edits: SketchPositionEdit[],
): Promise<SketchPositionsResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const splices: SpliceEdit[] = [];
  const seenLines = new Set<number>();

  for (const edit of edits) {
    if (seenLines.has(edit.sourceLine)) {
      return { newCode: code, error: `duplicate position edit for line ${edit.sourceLine}` };
    }
    seenLines.add(edit.sourceLine);

    const call = findEditableCallAt(tree, lines, edit.sourceLine);
    if (!call) {
      return {
        newCode: code,
        error: `no editable statement at line ${edit.sourceLine} — the source changed since this drag started`,
      };
    }

    const pointArgs = collectChainPointArgs(call);
    for (const point of edit.points ?? []) {
      const idx = point.pointIndex >= 0 ? point.pointIndex : pointArgs.length + point.pointIndex;
      if (idx < 0 || idx >= pointArgs.length) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} has no point argument ${point.pointIndex} — the source changed since this drag started`,
        };
      }
      const node = pointArgs[idx];
      const current = parsePointLiteral(node);
      if (current === null) {
        continue;
      }
      if (point.expected
        && (Math.abs(current[0] - point.expected[0]) > POSITION_DRIFT_TOL
          || Math.abs(current[1] - point.expected[1]) > POSITION_DRIFT_TOL)) {
        return {
          newCode: code,
          error: `line ${edit.sourceLine} changed since this drag started`
            + ` — expected [${point.expected[0]}, ${point.expected[1]}], found [${current[0]}, ${current[1]}]`,
        };
      }
      splices.push({
        start: node.startIndex,
        end: node.endIndex,
        text: `[${roundCoord(point.position[0])}, ${roundCoord(point.position[1])}]`,
      });
    }

    if (edit.scalar) {
      const baseArgs = getArgumentsNode(chainBaseCall(call));
      const target = baseArgs ? findNonArrayArgFromEnd(baseArgs) : null;
      const current = target ? numericLiteralValue(target) : null;
      if (target && current !== null) {
        if (edit.scalar.expected !== undefined
          && Math.abs(current - edit.scalar.expected) > POSITION_DRIFT_TOL) {
          return {
            newCode: code,
            error: `line ${edit.sourceLine} changed since this drag started`
              + ` — expected ${edit.scalar.expected}, found ${current}`,
          };
        }
        splices.push({
          start: target.startIndex,
          end: target.endIndex,
          text: String(roundCoord(edit.scalar.value)),
        });
      }
    }
  }

  return { newCode: applySpliceEdits(code, splices) };
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
    const target = findNonArrayArgFromEnd(args);
    if (!target) {
      return null;
    }
    return spliceCode(code, target.startIndex, target.endIndex, String(newValue));
  });
}

// ---------------------------------------------------------------------------
// Expression-aware dimension helpers
// ---------------------------------------------------------------------------

function findNonArrayArgFromEnd(args: TSNode, offset = 0): TSNode | null {
  let skipped = 0;
  for (let i = args.namedChildren.length - 1; i >= 0; i--) {
    const child = args.namedChildren[i];
    if (child.type !== 'array') {
      if (skipped === offset) {
        return child;
      }
      skipped++;
    }
  }
  return null;
}

// Name of the function a call expression invokes: `rect(...)` -> 'rect',
// `foo.radius(...)` -> 'radius'.
function callFunctionName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) {
    return null;
  }
  if (fn.type === 'identifier') {
    return fn.text;
  }
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

export async function getDimensionExpression(
  code: string,
  sourceLine: number,
  dimensionOffset = 0,
  dimensionCall: string | null = null,
): Promise<{ expression: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  let current: TSNode | null = findEditableCallAt(tree, lines, sourceLine);
  while (current && current.type === 'call_expression') {
    const args = getArgumentsNode(current);
    if (args && (!dimensionCall || callFunctionName(current) === dimensionCall)) {
      const target = findNonArrayArgFromEnd(args, dimensionOffset);
      if (target) {
        return { expression: target.text };
      }
    }
    const fn = current.childForFieldName('function');
    current = fn && fn.type === 'member_expression'
      ? fn.childForFieldName('object')
      : null;
  }
  return null;
}

export function updateDimensionExpression(
  code: string,
  sourceLine: number,
  expression: string,
  dimensionOffset = 0,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    let current: TSNode | null = findEditableCallAt(tree, lines, sourceLine);
    while (current && current.type === 'call_expression') {
      const args = getArgumentsNode(current);
      if (args) {
        const target = findNonArrayArgFromEnd(args, dimensionOffset);
        if (target) {
          return spliceCode(code, target.startIndex, target.endIndex, expression);
        }
      }
      const fn = current.childForFieldName('function');
      current = fn && fn.type === 'member_expression'
        ? fn.childForFieldName('object')
        : null;
    }
    return null;
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
 * Insert `const name = initializer;` at top level, directly after the last
 * import — or after the file's `unit()` statement, which keeps its place
 * right under the imports — or as the file's first line. Param declarations
 * land here, one shared spot, rather than inside a sketch body.
 */
export async function declareTopLevelVariable(
  code: string,
  name: string,
  initializer: string,
): Promise<string> {
  const p = await getParser();
  const tree = p.parse(code);
  const statement = `const ${name} = ${initializer};`;
  const anchor = findTopLevelDeclarationAnchor(tree);
  if (anchor) {
    return spliceCode(code, anchor.endIndex, anchor.endIndex, `\n${statement}`);
  }
  return `${statement}\n${code}`;
}

export type NewVariableDecl = { name: string; initializer: string };

/**
 * Run an edit that may be preceded by inserting `const name = init;` lines at
 * the top of the sketch body — one per requested variable, in order, so a
 * later initializer may reference an earlier variable. The edit receives the
 * (possibly-mutated) code and the number of lines added by the declarations,
 * so it can re-anchor any sourceLine references inside the body. A `param()`
 * declaration instead lands at top level after the imports — inserted (with
 * its import) after the edit, so the edit's sourceLine anchors never shift.
 *
 * Adopt this wrapper for any new code-edit endpoint that should support
 * "declare variables on the same commit."
 */
async function withOptionalVariableDeclaration(
  code: string,
  sketchSourceLine: number,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
  edit: (code: string, lineShift: number) => Promise<CodeEditResult>,
): Promise<CodeEditResult> {
  const requested = newVariable === null ? [] : [newVariable].flat();
  const params = requested.filter((v) => /\bparam\s*\(/.test(v.initializer));
  const locals = requested.filter((v) => !/\bparam\s*\(/.test(v.initializer));

  // Each declaration is inserted at the top of the body, so reversed input
  // order leaves them in input order.
  let declaredCode = code;
  let lineShift = 0;
  for (const v of [...locals].reverse()) {
    const declared = await declareSketchVariable(declaredCode, sketchSourceLine, v.name, v.initializer);
    if (!declared) {
      return { newCode: code };
    }
    declaredCode = declared.newCode;
    lineShift += declared.linesAdded;
  }

  const result = await edit(declaredCode, lineShift);
  if (params.length === 0) {
    return result;
  }
  let withParams = result.newCode;
  for (const v of [...params].reverse()) {
    withParams = await declareTopLevelVariable(withParams, v.name, v.initializer);
  }
  return { ...result, newCode: await ensureSymbolImport(withParams, 'param') };
}

export function insertGeometryCallWithVariable(
  code: string,
  sketchSourceLine: number,
  statement: string,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c) => insertGeometryCall(c, sketchSourceLine, statement));
}

/**
 * The two element expressions of a point argument, as authored. Only an
 * `[x, y]` literal has them — a `Point2DLike` may also be an identifier or a
 * lazy accessor (`circle(hole.center(), 5)`), which has no per-axis text.
 */
export async function getPointExpression(
  code: string,
  sourceLine: number,
  pointIndex = 0,
): Promise<{ x: string; y: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sourceLine);
  if (!call) {
    return null;
  }
  const node = pointLiteralAt(call, pointIndex);
  if (!node) {
    return null;
  }
  return { x: node.namedChildren[0].text, y: node.namedChildren[1].text };
}

export function updateDimensionExpressionWithVariable(
  code: string,
  sourceLine: number,
  expression: string,
  sketchSourceLine: number,
  newVariable: NewVariableDecl | NewVariableDecl[] | null,
  dimensionOffset = 0,
): Promise<CodeEditResult> {
  return withOptionalVariableDeclaration(code, sketchSourceLine, newVariable,
    (c, shift) => updateDimensionExpression(c, sourceLine + shift, expression, dimensionOffset));
}

export type VariableInfo = { name: string; initializer?: string; numeric?: boolean };

/**
 * Whether an initializer is a plain constant, arithmetic expression, or
 * `param()` declaration — the kind of value a numeric input can reference.
 * Feature results (`extrude(...)`),
 * objects, arrays, strings, and functions are not. Local identifiers resolve
 * through `numericByName`; unknown names (globals, imports) pass permissively.
 */
function isNumericValueNode(node: TSNode, numericByName: Map<string, boolean>): boolean {
  switch (node.type) {
    case 'number':
      return true;
    case 'identifier':
      return numericByName.get(node.text) ?? true;
    case 'unary_expression':
    case 'binary_expression':
    case 'parenthesized_expression':
    case 'ternary_expression':
      return node.namedChildren.every((c) => isNumericValueNode(c, numericByName));
    case 'member_expression': {
      const obj = node.childForFieldName('object');
      return obj ? isNumericValueNode(obj, numericByName) : false;
    }
    case 'call_expression': {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'param') {
        return true;
      }
      const isMathCall = fn?.type === 'member_expression'
        && fn.childForFieldName('object')?.text === 'Math';
      if (!isMathCall) {
        return false;
      }
      const args = node.childForFieldName('arguments');
      return !args || args.namedChildren.every((c) => isNumericValueNode(c, numericByName));
    }
    default:
      return false;
  }
}

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
  const numericByName = new Map<string, boolean>();

  function addVar(name: string, initializer?: string, valueNode?: TSNode) {
    if (!seen.has(name)) {
      seen.add(name);
      const numeric = valueNode ? isNumericValueNode(valueNode, numericByName) : true;
      numericByName.set(name, numeric);
      variables.push({ name, initializer, numeric });
    }
  }

  function collectDeclarators(node: TSNode) {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_declarator') {
        const nameNode = child.childForFieldName('name');
        const valueNode = child.childForFieldName('value');
        if (nameNode && nameNode.type === 'identifier') {
          const init = valueNode ? valueNode.text : undefined;
          addVar(nameNode.text, init, valueNode ?? undefined);
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

  // Declarations in enclosing bodies — a statement inside an
  // `assembly('name', () => { … })` callback sees the body's earlier consts
  // (`width`, `depth`) the same way a top-level statement sees the file's.
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'statement_block'
      || node.startPosition.row > sketchRow || node.endPosition.row < sketchRow) {
      continue;
    }
    for (const stmt of node.namedChildren) {
      if (stmt.startPosition.row > sketchRow) {
        break;
      }
      if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration') {
        collectDeclarators(stmt);
      }
    }
  }

  return variables;
}
