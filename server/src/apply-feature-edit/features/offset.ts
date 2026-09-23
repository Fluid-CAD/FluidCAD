// offset(): option types, statement rendering and the sketch target descriptor parser.

import {
  findEditableCallAt,
  getJavaScriptParser,
  splitLines,
  walkTree,
  type TSNode,
} from '../../code-editor/index.ts';
import { booleanArgValue, numericValueArg, numericVarNames } from '../ast/args.ts';
import { decomposeChain } from '../ast/chain.ts';
import { formatValue, type ValueExpr } from '../value-expr.ts';

/**
 * A 2D offset statement's own option: `close` chains `.close()`, capping an
 * open offset back onto its source profile.
 */
export type OffsetEditOptions = {
  close: boolean;
};

/**
 * A 2D offset statement: `offset(2, r.edge('top'))`, with an optional
 * trailing `.close()`. An empty `args` is the whole-sketch form — `offset(2)`
 * — which only the in-place edit of a target-less statement produces.
 */
export function renderOffsetStatement(
  value: ValueExpr | undefined,
  args: string,
  offset: OffsetEditOptions | undefined,
): string {
  const chain = offset?.close ? '.close()' : '';
  return args ? `offset(${formatValue(value)}, ${args})${chain}` : `offset(${formatValue(value)})${chain}`;
}

/**
 * Mirror of the kernel's `SketchTargetDescriptor` — one parsed target
 * argument of a 2D offset statement, ready for geometric resolution.
 */
export type SketchTargetDescriptor =
  | { kind: 'owner'; line: number }
  | { kind: 'accessor'; line: number; args: (string | number)[] }
  | { kind: 'filter'; calls: { name: string; dim: number | null }[] };

/**
 * Parse the 2D statement (offset, fillet, text, copy or mirror) at `line` into
 * target descriptors for the edit dialog's edge seeding: bare producer
 * variables, `r.edge(…)` accessor calls with literal arguments, and
 * `edge().<kind>(…)` filter chains — the forms selector synthesis emits.
 * Anything else refuses (the dialog then keeps its keep chip, exactly the
 * unseeded behavior). An empty target list (the whole-sketch offset, a
 * last-selection fillet) resolves to no descriptors.
 */
export async function parseOffsetTargetDescriptors(
  code: string,
  line: number,
): Promise<{ ok: true; descriptors: SketchTargetDescriptor[]; feature: string } | { ok: false; reason: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call) {
    return { ok: false, reason: `no call found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = decomposeChain(call);
  if (!chain || (chain.root.name !== 'offset' && chain.root.name !== 'fillet'
    && chain.root.name !== 'text' && chain.root.name !== 'copy' && chain.root.name !== 'mirror')) {
    return { ok: false, reason: 'the statement at that line is not an offset, fillet, text, copy or mirror' };
  }
  const args = chain.root.args;
  const numericVars = numericVarNames(tree);
  let selectorsFrom = 0;
  let selectorsTo = args.length;
  if (chain.root.name === 'copy') {
    // `copy('<kind>', <axis|center>, {…}, …targets)` — only the trailing
    // targets seed; a target-less copy seeds nothing (the whole-sketch form).
    selectorsFrom = Math.min(args.length, 3);
  } else if (chain.root.name === 'mirror') {
    // `mirror(<axis>, …targets)` — the axis line is a slot of its own, never
    // a target; a target-less mirror seeds nothing (the whole-sketch form).
    selectorsFrom = Math.min(args.length, 1);
  } else if (chain.root.name === 'text') {
    // `text("…"[, <path>])` — only the path argument seeds; a plain anchored
    // text has nothing nameable (descriptors: [], like a whole-sketch offset).
    selectorsFrom = 1;
    selectorsTo = Math.min(args.length, 2);
  } else if (args.length > 0 && numericValueArg(args[0], numericVars) !== null) {
    // The offset's value and removeOriginal slots, exactly as
    // parseFeatureChain reads them.
    selectorsFrom = 1;
    if (args.length > 1 && booleanArgValue(args[1]) !== null) {
      selectorsFrom = 2;
    }
  }

  /** The declaration line of `name` before the statement, or null. */
  const declarationLine = (name: string): number | null => {
    const matches: TSNode[] = [];
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === 'variable_declarator' && node.startIndex < call.startIndex
        && node.childForFieldName('name')?.text === name) {
        matches.push(node);
      }
    }
    return matches.length === 1 ? matches[0].startPosition.row + 1 : null;
  };

  const descriptors: SketchTargetDescriptor[] = [];
  for (const arg of args.slice(selectorsFrom, selectorsTo)) {
    if (arg.type === 'identifier') {
      const declLine = declarationLine(arg.text);
      if (declLine === null) {
        return { ok: false, reason: `\`${arg.text}\` does not resolve to one statement before the offset` };
      }
      descriptors.push({ kind: 'owner', line: declLine });
      continue;
    }
    if (arg.type !== 'call_expression') {
      return { ok: false, reason: `the target \`${arg.text}\` is not a form the dialog can resolve` };
    }
    // A filter chain roots at the bare `edge()` call: edge().line(5) / edge().arc().
    const argChain = decomposeChain(arg);
    if (argChain && argChain.root.name === 'edge' && argChain.root.args.length === 0) {
      const calls: { name: string; dim: number | null }[] = [];
      for (const member of argChain.members) {
        if (member.args.length > 1) {
          return { ok: false, reason: `the filter \`${arg.text}\` is not a form the dialog can resolve` };
        }
        const dim = member.args.length === 1 ? literalNumber(member.args[0]) : null;
        if (member.args.length === 1 && dim === null) {
          return { ok: false, reason: `the filter \`${arg.text}\` is not a form the dialog can resolve` };
        }
        calls.push({ name: member.name, dim });
      }
      descriptors.push({ kind: 'filter', calls });
      continue;
    }
    // An accessor call on a bound variable: r.edge('top') / r.edge('side', 2)
    // / r.edge(3). (decomposeChain returns null for these — the chain roots
    // at the identifier, not a call.)
    const fn = arg.childForFieldName('function');
    const object = fn?.childForFieldName('object');
    const property = fn?.childForFieldName('property');
    if (fn?.type !== 'member_expression' || object?.type !== 'identifier' || property?.text !== 'edge') {
      return { ok: false, reason: `the target \`${arg.text}\` is not a form the dialog can resolve` };
    }
    const declLine = declarationLine(object.text);
    if (declLine === null) {
      return { ok: false, reason: `\`${object.text}\` does not resolve to one statement before the offset` };
    }
    const argsNode = arg.childForFieldName('arguments');
    const accessorArgs: (string | number)[] = [];
    for (const accessorArg of argsNode ? argsNode.namedChildren.filter(a => a.type !== 'comment') : []) {
      if (accessorArg.type === 'string') {
        accessorArgs.push(accessorArg.text.slice(1, -1));
        continue;
      }
      const value = literalNumber(accessorArg);
      if (value === null) {
        return { ok: false, reason: `the target \`${arg.text}\` is not a form the dialog can resolve` };
      }
      accessorArgs.push(value);
    }
    descriptors.push({ kind: 'accessor', line: declLine, args: accessorArgs });
  }
  return { ok: true, descriptors, feature: chain.root.name };
}

/** A plain numeric literal's value, or null for any other expression. */
function literalNumber(node: TSNode): number | null {
  const value = Number(node.text);
  return node.type === 'number' && Number.isFinite(value) ? value : null;
}
