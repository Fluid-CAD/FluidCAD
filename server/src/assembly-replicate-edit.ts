import {
  ensureSymbolImport,
  getJavaScriptParser,
  indentOf,
  removeStatement,
  spliceCode,
  splitLines,
  walkTree,
  type CodeEditResult,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import {
  CONNECTOR_NAME,
  EXPORT_KEY,
  arrayPatternNames,
  canonicalChainText,
  firstHiddenAnchor,
  baseCallName,
  chainBaseCall,
  enclosingStatement,
  findBaseStatement,
  findChainAt,
  insertStatementAfter,
  replicateSeedName,
  resolveInstanceBinding,
  resolveSideExpression,
  scopeOfAnchor,
  sideAnchorLine,
  statementMentions,
  wordUsed,
  type CodeTransformResult,
  type SideRef,
} from './assembly-chain-tools.ts';

/**
 * A replicate target or row cell: the same three side shapes a mate side
 * takes — an instance connector (`MateConnectorRef`, `viaParts` and
 * `replicaRow` included), an assembly connector (`MateFrameRef`) or an
 * exposure (`MateGeometryRef`, by name only: a raw pick has no exposure to
 * reference yet — expose it through the mate dialog first).
 */
export type ReplicateSideRef = SideRef;

/**
 * The dialog's full state for one `replicate()` statement:
 *
 *     replicate(cyl1, [bore1, crank.connectors.c2], [
 *       [bore2, crank.connectors.c3],
 *       [bore3, crank.connectors.c4],
 *     ]);
 *
 * `seed` is the replicated handle's `insert()` line (hoisted to a const when
 * bare); `targets` are the seed's outer mate sides that vary per replica —
 * one column each; `rows` hold one replacement per column per replica.
 */
export type AssemblyReplicatePayload = {
  seed: { instanceLine: number };
  targets: ReplicateSideRef[];
  rows: ReplicateSideRef[][];
};

/**
 * The replicate dialog's edit payload — rides `ApplyFeatureEditSpec` as a
 * side-channel (like `assemblyMate`): every other spec field is ignored and
 * the transform below runs instead. `create` writes a fresh statement
 * directly after the seed's last `mate()`; `edit` re-renders the statement
 * at `sourceLine` in place from the full state; `removeRow` splices one
 * replica out (the last row removes the statement).
 */
export type AssemblyReplicateEditSpec = {
  create?: AssemblyReplicatePayload;
  edit?: AssemblyReplicatePayload & {
    /** 1-based row the `replicate()` statement starts on (serialized sourceLocation.line). */
    sourceLine: number;
  };
  removeRow?: {
    sourceLine: number;
    /** 0-based replica index — the row to drop. */
    row: number;
  };
};

export type AssemblyReplicateEditResult = CodeTransformResult;

function isGeometry(side: ReplicateSideRef): boolean {
  return 'exposeName' in side;
}

function validateSideRef(side: ReplicateSideRef, where: string): string | null {
  if ('connectorLine' in side) {
    if (!Number.isInteger(side.connectorLine) || side.connectorLine < 1) {
      return `${where}: an assembly connector side needs the line its connector() statement starts on`;
    }
    if (!CONNECTOR_NAME.test(side.connectorName)) {
      return `${where}: "${side.connectorName}" is not a valid connector name`;
    }
    return null;
  }
  if (!Number.isInteger(side.instanceLine) || side.instanceLine < 1) {
    return `${where}: a side needs the line its insert() statement starts on`;
  }
  if (side.replicaRow !== undefined && (!Number.isInteger(side.replicaRow) || side.replicaRow < 0)) {
    return `${where}: replicaRow must be a non-negative integer`;
  }
  if ('exposeName' in side) {
    if (!CONNECTOR_NAME.test(side.exposeName)) {
      return `${where}: "${side.exposeName}" is not a valid exposure name`;
    }
    return null;
  }
  if (!CONNECTOR_NAME.test(side.connectorName)) {
    return `${where}: "${side.connectorName}" is not a valid connector name`;
  }
  for (const key of (side.viaParts ?? []).flat()) {
    if (!EXPORT_KEY.test(key)) {
      return `${where}: "${key}" is not a valid export key`;
    }
  }
  return null;
}

/** Whether `side` sits on the seed itself (the seed's own insert line, not one of its replicas). */
function onSeed(side: ReplicateSideRef, seedLine: number): boolean {
  return 'instanceLine' in side && side.instanceLine === seedLine && side.replicaRow === undefined;
}

export function validateReplicatePayload(payload: AssemblyReplicatePayload): string | null {
  if (!Number.isInteger(payload.seed?.instanceLine) || payload.seed.instanceLine < 1) {
    return 'the seed needs the line its insert() statement starts on';
  }
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
    return 'replicate needs at least one target — the seed mate side that varies per replica';
  }
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    return 'replicate needs at least one replica row';
  }
  for (let j = 0; j < payload.targets.length; j++) {
    const target = payload.targets[j];
    const invalid = validateSideRef(target, `target ${j + 1}`);
    if (invalid) {
      return invalid;
    }
    if (onSeed(target, payload.seed.instanceLine)) {
      return `target ${j + 1} sits on the seed itself — targets are the seed's outer mate sides (the connectors on OTHER bodies its mates reach)`;
    }
  }
  for (let k = 0; k < payload.rows.length; k++) {
    const row = payload.rows[k];
    if (!Array.isArray(row) || row.length !== payload.targets.length) {
      return `row ${k + 1} has ${Array.isArray(row) ? row.length : 0} ${Array.isArray(row) && row.length === 1 ? 'entry' : 'entries'}, expected ${payload.targets.length} (one per target)`;
    }
    for (let j = 0; j < row.length; j++) {
      const where = `row ${k + 1}, column ${j + 1}`;
      const invalid = validateSideRef(row[j], where);
      if (invalid) {
        return invalid;
      }
      if (isGeometry(row[j]) !== isGeometry(payload.targets[j])) {
        return isGeometry(payload.targets[j])
          ? `${where} — expected exposed geometry like the target, got a connector`
          : `${where} — expected a connector like the target, got exposed geometry`;
      }
      if (onSeed(row[j], payload.seed.instanceLine)) {
        return `${where} — the replacement sits on the seed itself`;
      }
    }
  }
  return null;
}

/**
 * The canonical statement text, first line unindented (the caller places it
 * at its indent), continuation rows at `indent` + two spaces:
 *
 *     replicate(cyl1, [bore1, crank.connectors.c2], [
 *       [bore2, crank.connectors.c3],
 *     ]);
 */
export function renderReplicateStatement(
  seed: string,
  targets: string[],
  rows: string[][],
  indent = '',
): string {
  const lines = [`replicate(${seed}, [${targets.join(', ')}], [`];
  for (const row of rows) {
    lines.push(`${indent}  [${row.join(', ')}],`);
  }
  lines.push(`${indent}]);`);
  return lines.join('\n');
}

/**
 * A parsed `replicate()` statement: its binding form (the text before the
 * call — `const x = `, `const [a, b] = `, or nothing), the verbatim source of
 * the seed, each target and each row cell.
 */
export type ParsedReplicate = {
  statement: TSNode;
  base: TSNode;
  prefix: string;
  seed: string;
  targets: string[];
  rows: string[][];
  /** The `const` name the whole array is bound to, when it is. */
  arrayBinding: string | null;
  /** Destructured names by row when bound as `const [a, b] = …` (holes null). */
  names: (string | null)[] | null;
};

function elementTexts(code: string, array: TSNode): string[] {
  return array.namedChildren
    .filter(c => c.type !== 'comment')
    .map(c => code.slice(c.startIndex, c.endIndex));
}

function parseReplicateAt(
  code: string,
  tree: TSTree,
  line: number,
): ParsedReplicate | { error: string } {
  const found = findBaseStatement(tree, line, 'replicate');
  if ('error' in found) {
    return found;
  }
  return parseReplicateStatement(code, found.statement, found.base, found.tail);
}

function parseReplicateStatement(
  code: string,
  statement: TSNode,
  base: TSNode,
  tail: TSNode,
): ParsedReplicate | { error: string } {
  const line = statement.startPosition.row + 1;
  const args = base.childForFieldName('arguments')?.namedChildren.filter(c => c.type !== 'comment') ?? [];
  if (args.length !== 3 || args[1].type !== 'array' || args[2].type !== 'array') {
    return { error: `the replicate() on line ${line} does not take the (seed, [targets], [rows]) form — edit it in the source` };
  }
  const rowNodes = args[2].namedChildren.filter(c => c.type !== 'comment');
  if (rowNodes.some(r => r.type !== 'array')) {
    return { error: `the replicate() on line ${line} has a row that is not an array — edit it in the source` };
  }
  let arrayBinding: string | null = null;
  let names: (string | null)[] | null = null;
  if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    if (name?.type === 'identifier') {
      arrayBinding = name.text;
    } else if (name?.type === 'array_pattern') {
      names = arrayPatternNames(name);
    } else {
      return { error: `the replicate() on line ${line} is not bound to a plain variable or an array pattern` };
    }
  }
  return {
    statement,
    base,
    prefix: code.slice(statement.startIndex, tail.startIndex),
    seed: code.slice(args[0].startIndex, args[0].endIndex),
    targets: elementTexts(code, args[1]),
    rows: rowNodes.map(r => elementTexts(code, r)),
    arrayBinding,
    names,
  };
}

/** Every `replicate()` statement in the tree (any scope), in document order. */
function allReplicateStatements(tree: TSTree): { statement: TSNode; base: TSNode; tail: TSNode }[] {
  const out: { statement: TSNode; base: TSNode; tail: TSNode }[] = [];
  const seen = new Set<number>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || baseCallName(node) !== 'replicate') {
      continue;
    }
    const statement = enclosingStatement(node);
    if (!statement || seen.has(statement.startIndex)) {
      continue;
    }
    const tail = findChainAt(tree, statement.startPosition.row + 1);
    if (!tail || chainBaseCall(tail).startIndex !== node.startIndex) {
      continue;
    }
    seen.add(statement.startIndex);
    out.push({ statement, base: node, tail });
  }
  return out;
}

/**
 * The first `replicate()` statement directly in `scope` whose seed is one of
 * `seedNames` — the mate writer places a new mate touching that seed BEFORE
 * it (a replicate snapshots its seed's mates in statement order).
 */
export function findReplicateStatementForSeeds(scope: TSNode, seedNames: string[]): TSNode | null {
  for (const child of scope.namedChildren) {
    if (child.type !== 'expression_statement' && child.type !== 'lexical_declaration' && child.type !== 'variable_declaration') {
      continue;
    }
    const call = findChainAt({ rootNode: child }, child.startPosition.row + 1);
    if (!call) {
      continue;
    }
    const base = chainBaseCall(call);
    if (baseCallName(base) !== 'replicate') {
      continue;
    }
    const seed = replicateSeedName(base);
    if (seed !== null && seedNames.includes(seed)) {
      return child;
    }
  }
  return null;
}

/**
 * Write, rewrite or shrink a `replicate()` statement — see
 * {@link AssemblyReplicateEditSpec}. Sides resolve through the same binding
 * rules as mate sides (bare statements get a `const` hoisted onto their own
 * line, so every line address stays valid across the resolution pass).
 */
export async function applyAssemblyReplicateEdit(
  code: string,
  spec: AssemblyReplicateEditSpec,
): Promise<AssemblyReplicateEditResult> {
  if (spec.removeRow) {
    return removeReplicateRow(code, spec.removeRow.sourceLine, spec.removeRow.row);
  }
  const payload = spec.create ?? spec.edit;
  if (!payload) {
    return { newCode: code, error: 'empty assembly-replicate spec' };
  }
  const invalid = validateReplicatePayload(payload);
  if (invalid) {
    return { newCode: code, error: invalid };
  }

  let working = code;
  const seed = await resolveInstanceBinding(working, payload.seed.instanceLine);
  if ('error' in seed) {
    return { newCode: code, error: seed.error };
  }
  working = seed.newCode;
  const anchorLines: number[] = [payload.seed.instanceLine];
  const resolveAll = async (sides: ReplicateSideRef[]): Promise<string[] | { error: string }> => {
    const out: string[] = [];
    for (const side of sides) {
      const resolved = await resolveSideExpression(working, side);
      if ('error' in resolved) {
        return resolved;
      }
      working = resolved.newCode;
      out.push(resolved.expression);
      anchorLines.push(sideAnchorLine(side));
    }
    return out;
  };
  const targets = await resolveAll(payload.targets);
  if ('error' in targets) {
    return { newCode: code, error: targets.error };
  }
  const rows: string[][] = [];
  for (const row of payload.rows) {
    const cells = await resolveAll(row);
    if ('error' in cells) {
      return { newCode: code, error: cells.error };
    }
    rows.push(cells);
  }

  const result = spec.edit
    ? await replaceReplicateStatement(working, spec.edit.sourceLine, seed.name, targets, rows, anchorLines)
    : await placeReplicateStatement(working, seed.name, targets, rows, anchorLines);
  if (result.error) {
    return { newCode: code, error: result.error };
  }
  return { newCode: await ensureSymbolImport(result.newCode, 'replicate') };
}

/**
 * A created statement lands directly after the seed's LAST `mate()` in the
 * seed's scope: it reads "insert, mates, replicate", and the kernel only
 * replicates mates that precede the statement. Every side's binding must be
 * visible from that scope.
 */
async function placeReplicateStatement(
  code: string,
  seedName: string,
  targets: string[],
  rows: string[][],
  anchorLines: number[],
): Promise<AssemblyReplicateEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const scope = scopeOfAnchor(tree, anchorLines[0]);
  if (!scope) {
    return { newCode: code, error: `could not resolve the insert() statement on line ${anchorLines[0]}` };
  }
  let lastMate: TSNode | null = null;
  for (const child of scope.namedChildren) {
    if (child.type !== 'expression_statement' && child.type !== 'lexical_declaration' && child.type !== 'variable_declaration') {
      continue;
    }
    const call = findChainAt({ rootNode: child }, child.startPosition.row + 1);
    if (!call || baseCallName(chainBaseCall(call)) !== 'mate') {
      continue;
    }
    if (statementMentions(child, seedName)) {
      lastMate = child;
    }
  }
  if (!lastMate) {
    return { newCode: code, error: `no mate() references ${seedName} in its scope — mate it first, then replicate` };
  }
  const hidden = firstHiddenAnchor(tree, lastMate, anchorLines);
  if (hidden !== null) {
    return {
      newCode: code,
      error: `the statement on line ${hidden} lives in a different assembly body than the seed — replicate onto targets the seed's scope can see`,
    };
  }
  const statement = renderReplicateStatement(seedName, targets, rows);
  return { newCode: insertStatementAfter(code, lastMate, statement) };
}

/** Re-render the statement at `sourceLine` in place, keeping its binding form. */
async function replaceReplicateStatement(
  code: string,
  sourceLine: number,
  seedName: string,
  targets: string[],
  rows: string[][],
  anchorLines: number[],
): Promise<AssemblyReplicateEditResult> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const parsed = parseReplicateAt(code, tree, sourceLine);
  if ('error' in parsed) {
    return { newCode: code, error: parsed.error };
  }
  const hidden = firstHiddenAnchor(tree, parsed.statement, anchorLines);
  if (hidden !== null) {
    return {
      newCode: code,
      error: `the statement on line ${hidden} lives in a different assembly body than this replicate — pick from the statement's own scope`,
    };
  }
  if (parsed.names && parsed.names.length > rows.length) {
    return {
      newCode: code,
      error: `the replicate() on line ${sourceLine} destructures ${parsed.names.length} replicas but the edit keeps ${rows.length} — remove the extra names from its const [...] first`,
    };
  }
  const indent = indentOf(splitLines(code), parsed.statement.startPosition.row);
  const statement = parsed.prefix + renderReplicateStatement(seedName, targets, rows, indent);
  return { newCode: spliceCode(code, parsed.statement.startIndex, parsed.statement.endIndex, statement) };
}

/**
 * The 1-based line of the first identifier use of `name` outside
 * `statement`, or null when the file has none — what a "binding still
 * referenced" refusal points at.
 */
function firstUseOutside(tree: TSTree, statement: TSNode, name: string): number | null {
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'identifier' || node.text !== name) {
      continue;
    }
    if (node.startIndex >= statement.startIndex && node.endIndex <= statement.endIndex) {
      continue;
    }
    const inImport = (() => {
      for (let cur: TSNode | null = node; cur; cur = cur.parent) {
        if (cur.type === 'import_statement') {
          return true;
        }
      }
      return false;
    })();
    if (inImport) {
      continue;
    }
    return node.startPosition.row + 1;
  }
  return null;
}

function referencedRefusal(tree: TSTree, statement: TSNode, names: (string | null)[]): string | null {
  for (const name of names) {
    if (name === null) {
      continue;
    }
    const line = firstUseOutside(tree, statement, name);
    if (line !== null) {
      return `${name} is used by the statement on line ${line} — delete that statement first`;
    }
  }
  return null;
}

/**
 * Drop one replica: splice its row (and its destructured name, if any) out
 * of the statement; the last row removes the statement — refused while its
 * binding is still referenced later in the file.
 */
export async function removeReplicateRow(
  code: string,
  sourceLine: number,
  row: number,
): Promise<AssemblyReplicateEditResult> {
  if (!Number.isInteger(row) || row < 0) {
    return { newCode: code, error: `replica row must be a non-negative integer, got ${row}` };
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const parsed = parseReplicateAt(code, tree, sourceLine);
  if ('error' in parsed) {
    return { newCode: code, error: parsed.error };
  }
  if (row >= parsed.rows.length) {
    return { newCode: code, error: `the replicate() on line ${sourceLine} has ${parsed.rows.length} ${parsed.rows.length === 1 ? 'replica' : 'replicas'} — there is no row ${row + 1}` };
  }
  if (parsed.rows.length === 1) {
    const bound = parsed.arrayBinding !== null ? [parsed.arrayBinding] : (parsed.names ?? []);
    const refused = referencedRefusal(tree, parsed.statement, bound);
    if (refused) {
      return { newCode: code, error: refused };
    }
    const removed = await removeStatement(code, sourceLine);
    return { newCode: removed.newCode };
  }
  let prefix = parsed.prefix;
  if (parsed.names) {
    const dropped = parsed.names[row] ?? null;
    const refused = referencedRefusal(tree, parsed.statement, [dropped]);
    if (refused) {
      return { newCode: code, error: refused };
    }
    const names = parsed.names.filter((_, i) => i !== row);
    prefix = `const [${names.map(n => n ?? '').join(', ')}] = `;
  }
  const rows = parsed.rows.filter((_, i) => i !== row);
  const indent = indentOf(splitLines(code), parsed.statement.startPosition.row);
  const statement = prefix + renderReplicateStatement(parsed.seed, parsed.targets, rows, indent);
  return { newCode: spliceCode(code, parsed.statement.startIndex, parsed.statement.endIndex, statement) };
}

/** Targets compare spelling-insensitively: `.parts.copies[1]` and `.parts.copies.1` name one export. */
const squash = canonicalChainText;

/**
 * The timeline / parts-panel / joints-panel "Delete" for assembly files:
 * {@link removeStatement} plus the replicate sweep the removed statement
 * implies —
 *
 * - deleting a seed's `insert()` also deletes every `replicate()` whose seed
 *   is that binding (the next render would otherwise throw a ReferenceError);
 * - deleting a seed's `mate()` drops the column its outer side occupied from
 *   every replicate of that seed (targets and rows); a replicate left with no
 *   column would only stack coincident copies on the seed, so it is removed.
 *
 * Bindings a removed replicate hoisted (`cyl1Replicas`) stay the user's to
 * resolve, exactly like a removed insert's binding.
 */
export async function removeStatementWithReplicateSweep(
  code: string,
  sourceLine: number,
): Promise<CodeEditResult> {
  if (!/\breplicate\s*\(/.test(code)) {
    return removeStatement(code, sourceLine);
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const call = findChainAt(tree, sourceLine);
  const statement = call ? enclosingStatement(call) : null;
  if (!call || !statement) {
    return removeStatement(code, sourceLine);
  }
  const base = chainBaseCall(call);
  const kind = baseCallName(base);
  let seedBinding: string | null = null;
  let mateSides: [string, string] | null = null;
  if (kind === 'insert' && (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration')) {
    const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
    const name = declarator?.childForFieldName('name');
    seedBinding = name?.type === 'identifier' ? name.text : null;
  } else if (kind === 'mate') {
    const args = base.childForFieldName('arguments')?.namedChildren.filter(c => c.type !== 'comment') ?? [];
    if (args.length === 3) {
      mateSides = [code.slice(args[1].startIndex, args[1].endIndex), code.slice(args[2].startIndex, args[2].endIndex)];
    }
  }
  const removed = await removeStatement(code, sourceLine);
  if (seedBinding !== null) {
    return { newCode: await sweepReplicatesOfSeed(removed.newCode, seedBinding) };
  }
  if (mateSides !== null) {
    return { newCode: await dropReplicateColumns(removed.newCode, mateSides) };
  }
  return removed;
}

/** Remove every `replicate()` whose seed argument is `seedBinding`, last first so earlier lines stay valid. */
async function sweepReplicatesOfSeed(code: string, seedBinding: string): Promise<string> {
  const parser = await getJavaScriptParser();
  let working = code;
  for (;;) {
    const tree = parser.parse(working);
    const doomed = allReplicateStatements(tree)
      .filter(r => replicateSeedName(r.base) === seedBinding)
      .pop();
    if (!doomed) {
      return working;
    }
    const line = doomed.statement.startPosition.row + 1;
    const result = await removeStatement(working, line);
    if (result.newCode === working) {
      return working;
    }
    working = result.newCode;
  }
}

/**
 * For a deleted mate with sides `[a, b]`: in every replicate whose seed is
 * the root binding of one side, the OTHER side is an outer target — drop
 * its column when the statement lists it. Processed last-statement-first
 * so each rewrite leaves earlier statements' positions intact.
 */
async function dropReplicateColumns(code: string, sides: [string, string]): Promise<string> {
  const parser = await getJavaScriptParser();
  const roots = sides.map(s => /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s)?.[0] ?? '');
  let working = code;
  const tree = parser.parse(working);
  const statements = allReplicateStatements(tree).reverse();
  for (const entry of statements) {
    const seed = replicateSeedName(entry.base);
    if (seed === null) {
      continue;
    }
    const outer = roots[0] === seed && roots[1] !== seed ? sides[1]
      : roots[1] === seed && roots[0] !== seed ? sides[0]
      : null;
    if (outer === null) {
      continue;
    }
    // Re-parse per statement: an earlier (later-in-file) rewrite changed
    // byte offsets, but this statement's start line is untouched.
    const current = parser.parse(working);
    const parsed = parseReplicateAt(working, current, entry.statement.startPosition.row + 1);
    if ('error' in parsed) {
      continue;
    }
    const column = parsed.targets.findIndex(t => squash(t) === squash(outer));
    if (column < 0) {
      continue;
    }
    const targets = parsed.targets.filter((_, j) => j !== column);
    if (targets.length === 0) {
      const removed = await removeStatement(working, parsed.statement.startPosition.row + 1);
      working = removed.newCode;
      continue;
    }
    const rows = parsed.rows.map(r => r.filter((_, j) => j !== column));
    const indent = indentOf(splitLines(working), parsed.statement.startPosition.row);
    const statement = parsed.prefix + renderReplicateStatement(parsed.seed, targets, rows, indent);
    working = spliceCode(working, parsed.statement.startIndex, parsed.statement.endIndex, statement);
  }
  return working;
}

/** Whether the file references `name` anywhere outside string literals — exported for route preflights. */
export function bindingInUse(code: string, name: string): boolean {
  return wordUsed(code, name);
}
