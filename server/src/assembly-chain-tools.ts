import {
  getJavaScriptParser,
  indentOf,
  isBlankRow,
  joinLines,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';

/**
 * Tree-sitter helpers shared by the assembly statement writers (mate,
 * replicate, connector): locating a statement's call chain by source line,
 * resolving the `const` binding a statement is spelled through (hoisting one
 * onto a bare expression statement), scope lookup, and statement placement.
 * Everything here is about HOW a reference is written, never WHAT the
 * statement means — the per-statement modules own that.
 */

/** Connector / exposure names share the identifier pattern the kernel enforces. */
export const CONNECTOR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * One segment of an occurrence export path: an identifier key of the
 * callback's return object, or an array index (the export walker indexes
 * arrays — `return { copies: replicate(...) }` yields keys ["copies", "1"]).
 */
export const EXPORT_KEY = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|\d+)$/;

/**
 * `.parts.<keys…>` for one occurrence level, numeric keys as index access:
 * `["copies", "1"]` → `.parts.copies[1]`, `["1"]` → `.parts[1]`.
 */
export function renderPartsChain(keys: string[]): string {
  return '.parts' + keys.map(key => (/^\d+$/.test(key) ? `[${key}]` : `.${key}`)).join('');
}

/**
 * A member chain with every `[n]` index spelled as `.n` and whitespace
 * dropped — the form two spellings of one export path compare equal in.
 */
export function canonicalChainText(text: string): string {
  return text.replace(/\s+/g, '').replace(/\[(\d+)\]/g, '.$1');
}

const NUMBER_DECIMALS = 6;

export type CodeTransformResult = { newCode: string; error?: string };

/**
 * One side of a connector-authored statement: the anchor whose `insert()`
 * chain starts on `instanceLine` (1-based, the serialized sourceLocation —
 * the instance itself, or with `viaParts` the top-level OCCURRENCE the
 * instance lives under), and the part-owned connector's name.
 *
 * A direct side dereferences as `<binding>.connectors.<connectorName>`. A
 * `viaParts` side reaches through sub-assembly export chains instead: one
 * key path per occurrence level, each rendered as `.parts.<keys...>`.
 *
 * With `replicaRow`, `instanceLine` addresses a `replicate()` statement
 * instead and the anchor is its `replicaRow`-th replica (0-based): the side
 * dereferences through the replicate statement's binding — `name[row]` for
 * an array binding (hoisted as `<seed>Replicas` when unbound), or the
 * destructured name when the author wrote `const [a, b] = replicate(...)`.
 */
export type MateConnectorRef = {
  instanceLine: number;
  connectorName: string;
  viaParts?: string[][];
  replicaRow?: number;
};

/**
 * One side of a tangent statement: the same stable instance address (and the
 * same `replicaRow` form), but the part-owned exposure's name, dereferenced
 * as `<binding>.features.<exposeName>`.
 */
export type MateGeometryRef = {
  instanceLine: number;
  exposeName: string;
  replicaRow?: number;
};

/**
 * One assembly-connector side: the `connector('name', [x, y, z])` statement
 * starting on `connectorLine` (1-based, the serialized sourceLocation). It
 * dereferences as the statement's `const` binding (a bare expression
 * statement gets `const <connectorName> = ` prepended, like an unbound
 * `insert()`), and anchors statement placement like an instance side.
 */
export type MateFrameRef = {
  connectorLine: number;
  connectorName: string;
};

/** Any statement side: an instance connector, an exposure, or an assembly connector. */
export type SideRef = MateConnectorRef | MateGeometryRef | MateFrameRef;

/** The 1-based line a side anchors placement on (its insert / connector / replicate statement). */
export function sideAnchorLine(side: SideRef): number {
  return 'connectorLine' in side ? side.connectorLine : side.instanceLine;
}

export function formatNumber(n: number): string {
  // Strip float noise but keep short literals exact: `1.5` stays `1.5`.
  return String(+n.toFixed(NUMBER_DECIMALS));
}

/** Outermost call_expression starting on the 1-based source line. */
export function findChainAt(tree: TSTree, sourceLine: number): TSNode | null {
  const row = sourceLine - 1;
  if (row < 0) {
    return null;
  }
  let best: TSNode | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || node.startPosition.row !== row) {
      continue;
    }
    if (!best || node.endIndex > best.endIndex) {
      best = node;
    }
  }
  return best;
}

/** Walk `insert(p).grounded().name('x')` down to the base `insert(p)` call. */
export function chainBaseCall(tail: TSNode): TSNode {
  let cur = tail;
  for (;;) {
    const fn = cur.childForFieldName('function');
    if (fn?.type !== 'member_expression') {
      return cur;
    }
    const object = fn.childForFieldName('object');
    if (!object || object.type !== 'call_expression') {
      return cur;
    }
    cur = object;
  }
}

export function baseCallName(base: TSNode): string | null {
  const fn = base.childForFieldName('function');
  return fn?.type === 'identifier' ? fn.text : null;
}

/** The statement (expression statement or declaration) containing `node`. */
export function enclosingStatement(node: TSNode): TSNode | null {
  let cur: TSNode | null = node;
  while (cur) {
    if (
      cur.type === 'expression_statement'
      || cur.type === 'lexical_declaration'
      || cur.type === 'variable_declaration'
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/** Nearest statement_block (or the program root) enclosing `node`. */
export function enclosingBlock(node: TSNode | null): TSNode | null {
  let cur = node?.parent ?? null;
  while (cur) {
    if (cur.type === 'statement_block' || cur.type === 'program') {
      return cur;
    }
    cur = cur.parent;
  }
  return null;
}

/** The scope holding the statement whose chain starts on `anchorLine`. */
export function scopeOfAnchor(tree: TSTree, anchorLine: number): TSNode | null {
  const chain = findChainAt(tree, anchorLine);
  const statement = chain ? enclosingStatement(chain) : null;
  return enclosingBlock(statement);
}

/**
 * The statement whose chain starts on `line`, when that chain bottoms out in
 * a `<base>(...)` call — `{ tail, base, statement }`, or the reason it doesn't.
 */
export function findBaseStatement(
  tree: TSTree,
  line: number,
  expectedBase: string,
): { tail: TSNode; base: TSNode; statement: TSNode } | { error: string } {
  const tail = findChainAt(tree, line);
  if (!tail) {
    return { error: `no ${expectedBase}() statement found on line ${line}` };
  }
  const base = chainBaseCall(tail);
  if (baseCallName(base) !== expectedBase) {
    return { error: `the statement on line ${line} is not ${describeCall(expectedBase)} — the source may have shifted; re-render and try again` };
  }
  const statement = enclosingStatement(tail);
  if (!statement) {
    return { error: `could not resolve the ${expectedBase}() statement on line ${line}` };
  }
  return { tail, base, statement };
}

function describeCall(base: string): string {
  return base === 'insert' ? 'an insert()' : `a ${base}()`;
}

/**
 * The `const` identifier the statement starting on `line` is bound to,
 * where the statement's chain must bottom out in a `<expectedBase>(...)`
 * call. A bare expression statement gets `const <name> = ` prepended:
 * `preferredName` (an assembly connector's own name) when that word is
 * free in the file, else the `pickBindingName` derivation. Prepending on
 * the statement's own line keeps every row number stable, so callers may
 * keep addressing lines in the returned code.
 */
export async function resolveStatementBinding(
  code: string,
  line: number,
  expectedBase: 'insert' | 'connector' | 'replicate',
  preferredName?: string,
): Promise<{ newCode: string; name: string } | { error: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const found = findBaseStatement(tree, line, expectedBase);
  if ('error' in found) {
    return found;
  }
  const { base, statement } = found;
  if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    if (!name || name.type !== 'identifier') {
      return { error: `the ${expectedBase}() on line ${line} is not bound to a plain variable` };
    }
    return { newCode: code, name: name.text };
  }
  if (statement.type === 'expression_statement') {
    const name = preferredName !== undefined
      ? freeBindingName(code, preferredName)
      : pickBindingName(code, base);
    return {
      newCode: spliceCode(code, statement.startIndex, statement.startIndex, `const ${name} = `),
      name,
    };
  }
  return { error: `the ${expectedBase}() on line ${line} sits inside a ${statement.type} — bind it to a top-level const first` };
}

/** The `const` identifier the instance's `insert()` chain is bound to (hoisting one when bare). */
export function resolveInstanceBinding(
  code: string,
  instanceLine: number,
): Promise<{ newCode: string; name: string } | { error: string }> {
  return resolveStatementBinding(code, instanceLine, 'insert');
}

/**
 * The identifier of a `replicate()` statement's seed argument — its first
 * argument when that is a plain binding, else null (the kernel only accepts
 * an inserted handle there, so hand-written code is an identifier too).
 */
export function replicateSeedName(base: TSNode): string | null {
  const first = base.childForFieldName('arguments')?.namedChildren.find(c => c.type !== 'comment') ?? null;
  return first?.type === 'identifier' ? first.text : null;
}

/**
 * The names an array destructuring binds, by element index — holes stay
 * `null` (`const [a, , c]` → `['a', null, 'c']`). Anonymous comma tokens
 * carry the index; every named child is one element.
 */
export function arrayPatternNames(pattern: TSNode): (string | null)[] {
  // The node type exposes named children only, so holes are read off the
  // source text: split the bracket body on top-level commas.
  const body = pattern.text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const slots: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === ')' || ch === '}') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      slots.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '' || slots.length > 0) {
    slots.push(current);
  }
  return slots.map(slot => {
    const name = slot.trim();
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : null;
  });
}

/**
 * How the `row`-th replica of the `replicate()` statement on
 * `replicateLine` is spelled: the destructured name when the author wrote
 * `const [a, b] = replicate(...)` and that slot is named, else
 * `<binding>[row]` — the binding hoisted as `const <seed>Replicas = ` (name
 * deduped against the file) when the statement is bare.
 */
export async function resolveReplicaBinding(
  code: string,
  replicateLine: number,
  row: number,
): Promise<{ newCode: string; expression: string } | { error: string }> {
  if (!Number.isInteger(row) || row < 0) {
    return { error: `replica row must be a non-negative integer, got ${row}` };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const found = findBaseStatement(tree, replicateLine, 'replicate');
  if ('error' in found) {
    return found;
  }
  const { base, statement } = found;
  if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    if (name?.type === 'identifier') {
      return { newCode: code, expression: `${name.text}[${row}]` };
    }
    if (name?.type === 'array_pattern') {
      const slot = arrayPatternNames(name)[row] ?? null;
      if (slot === null) {
        return {
          error: `replica ${row + 1} of the replicate() on line ${replicateLine} has no name in its destructuring — name that slot (const [a, b, c] = replicate(...)) or bind the whole array to one const`,
        };
      }
      return { newCode: code, expression: slot };
    }
    return { error: `the replicate() on line ${replicateLine} is not bound to a plain variable or an array pattern` };
  }
  if (statement.type !== 'expression_statement') {
    return { error: `the replicate() on line ${replicateLine} sits inside a ${statement.type} — bind it to a const first` };
  }
  const seed = replicateSeedName(base) ?? 'replica';
  const binding = freeBindingName(code, `${seed}Replicas`);
  return {
    newCode: spliceCode(code, statement.startIndex, statement.startIndex, `const ${binding} = `),
    expression: `${binding}[${row}]`,
  };
}

/**
 * The expression one side is written as: the connector or exposure
 * dereferenced through its anchor's binding (`arm1.connectors.hinge` /
 * `cam1.features.profile` / a replica's `cyl1Replicas[1].…`), reaching
 * through `.parts.<keys...>` export chains first when the side lives inside
 * a sub-assembly occurrence; an assembly connector is its own binding.
 * Bindings hoisted along the way are same-line prepends, so the returned
 * code keeps every line address valid.
 */
export async function resolveSideExpression(
  code: string,
  side: SideRef,
): Promise<{ newCode: string; expression: string } | { error: string }> {
  if ('connectorLine' in side) {
    const binding = await resolveStatementBinding(code, side.connectorLine, 'connector', side.connectorName);
    if ('error' in binding) {
      return binding;
    }
    return { newCode: binding.newCode, expression: binding.name };
  }
  let prefix: { newCode: string; expression: string } | { error: string };
  if (side.replicaRow !== undefined) {
    prefix = await resolveReplicaBinding(code, side.instanceLine, side.replicaRow);
  } else {
    const bound = await resolveInstanceBinding(code, side.instanceLine);
    prefix = 'error' in bound ? bound : { newCode: bound.newCode, expression: bound.name };
  }
  if ('error' in prefix) {
    return prefix;
  }
  const via = ('viaParts' in side ? side.viaParts : undefined) ?? [];
  const chain = via.map(renderPartsChain).join('');
  const member = 'connectorName' in side
    ? `.connectors.${side.connectorName}`
    : `.features.${side.exposeName}`;
  return {
    newCode: prefix.newCode,
    expression: `${prefix.expression}${chain}${member}`,
  };
}

/**
 * A fresh binding name for an unbound `insert(...)`: derived from the inserted
 * expression's leading identifier (`insert(sidePlate())` → `sidePlate1`), with
 * the smallest numeric suffix not already used as a word in the file.
 */
export function pickBindingName(code: string, base: TSNode): string {
  const args = base.childForFieldName('arguments');
  const firstArg = args?.namedChildren[0] ?? null;
  let root: TSNode | null = firstArg;
  while (root && root.type === 'call_expression') {
    root = root.childForFieldName('function');
  }
  let baseName = root?.type === 'identifier' ? root.text : 'instance';
  baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseName)) {
    baseName = 'instance';
  }
  for (let n = 1; ; n++) {
    const candidate = `${baseName}${n}`;
    if (!wordUsed(code, candidate)) {
      return candidate;
    }
  }
}

/** `preferred` itself when free in the file, else `preferred1`, `preferred2`, … */
export function freeBindingName(code: string, preferred: string): string {
  if (!wordUsed(code, preferred)) {
    return preferred;
  }
  for (let n = 1; ; n++) {
    const candidate = `${preferred}${n}`;
    if (!wordUsed(code, candidate)) {
      return candidate;
    }
  }
}

export function wordUsed(code: string, word: string): boolean {
  // String literals don't occupy the identifier namespace — without
  // stripping them, a connector named 'pivot' would block the binding
  // `pivot` purely because of its own name literal.
  const withoutStrings = code.replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
  return new RegExp(`\\b${word}\\b`).test(withoutStrings);
}

/** Whether the statement's text mentions `name` as an identifier (its root binding, a member chain's object, …). */
export function statementMentions(statement: TSNode, name: string): boolean {
  for (const node of walkTree(statement)) {
    if (node.type === 'identifier' && node.text === name) {
      return true;
    }
  }
  return false;
}

/** The leading identifier of a member/subscript chain: `a.b.c` → `a`, `x[1].parts.y` → `x`. */
export function expressionRoot(expression: string): string {
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expression);
  return match ? match[0] : expression;
}

/** Consecutive mate()/replicate() statements group without blank separators between them. */
export function isAssemblyStatementRow(line: string): boolean {
  return /^\s*(?:const\s+[\w$[\], ]+\s*=\s*)?(?:mate|replicate)\s*\(/.test(line);
}

/** Append the statement after the last top-level statement, insert-edit style. */
export function appendStatement(code: string, statement: string): CodeTransformResult {
  const lines = splitLines(code);
  let lastRow = -1;
  for (let row = lines.length - 1; row >= 0; row--) {
    if (!isBlankRow(lines, row)) {
      lastRow = row;
      break;
    }
  }
  const insertRow = lastRow + 1;
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1)
    && !isAssemblyStatementRow(lines[insertRow - 1]);
  lines.splice(insertRow, 0, ...(separated ? ['', statement] : [statement]));
  return { newCode: joinLines(lines) };
}

/**
 * Append the statement into the SCOPE holding the anchor statement — inside
 * the `assembly()` body's statement block when the referenced `insert()`
 * lives in one (`export const xAxis = (w) => assembly('x-axis', () => {...})`
 * — the canonical sub-assembly form), the file's top level otherwise. A
 * file-end append there would reference the insert binding from OUTSIDE its
 * closure: a ReferenceError on the next render.
 *
 * Inside a block the statement lands BEFORE its `return` (statements after
 * it never run, and assembly bodies conventionally end on `return {...}`).
 * `requireSameScopeLine` (a mate's second connector) refuses when the two
 * anchors live in different scopes — no single placement could see both
 * bindings.
 */
export async function appendStatementInScope(
  code: string,
  statement: string,
  anchorLine: number,
  requireSameScopeLine?: number,
): Promise<CodeTransformResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const scope = scopeOfAnchor(tree, anchorLine);
  if (requireSameScopeLine !== undefined) {
    const other = scopeOfAnchor(tree, requireSameScopeLine);
    if (scope && other && scope.startIndex !== other.startIndex) {
      return {
        newCode: code,
        error: 'the two connectors\' instances live in different assembly bodies — mate them in the file that inserts both',
      };
    }
  }
  if (!scope || scope.type === 'program') {
    return appendStatement(code, statement);
  }

  const lines = splitLines(code);
  const statements = scope.namedChildren.filter(c => c.type !== 'comment');
  const returnStmt = statements.find(c => c.type === 'return_statement') ?? null;
  const lastStmt = statements[statements.length - 1] ?? null;
  let insertRow: number;
  let indent: string;
  if (returnStmt) {
    insertRow = returnStmt.startPosition.row;
    indent = indentOf(lines, returnStmt.startPosition.row);
  } else if (lastStmt) {
    insertRow = lastStmt.endPosition.row + 1;
    indent = indentOf(lines, lastStmt.startPosition.row);
  } else {
    // Unreachable in practice (the anchor statement lives in this block),
    // but a defensive fallback beats dropping the edit.
    return appendStatement(code, statement);
  }
  const separated = insertRow > 0 && !isBlankRow(lines, insertRow - 1)
    && !isAssemblyStatementRow(lines[insertRow - 1]);
  lines.splice(insertRow, 0, ...(separated ? ['', `${indent}${statement}`] : [`${indent}${statement}`]));
  return { newCode: joinLines(lines) };
}

/** Insert `statement` (one or more lines) on its own rows directly before `node`, at the node's indent. */
export function insertStatementBefore(code: string, node: TSNode, statement: string): string {
  const lines = splitLines(code);
  const row = node.startPosition.row;
  const indent = indentOf(lines, row);
  lines.splice(row, 0, ...statement.split('\n').map(l => `${indent}${l}`));
  return joinLines(lines);
}

/** Insert `statement` (one or more lines) on its own rows directly after `node`, at the node's indent. */
export function insertStatementAfter(code: string, node: TSNode, statement: string): string {
  const lines = splitLines(code);
  const indent = indentOf(lines, node.startPosition.row);
  lines.splice(node.endPosition.row + 1, 0, ...statement.split('\n').map(l => `${indent}${l}`));
  return joinLines(lines);
}

/**
 * The first of `anchorLines` whose binding is not visible from `statement`
 * (declared in its own scope or one enclosing it), or null when every
 * anchor is. Re-pointing an in-place edit at a binding inside another
 * assembly body would render a ReferenceError — callers word the refusal.
 */
export function firstHiddenAnchor(tree: TSTree, statement: TSNode, anchorLines: number[]): number | null {
  const visibleScopes = new Set<number>();
  for (let cur: TSNode | null = statement; cur; cur = cur.parent) {
    if (cur.type === 'statement_block' || cur.type === 'program') {
      visibleScopes.add(cur.startIndex);
    }
  }
  for (const line of anchorLines) {
    // A missing anchor scope means the statement didn't resolve at all —
    // side resolution already refused that before this runs.
    const anchorScope = scopeOfAnchor(tree, line);
    if (anchorScope && !visibleScopes.has(anchorScope.startIndex)) {
      return line;
    }
  }
  return null;
}
