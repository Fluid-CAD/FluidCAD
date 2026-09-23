// Decomposing a member-call chain (`extrude(...).cut().region(...)`) into its root and segments.

import type { TSNode } from '../../code-editor/index.ts';

export type ChainSegment = { name: string; args: TSNode[]; argsText: string; endIndex: number };

/** Split a call chain into its root call and member calls, in source order. */
export function decomposeChain(call: TSNode): { root: ChainSegment; members: ChainSegment[] } | null {
  const segments: ChainSegment[] = [];
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const argsNode = current.childForFieldName('arguments');
    const args = argsNode ? argsNode.namedChildren.filter(a => a.type !== 'comment') : [];
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      segments.push({ name: fn.text, args, argsText: argsNode?.text.slice(1, -1) ?? '', endIndex: current.endIndex });
      segments.reverse();
      const [root, ...members] = segments;
      return { root, members };
    }
    if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (!prop) {
        return null;
      }
      segments.push({ name: prop.text, args, argsText: argsNode?.text.slice(1, -1) ?? '', endIndex: current.endIndex });
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}
