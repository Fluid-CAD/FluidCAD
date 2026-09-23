// Toggling a distance constraint's tangency flag in place.

import {
  findEditableCallAt,
  getJavaScriptParser,
  spliceCode,
  splitLines,
  type TSNode,
} from '../code-editor/index.ts';
import { calleeName, chainBase } from './ast.ts';

export type DistanceTangencySpec = {
  /** 1-indexed line of the distance() statement. */
  line: number;
  tangency: 'min' | 'max';
};

/**
 * Rewrite a distance() statement's tangency condition: strip any chained
 * `.max()`/`.min()` and append `.max()` when the far side is requested.
 * Min is the bare default — no `.min()` is written.
 */
export async function applyDistanceTangency(
  code: string,
  spec: DistanceTangencySpec,
): Promise<{ newCode: string; error?: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, spec.line);
  if (!call || calleeName(chainBase(call)) !== 'distance') {
    return { newCode: code, error: `line ${spec.line} is not a distance() statement` };
  }
  // Existing tangency segments in the chain, outermost first (walk order),
  // so back-to-front splices keep inner indices valid.
  const removals: { start: number; end: number }[] = [];
  let cur: TSNode | null = call;
  while (cur && cur.type === 'call_expression') {
    const fn = cur.childForFieldName('function');
    const obj = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    if (!obj || obj.type !== 'call_expression') {
      break;
    }
    const prop = fn!.childForFieldName('property');
    if (prop && (prop.text === 'max' || prop.text === 'min')) {
      removals.push({ start: obj.endIndex, end: cur.endIndex });
    }
    cur = obj;
  }
  let result = code;
  for (const r of removals) {
    result = spliceCode(result, r.start, r.end, '');
  }
  if (spec.tangency === 'max') {
    const removed = removals.reduce((sum, r) => sum + (r.end - r.start), 0);
    const at = call.endIndex - removed;
    result = spliceCode(result, at, at, '.max()');
  }
  return { newCode: result };
}
