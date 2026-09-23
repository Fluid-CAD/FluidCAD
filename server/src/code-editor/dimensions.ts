// The trailing dimension argument of a drawing call: reading and rewriting it.

import { spliceCode, splitLines, type CodeEditResult } from './lines.ts';
import {
  callFunctionName,
  findEditableCallAt,
  findNonArrayArgFromEnd,
  getArgumentsNode,
  withParsedCode,
} from './nodes.ts';
import { getParser, type TSNode } from './parser.ts';

/**
 * Update the last non-array argument of a geometry call (e.g. distance or diameter).
 * Replaces whatever expression is there (literal, variable, binary expression)
 * with the new numeric literal.
 */
export function updateDimension(
  code: string,
  sourceLine: number,
  newValue: number,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const args = getArgumentsNode(call);
    if (!args || args.namedChildren.length === 0) {
      return null;
    }
    const target = findNonArrayArgFromEnd(args);
    if (!target) {
      return null;
    }
    return spliceCode(code, target.startIndex, target.endIndex, String(newValue));
  });
}

export async function getDimensionExpression(
  code: string,
  sourceLine: number,
  dimensionOffset = 0,
  dimensionCall: string | null = null,
): Promise<{ expression: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  let current: TSNode | null = findEditableCallAt(tree, lines, sourceLine);
  while (current && current.type === 'call_expression') {
    const args = getArgumentsNode(current);
    if (args && (!dimensionCall || callFunctionName(current) === dimensionCall)) {
      const target = findNonArrayArgFromEnd(args, dimensionOffset);
      if (target) {
        return { expression: target.text };
      }
    }
    const fn = current.childForFieldName('function');
    current = fn && fn.type === 'member_expression'
      ? fn.childForFieldName('object')
      : null;
  }
  return null;
}

/**
 * Rewrite the scalar `dimensionOffset` non-array args from the end of the
 * call at `sourceLine`. `dimensionCall` names the callee that owns the
 * scalar — the same filter the read (`getDimensionExpression`) applies, so
 * a chained statement (`ellipse(c, 20, 10).name('cam')`) rewrites the
 * ellipse's radius, never the outer call's argument. Null takes the first
 * call in the chain that has a matching argument.
 */
export function updateDimensionExpression(
  code: string,
  sourceLine: number,
  expression: string,
  dimensionOffset = 0,
  dimensionCall: string | null = null,
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    let current: TSNode | null = findEditableCallAt(tree, lines, sourceLine);
    while (current && current.type === 'call_expression') {
      const args = getArgumentsNode(current);
      if (args && (!dimensionCall || callFunctionName(current) === dimensionCall)) {
        const target = findNonArrayArgFromEnd(args, dimensionOffset);
        if (target) {
          return spliceCode(code, target.startIndex, target.endIndex, expression);
        }
      }
      const fn = current.childForFieldName('function');
      current = fn && fn.type === 'member_expression'
        ? fn.childForFieldName('object')
        : null;
    }
    return null;
  });
}
