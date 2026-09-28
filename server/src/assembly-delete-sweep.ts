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
} from './code-editor/index.ts';
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
import { isFollowCopyForm } from './apply-feature-edit/features/copy.ts';

/**
 * The timeline / parts-panel / joints-panel / connectors-rail "Delete" for
 * assembly files: {@link removeStatement} plus the sweep the removed
 * statement implies, so the next render never trips over a reference to
 * something that is gone —
 *
 * - deleting an `insert()` bound to a name also deletes every `mate()` that
 *   references that name (either side, through `.parts` chains included),
 *   every `replicate()` whose seed is that name, and every replicate row
 *   that points at it; a replicate left with no rows goes too. Names a
 *   removed replicate bound (`const [cyl2] = replicate(…)`) are swept the
 *   same way, so mates on a replica of the deleted part vanish with it;
 * - deleting a `mate()` drops the column its outer side occupied from every
 *   replicate of the seed it touched (targets and rows); a replicate left with
 *   no column would only stack coincident copies on the seed, so it is removed;
 * - deleting a `connector()` bound to a name deletes what names it — mates,
 *   replicate cells, and the `copy()` statements that copy it or turn around
 *   it — and deleting a `copy()` deletes what calls `.instance()` on one of
 *   its connectors ({@link ConnectorReferenceSweep}).
 *
 * A replicate removed by any branch orphans the names it bound; those are
 * swept the same way. Bindings the user hoisted for other purposes (`const m
 * = mate(…)` used elsewhere) stay theirs to resolve.
 */
export async function removeStatementWithAssemblySweep(
  code: string,
  sourceLine: number,
): Promise<CodeEditResult> {
  // Nothing in the file can refer to what the statement made: no mate, no
  // replicate, and no copy() of a connector or its copies.
  if (!/\b(?:mate|replicate|copy)\s*\(/.test(code)) {
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
  let connectorBinding: string | null = null;
  let copySeeds: string[] = [];
  if (kind === 'insert') {
    binding = declaredName(statement);
  } else if (kind === 'mate') {
    mateSides = mateSideTexts(code, base);
  } else if (kind === 'connector') {
    connectorBinding = declaredName(statement);
  } else if (kind === 'copy') {
    copySeeds = ConnectorReferenceSweep.copySeeds(base);
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
  if (connectorBinding !== null) {
    return { newCode: await ConnectorReferenceSweep.afterConnector(removed.newCode, connectorBinding) };
  }
  if (copySeeds.length > 0) {
    return { newCode: await ConnectorReferenceSweep.afterCopy(removed.newCode, copySeeds) };
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
    working = await sweepMatesWhere(working, statement => statementMentions(statement, name));
    const seeded = await sweepReplicatesOfSeed(working, name);
    working = seeded.code;
    pending.push(...seeded.bindings);
    const trimmed = await dropReplicateReferences(working, expression => expressionRoot(expression) === name);
    working = trimmed.code;
    pending.push(...trimmed.bindings);
  }
  return working;
}

/**
 * Remove every `mate()` statement `matches` — one that mentions a doomed
 * name, say — last first so earlier lines stay valid. Each goes through the
 * mate branch of the sweep, so a replicate of the OTHER side loses the
 * column that mate occupied.
 */
async function sweepMatesWhere(code: string, matches: (statement: TSNode) => boolean): Promise<string> {
  const parser = await getJavaScriptParser();
  let working = code;
  for (;;) {
    const tree = parser.parse(working);
    const doomed = allBaseStatements(tree, 'mate')
      .filter(m => matches(m.statement))
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
 * `matches` — an expression rooted at a doomed name, say; a statement left
 * without a column or a row is removed. Reports the destructured names of
 * dropped rows, which dangle once their row is gone.
 */
async function dropReplicateReferences(
  code: string,
  matches: (expression: string) => boolean,
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
    const keptColumns = parsed.targets.map(t => !matches(t));
    const keptRows = parsed.rows.map(r => r.every((cell, j) => !keptColumns[j] || !matches(cell)));
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

/**
 * What a sweep deletes references to: a connector's binding itself — every
 * expression rooted at it, `bay` and `bay.instance(2)` alike — or, with
 * `copiesOnly`, only the copies addressed on it (`bay.instance(2)`), which
 * throw "has no copies" once the `copy()` that made them is gone.
 */
type DoomedReference = { binding: string; copiesOnly: boolean };

/**
 * The connector half of the delete sweep (connector copies D11), same file
 * only — a part connector named from an assembly file stays unswept, like
 * any part connector: it fails with a clear error instead.
 *
 * - A removed `connector()` takes every mate and replicate cell that names
 *   its binding, and every `copy()` naming it: a copy that lists it among its
 *   targets drops that target (and goes with its last one); a copy turning
 *   around it has nothing left to follow and goes whole.
 * - A removed `copy()` takes every mate and replicate cell that calls
 *   `.instance()` on one of its connectors, and every `copy()` whose axis
 *   does — each copy removed that way sweeps its own connectors' copies in
 *   turn.
 */
class ConnectorReferenceSweep {
  /**
   * The connectors a `copy()` call copies, by their bindings: the plain
   * identifiers among its targets ({@link copyArgs}).
   */
  static copySeeds(base: TSNode): string[] {
    return ConnectorReferenceSweep.copyArgs(ConnectorReferenceSweep.args(base)).targets
      .filter(arg => arg.type === 'identifier')
      .map(arg => arg.text);
  }

  /**
   * A `copy()` call's arguments by the part they play: what the copies are
   * laid `along` — a reference there takes the whole statement — and the
   * `targets` it copies. `copy(kind, axis | [axes], options, …targets)` lays
   * them along its axes; the follow form, `copy(pattern, …connectors)`, along
   * the repeat standing where the kind goes, its connectors from the second
   * argument on. The follow form is part-only and never copies an assembly
   * connector, but it is never read by position as the other forms are.
   * `args` are the call's own ({@link args}) — splices find targets in it.
   */
  private static copyArgs(args: TSNode[]): { along: TSNode[]; targets: TSNode[] } {
    if (isFollowCopyForm(args)) {
      return { along: args.slice(0, 1), targets: args.slice(1) };
    }
    return { along: ConnectorReferenceSweep.axisNodes(args[1]), targets: args.slice(3) };
  }

  /** A `connector()` bound to `binding` is gone. */
  static async afterConnector(code: string, binding: string): Promise<string> {
    const working = await sweepBinding(code, binding);
    return ConnectorReferenceSweep.sweepCopies(working, { binding, copiesOnly: false });
  }

  /** A `copy()` of the connectors bound to `seeds` is gone. */
  static async afterCopy(code: string, seeds: string[]): Promise<string> {
    let working = code;
    for (const binding of seeds) {
      const doomed: DoomedReference = { binding, copiesOnly: true };
      working = await sweepMatesWhere(working, statement => ConnectorReferenceSweep.statementNames(statement, doomed));
      const trimmed = await dropReplicateReferences(
        working,
        expression => ConnectorReferenceSweep.expressionNames(expression, doomed),
      );
      working = trimmed.code;
      for (const orphan of trimmed.bindings) {
        working = await sweepBinding(working, orphan);
      }
      working = await ConnectorReferenceSweep.sweepCopies(working, doomed);
    }
    return working;
  }

  /**
   * Every `copy()` naming `doomed`, last first so earlier lines stay valid:
   * an axis — or a followed repeat — naming it removes the statement (and
   * sweeps the copies it made of its other connectors); targets naming it
   * are dropped from the argument list, the statement going with its last
   * one.
   */
  private static async sweepCopies(code: string, doomed: DoomedReference): Promise<string> {
    const parser = await getJavaScriptParser();
    let working = code;
    for (;;) {
      const tree = parser.parse(working);
      const entry = allBaseStatements(tree, 'copy')
        .filter(c => ConnectorReferenceSweep.copyNames(c.base, doomed))
        .pop();
      if (!entry) {
        return working;
      }
      const args = ConnectorReferenceSweep.args(entry.base);
      const line = entry.statement.startPosition.row + 1;
      const { along, targets } = ConnectorReferenceSweep.copyArgs(args);
      const alongNamed = along.some(arg => ConnectorReferenceSweep.expressionNames(arg.text, doomed));
      const keptTargets = targets.filter(arg => !ConnectorReferenceSweep.expressionNames(arg.text, doomed));
      let next: string;
      if (alongNamed || keptTargets.length === 0) {
        next = (await removeStatement(working, line)).newCode;
        // The copies it made of its other connectors went with it — a
        // connector swept by name already took its own.
        const others = ConnectorReferenceSweep.copySeeds(entry.base)
          .filter(seed => doomed.copiesOnly || seed !== doomed.binding);
        if (alongNamed && others.length > 0) {
          next = await ConnectorReferenceSweep.afterCopy(next, others);
        }
      } else {
        next = ConnectorReferenceSweep.dropArguments(working, args, targets.filter(arg => !keptTargets.includes(arg)));
      }
      if (next === working) {
        return working;
      }
      working = next;
    }
  }

  /** Whether a `copy()` call names `doomed` as what it copies along or among its targets. */
  private static copyNames(base: TSNode, doomed: DoomedReference): boolean {
    const { along, targets } = ConnectorReferenceSweep.copyArgs(ConnectorReferenceSweep.args(base));
    return [...along, ...targets].some(arg => ConnectorReferenceSweep.expressionNames(arg.text, doomed));
  }

  /** A copy's axis arguments — the elements of a linear copy's axis list, or the one axis. */
  private static axisNodes(axis: TSNode | undefined): TSNode[] {
    if (!axis) {
      return [];
    }
    if (axis.type === 'array') {
      return axis.namedChildren.filter(c => c.type !== 'comment');
    }
    return [axis];
  }

  /** Whether an argument or cell expression names `doomed`. */
  private static expressionNames(expression: string, doomed: DoomedReference): boolean {
    if (!doomed.copiesOnly) {
      return expressionRoot(expression) === doomed.binding;
    }
    return canonicalChainText(expression).startsWith(`${doomed.binding}.instance(`);
  }

  /** Whether a statement names `doomed` anywhere in it — a mate's side, say. */
  private static statementNames(statement: TSNode, doomed: DoomedReference): boolean {
    if (!doomed.copiesOnly) {
      return statementMentions(statement, doomed.binding);
    }
    for (const node of walkTree(statement)) {
      if (node.type !== 'call_expression') {
        continue;
      }
      const fn = node.childForFieldName('function');
      if (fn?.type !== 'member_expression') {
        continue;
      }
      const object = fn.childForFieldName('object');
      const property = fn.childForFieldName('property');
      if (object?.type === 'identifier' && object.text === doomed.binding && property?.text === 'instance') {
        return true;
      }
    }
    return false;
  }

  /** A call's arguments, comments left out. */
  private static args(call: TSNode): TSNode[] {
    return call.childForFieldName('arguments')?.namedChildren.filter(c => c.type !== 'comment') ?? [];
  }

  /**
   * Splice `doomed` out of the argument list `args`, each with the comma
   * before it — a copy's targets always follow its options, or the follow
   * form's repeat, so there is one. Last first, so earlier offsets stay valid.
   */
  private static dropArguments(code: string, args: TSNode[], doomed: TSNode[]): string {
    let working = code;
    for (const arg of [...doomed].sort((a, b) => b.startIndex - a.startIndex)) {
      const previous = args[args.indexOf(arg) - 1];
      working = spliceCode(working, previous.endIndex, arg.endIndex, '');
    }
    return working;
  }
}
