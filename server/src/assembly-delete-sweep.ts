import {
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
  baseCallName,
  canonicalChainText,
  chainBaseCall,
  enclosingStatement,
  expressionRoot,
  findChainAt,
  replicateSeedName,
  statementMentions,
} from './assembly-chain-tools.ts';
import { parseReplicateAt, renderReplicateStatement, type ParsedReplicate } from './assembly-replicate-edit.ts';

/**
 * The timeline / parts-panel / joints-panel "Delete" for assembly files:
 * {@link removeStatement} plus the sweep the removed statement implies, so
 * the next render never trips over a reference to something that is gone —
 *
 * - deleting an `insert()` bound to a name also deletes every `mate()` that
 *   references that name (either side, through `.parts` chains included),
 *   every `replicate()` whose seed is that name, and every replicate row
 *   that points at it; a replicate left with no rows goes too. Names a
 *   removed replicate bound (`const [cyl2] = replicate(…)`) are swept the
 *   same way, so mates on a replica of the deleted part vanish with it;
 * - deleting a `mate()` drops the column its outer side occupied from every
 *   replicate of the seed it touched (targets and rows); a replicate left with
 *   no column would only stack coincident copies on the seed, so it is removed.
 *
 * A replicate removed by either branch orphans the names it bound; those
 * are swept the same way. Bindings the user hoisted for other purposes
 * (`const m = mate(…)` used elsewhere) stay theirs to resolve.
 */
export async function removeStatementWithAssemblySweep(
  code: string,
  sourceLine: number,
): Promise<CodeEditResult> {
  if (!/\b(?:mate|replicate)\s*\(/.test(code)) {
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
  let binding: string | null = null;
  let mateSides: [string, string] | null = null;
  if (kind === 'insert') {
    binding = declaredName(statement);
  } else if (kind === 'mate') {
    mateSides = mateSideTexts(code, base);
  }
  const removed = await removeStatement(code, sourceLine);
  if (binding !== null) {
    return { newCode: await sweepBinding(removed.newCode, binding) };
  }
  if (mateSides !== null) {
    const dropped = await dropReplicateColumns(removed.newCode, mateSides);
    let working = dropped.code;
    for (const orphan of dropped.bindings) {
      working = await sweepBinding(working, orphan);
    }
    return { newCode: working };
  }
  return removed;
}

/** The plain identifier a `const x = …` statement binds, or null for any other form. */
function declaredName(statement: TSNode): string | null {
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return null;
  }
  const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  return name?.type === 'identifier' ? name.text : null;
}

/** The two side expressions of a `mate(type, a, b)` call, verbatim. */
function mateSideTexts(code: string, base: TSNode): [string, string] | null {
  const args = base.childForFieldName('arguments')?.namedChildren.filter(c => c.type !== 'comment') ?? [];
  if (args.length !== 3) {
    return null;
  }
  return [code.slice(args[1].startIndex, args[1].endIndex), code.slice(args[2].startIndex, args[2].endIndex)];
}

type BaseStatement = { statement: TSNode; base: TSNode };

/** Every statement whose chain bottoms out in `<name>(…)` (any scope), in document order. */
function allBaseStatements(tree: TSTree, name: string): BaseStatement[] {
  const out: BaseStatement[] = [];
  const seen = new Set<number>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression' || baseCallName(node) !== name) {
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
    out.push({ statement, base: node });
  }
  return out;
}

/**
 * Remove everything that references `binding` — mates, replicates it seeds,
 * replicate rows that point at it — and recurse into the names those
 * replicates bound, which dangle once their statement is gone.
 */
async function sweepBinding(code: string, binding: string): Promise<string> {
  let working = code;
  const pending = [binding];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    working = await sweepMatesMentioning(working, name);
    const seeded = await sweepReplicatesOfSeed(working, name);
    working = seeded.code;
    pending.push(...seeded.bindings);
    const trimmed = await dropReplicateReferences(working, name);
    working = trimmed.code;
    pending.push(...trimmed.bindings);
  }
  return working;
}

/**
 * Remove every `mate()` that mentions `name`, last first so earlier lines
 * stay valid. Each goes through the mate branch of the sweep, so a
 * replicate of the OTHER side loses the column that mate occupied.
 */
async function sweepMatesMentioning(code: string, name: string): Promise<string> {
  const parser = await getJavaScriptParser();
  let working = code;
  for (;;) {
    const tree = parser.parse(working);
    const doomed = allBaseStatements(tree, 'mate')
      .filter(m => statementMentions(m.statement, name))
      .pop();
    if (!doomed) {
      return working;
    }
    const result = await removeStatementWithAssemblySweep(working, doomed.statement.startPosition.row + 1);
    if (result.newCode === working) {
      return working;
    }
    working = result.newCode;
  }
}

/** Remove every `replicate()` whose seed argument is `seedBinding`, last first; reports the names they bound. */
async function sweepReplicatesOfSeed(
  code: string,
  seedBinding: string,
): Promise<{ code: string; bindings: string[] }> {
  const parser = await getJavaScriptParser();
  const bindings: string[] = [];
  let working = code;
  for (;;) {
    const tree = parser.parse(working);
    const doomed = allBaseStatements(tree, 'replicate')
      .filter(r => replicateSeedName(r.base) === seedBinding)
      .pop();
    if (!doomed) {
      return { code: working, bindings };
    }
    const line = doomed.statement.startPosition.row + 1;
    const parsed = parseReplicateAt(working, tree, line);
    if (!('error' in parsed)) {
      bindings.push(...boundNames(parsed));
    }
    const result = await removeStatement(working, line);
    if (result.newCode === working) {
      return { code: working, bindings };
    }
    working = result.newCode;
  }
}

function boundNames(parsed: ParsedReplicate): string[] {
  if (parsed.arrayBinding !== null) {
    return [parsed.arrayBinding];
  }
  return (parsed.names ?? []).filter((n): n is string => n !== null);
}

/**
 * In every replicate, drop the columns whose target and the rows whose cell
 * point at `name` (its member chain's root); a statement left without a
 * column or a row is removed. Reports the destructured names of dropped
 * rows, which dangle once their row is gone.
 */
async function dropReplicateReferences(
  code: string,
  name: string,
): Promise<{ code: string; bindings: string[] }> {
  const parser = await getJavaScriptParser();
  const bindings: string[] = [];
  let working = code;
  const statements = allBaseStatements(parser.parse(working), 'replicate').reverse();
  for (const entry of statements) {
    // Re-parse per statement: a later-in-file rewrite changed byte offsets,
    // but this statement's start line is untouched.
    const parsed = parseReplicateAt(working, parser.parse(working), entry.statement.startPosition.row + 1);
    if ('error' in parsed) {
      continue;
    }
    const keptColumns = parsed.targets.map(t => expressionRoot(t) !== name);
    const keptRows = parsed.rows.map(r => r.every((cell, j) => !keptColumns[j] || expressionRoot(cell) !== name));
    if (keptColumns.every(Boolean) && keptRows.every(Boolean)) {
      continue;
    }
    const targets = parsed.targets.filter((_, j) => keptColumns[j]);
    const rows = parsed.rows.filter((_, k) => keptRows[k]).map(r => r.filter((_, j) => keptColumns[j]));
    if (parsed.names) {
      bindings.push(...parsed.names.filter((n, k): n is string => n !== null && !keptRows[k]));
    }
    if (targets.length === 0 || rows.length === 0) {
      bindings.push(...boundNames(parsed));
      working = (await removeStatement(working, parsed.statement.startPosition.row + 1)).newCode;
      continue;
    }
    working = rewriteReplicate(working, parsed, targets, rows, parsed.names?.filter((_, k) => keptRows[k]) ?? null);
  }
  return { code: working, bindings };
}

/**
 * For a deleted mate with sides `[a, b]`: in every replicate whose seed is
 * the root binding of one side, the OTHER side is an outer target — drop
 * its column when the statement lists it. Processed last-statement-first
 * so each rewrite leaves earlier statements' positions intact. Reports the
 * names a removed statement bound.
 */
async function dropReplicateColumns(
  code: string,
  sides: [string, string],
): Promise<{ code: string; bindings: string[] }> {
  const parser = await getJavaScriptParser();
  const roots = sides.map(expressionRoot);
  const bindings: string[] = [];
  let working = code;
  const statements = allBaseStatements(parser.parse(working), 'replicate').reverse();
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
    const parsed = parseReplicateAt(working, parser.parse(working), entry.statement.startPosition.row + 1);
    if ('error' in parsed) {
      continue;
    }
    // Targets compare spelling-insensitively: `.parts.copies[1]` and `.parts.copies.1` name one export.
    const column = parsed.targets.findIndex(t => canonicalChainText(t) === canonicalChainText(outer));
    if (column < 0) {
      continue;
    }
    const targets = parsed.targets.filter((_, j) => j !== column);
    if (targets.length === 0) {
      bindings.push(...boundNames(parsed));
      working = (await removeStatement(working, parsed.statement.startPosition.row + 1)).newCode;
      continue;
    }
    const rows = parsed.rows.map(r => r.filter((_, j) => j !== column));
    working = rewriteReplicate(working, parsed, targets, rows, parsed.names);
  }
  return { code: working, bindings };
}

/** Re-render `parsed` in place with new targets/rows; `names` is the surviving `const [...]` pattern, if any. */
function rewriteReplicate(
  code: string,
  parsed: ParsedReplicate,
  targets: string[],
  rows: string[][],
  names: (string | null)[] | null,
): string {
  const prefix = parsed.names && names
    ? `const [${names.map(n => n ?? '').join(', ')}] = `
    : parsed.prefix;
  const indent = indentOf(splitLines(code), parsed.statement.startPosition.row);
  const statement = prefix + renderReplicateStatement(parsed.seed, targets, rows, indent);
  return spliceCode(code, parsed.statement.startIndex, parsed.statement.endIndex, statement);
}
