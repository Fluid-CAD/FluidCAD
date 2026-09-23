// Locating and parsing the feature statement at a source line.

import {
  findEditableCallAt,
  getJavaScriptParser,
  splitLines,
  walkTree,
  type TSNode,
} from '../../code-editor.ts';
import { numericVarNames } from '../ast/args.ts';
import { parseFeatureChain } from './feature-chain.ts';
import type { ParsedFeatureStatement } from './parsed-statement.ts';

/**
 * Read the feature statement at `line` of `code` into its dialog-editable
 * options — the read half of the double-click → edit-dialog round trip.
 * `statement` is the chain text the dialog would rewrite, for display.
 */
export async function parseFeatureStatement(
  code: string,
  line: number,
): Promise<{ ok: true; parsed: ParsedFeatureStatement; statement: string } | { ok: false; reason: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call) {
    return { ok: false, reason: `no call found at line ${line} — is the file in sync with the last render?` };
  }
  const chain = parseFeatureChain(call, code, numericVarNames(tree));
  if ('error' in chain) {
    return { ok: false, reason: chain.error };
  }
  return { ok: true, parsed: chain.parsed, statement: code.slice(chain.start, chain.end) };
}

/**
 * Resolve the 1-based line of an edited statement, healing line drift by
 * content. Opening the 2D offset's edit dialog pauses the build by inserting
 * `breakpoint();` ABOVE the statement (the paused sketch is the one the
 * statement's arguments see), which shifts the statement down after the
 * dialog captured its location. The exact chain text the dialog holds still
 * identifies it: when the line lookup misses or reads different text, a
 * unique whole-file match of `expectedStatement` is that statement, moved.
 * No match, or an ambiguous one, keeps the original line — the caller's own
 * drift guard reports it.
 */
export async function resolveEditedStatementLine(
  code: string,
  line: number,
  expectedStatement: string | undefined,
): Promise<number> {
  if (expectedStatement === undefined) {
    return line;
  }
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const numericVars = numericVarNames(tree);
  const chainTextOf = (call: TSNode): string | null => {
    const chain = parseFeatureChain(call, code, numericVars);
    return 'error' in chain ? null : code.slice(chain.start, chain.end);
  };
  const atLine = findEditableCallAt(tree, lines, line);
  if (atLine && chainTextOf(atLine) === expectedStatement) {
    return line;
  }
  // findEditableCallAt's own pick — the outermost call starting on a row —
  // over every row, then a unique exact-text match wins.
  const rootByRow = new Map<number, TSNode>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const row = node.startPosition.row;
    const best = rootByRow.get(row);
    if (!best || node.endIndex > best.endIndex) {
      rootByRow.set(row, node);
    }
  }
  const matches: number[] = [];
  for (const [row, call] of rootByRow) {
    if (chainTextOf(call) === expectedStatement) {
      matches.push(row + 1);
    }
  }
  return matches.length === 1 ? matches[0] : line;
}
