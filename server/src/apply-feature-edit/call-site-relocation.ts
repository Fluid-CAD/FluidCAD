// Following call-site lines across a source edit by callee ordinal.

import { findEditableCallAt, getJavaScriptParser, splitLines, walkTree, type TSNode, type TSTree } from '../code-editor.ts';
import { chainRootCall } from './ast/nodes.ts';

/**
 * Follow call-site lines across an edit that neither adds nor removes
 * calls of THEIR callees: each line's root call is identified by callee
 * name and document ordinal before the edit and looked up by the same
 * ordinal after it. Null when a line holds no identifier-rooted call or
 * the callee's call count changed.
 */
export async function relocateCallLines(
  before: string,
  after: string,
  lines: number[],
): Promise<Map<number, number> | null> {
  const parser = await getJavaScriptParser();
  const treeBefore = parser.parse(before);
  const linesBefore = splitLines(before);
  const callsBefore = rootCallsByCallee(treeBefore);
  const callsAfter = rootCallsByCallee(parser.parse(after));
  const map = new Map<number, number>();
  for (const line of new Set(lines)) {
    const call = findEditableCallAt(treeBefore, linesBefore, line);
    const root = call ? chainRootCall(call) : null;
    const callee = root?.childForFieldName('function')?.text ?? null;
    if (!root || callee === null) {
      return null;
    }
    const ordinal = callsBefore.get(callee)!.findIndex(c => c.startIndex === root.startIndex);
    const candidates = callsAfter.get(callee) ?? [];
    if (ordinal < 0 || candidates.length !== callsBefore.get(callee)!.length) {
      return null;
    }
    map.set(line, candidates[ordinal].startPosition.row + 1);
  }
  return map;
}

/** Identifier-rooted calls grouped by callee, each list in document order. */
export function rootCallsByCallee(tree: TSTree): Map<string, TSNode[]> {
  const out = new Map<string, TSNode[]>();
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const fn = node.childForFieldName('function');
    if (fn?.type !== 'identifier') {
      continue;
    }
    const list = out.get(fn.text) ?? [];
    list.push(node);
    out.set(fn.text, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.startIndex - b.startIndex);
  }
  return out;
}
