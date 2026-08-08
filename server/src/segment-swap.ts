import {
  findEditableCallAt,
  getJavaScriptParser,
  splitLines,
  spliceCode,
  ensureSymbolImport,
  type TSNode,
} from './code-editor.ts';

/**
 * Chain-root callees a segment conversion may replace or emit — the flat
 * sketch-segment statements whose chaining is implicit.
 */
export const CHAIN_CALLEES = new Set(['line', 'hLine', 'vLine', 'tLine', 'aLine', 'arc', 'tArc']);

export type SegmentSwapSpec = {
  edit: { filePath: string; line: number };
  /** The chain text the conversion menu was computed against (drift guard). */
  expectedStatement: string;
  /** The fully rendered replacement chain, e.g. `aLine(45, 141.42)`. */
  newStatement: string;
};

export type SegmentSwapResult = { newCode: string; error?: string };

/** The innermost call of a chain whose callee is a bare identifier, or null. */
export function rootCallOf(call: TSNode): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return current;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}

/** The bare-identifier callee at the root of a call chain, or null. */
function rootCalleeOf(call: TSNode): string | null {
  const root = rootCallOf(call);
  return root?.childForFieldName('function')?.text ?? null;
}

/**
 * Swap exactly one sketch segment's call chain for its converted form — the
 * apply half of the segment-conversion engine. The splice covers the chain
 * alone, so a `const x = ` prefix and a trailing `;` survive, and the new
 * root callee's import is ensured (a conversion is often the file's first
 * `aLine`). Pure string-in/string-out with the same drift-guard contract as
 * `applyStatementEdit`: any mismatch refuses and returns the code verbatim.
 */
export async function applySegmentSwap(code: string, spec: SegmentSwapSpec): Promise<SegmentSwapResult> {
  const line = spec.edit?.line;
  if (!Number.isInteger(line) || line < 1) {
    return { newCode: code, error: 'malformed segment swap spec: bad line' };
  }
  const newRoot = spec.newStatement?.match(/^(\w+)\s*\(/)?.[1];
  if (!newRoot || !CHAIN_CALLEES.has(newRoot)) {
    return { newCode: code, error: 'malformed segment swap spec: replacement is not a segment call' };
  }

  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call) {
    return { newCode: code, error: `no call found at line ${line} — is the file in sync with the last render?` };
  }

  const rootCallee = rootCalleeOf(call);
  if (!rootCallee || !CHAIN_CALLEES.has(rootCallee)) {
    return {
      newCode: code,
      error: `the statement at line ${line} is not a sketch segment call — is the file in sync with the last render?`,
    };
  }

  if (code.slice(call.startIndex, call.endIndex) !== spec.expectedStatement) {
    return {
      newCode: code,
      error: 'the statement changed since the dialog opened — re-open it to edit the current code',
    };
  }

  const spliced = spliceCode(code, call.startIndex, call.endIndex, spec.newStatement);
  return { newCode: await ensureSymbolImport(spliced, newRoot, 'fluidcad/core') };
}
