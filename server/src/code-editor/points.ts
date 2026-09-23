// Point-literal arguments of drawing calls: reading them, inserting and removing points and guides.

import {
  consumeLeadingSeparator,
  consumeTrailingSeparator,
  spliceCode,
  splitLines,
  type CodeEditResult,
} from './lines.ts';
import { findEditableCallAt, findMemberCallInChain, getArgumentsNode, withParsedCode } from './nodes.ts';
import { getParser, type TSNode } from './parser.ts';

/**
 * Structural AST check: is this node a `[x, y]` point array?
 * Accepts any two-element array regardless of whether the elements are
 * literals, variables, or expressions — the drag/splice functions only need
 * to *locate* point nodes, not read their old values.
 */
function isPointArray(node: TSNode): boolean {
  return node.type === 'array' && node.namedChildren.length === 2;
}

/**
 * Extract `[x, y]` from an `array` node with exactly two numeric children.
 * Only used where the actual numeric values are needed (e.g. `removePoint`
 * distance computation). Drag/update paths use `isPointArray` instead.
 */
export function parsePointLiteral(node: TSNode): [number, number] | null {
  if (!isPointArray(node)) {
    return null;
  }
  const parts: number[] = [];
  for (const child of node.namedChildren) {
    const value = parseFloat(child.text);
    if (Number.isNaN(value)) {
      return null;
    }
    parts.push(value);
  }
  return [parts[0], parts[1]];
}

function isPointLikeArg(node: TSNode): boolean {
  if (node.type === 'number') return false;
  if (node.type === 'string' || node.type === 'template_string') return false;
  if (node.type === 'true' || node.type === 'false') return false;
  if (node.type === 'unary_expression' && node.namedChildren[0]?.type === 'number') return false;
  return true;
}

/**
 * An `[x, y]` array literal — the only point form with per-axis source text.
 * `isPointLikeArg` deliberately also accepts identifiers and lazy accessors,
 * which the expression editor must refuse rather than clobber.
 */
function isPointLiteral(node: TSNode): boolean {
  return node.type === 'array' && node.namedChildren.length === 2;
}

/** The Nth chain point argument, when it is an editable `[x, y]` literal. */
function pointLiteralAt(call: TSNode, pointIndex: number): TSNode | null {
  const pointArgs = collectChainPointArgs(call);
  const idx = pointIndex >= 0 ? pointIndex : pointArgs.length + pointIndex;
  if (idx < 0 || idx >= pointArgs.length) {
    return null;
  }
  const node = pointArgs[idx];
  return isPointLiteral(node) ? node : null;
}

export function collectChainPointArgs(call: TSNode): TSNode[] {
  const calls: TSNode[] = [];
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    calls.push(current);
    const fn = current.childForFieldName('function');
    if (fn && fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
    } else {
      break;
    }
  }
  const pointArgs: TSNode[] = [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const args = getArgumentsNode(calls[i]);
    if (args) {
      for (const child of args.namedChildren) {
        if (isPointLikeArg(child)) {
          pointArgs.push(child);
        }
      }
    }
  }
  return pointArgs;
}

/**
 * Append an `[x, y]` point to the call on the resolved row — the bezier
 * draw-mode flow adding a control point to the `bezier(...)` it is drawing.
 * The outermost call on the row is the target: a bezier chain has no
 * trailing modifier that would take the point instead.
 */
export function insertPoint(
  code: string,
  sourceLine: number,
  point: [number, number],
): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const args = getArgumentsNode(call);
    if (!args) {
      return null;
    }
    const pointText = `[${point[0]}, ${point[1]}]`;
    if (args.namedChildren.length === 0) {
      return spliceCode(code, args.startIndex + 1, args.endIndex - 1, pointText);
    }
    return spliceCode(code, args.endIndex - 1, args.endIndex - 1, `, ${pointText}`);
  });
}

/**
 * Append `.guide()` to the call chain on the resolved row — the Guide
 * toolbar toggle converting an already-drawn statement to construction
 * geometry.
 */
export function addGuide(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call || findMemberCallInChain(call, 'guide')) {
      return null;
    }
    return spliceCode(code, call.endIndex, call.endIndex, '.guide()');
  });
}

/**
 * Remove the `.guide()` call from the chain on the resolved row — the Guide
 * toggle converting selected construction geometry back to real geometry.
 * Only an argument-less `.guide()` is stripped — a `.guide(...)` carrying
 * arguments is not the toggle's to undo.
 */
export function removeGuide(code: string, sourceLine: number): Promise<CodeEditResult> {
  return withParsedCode(code, (tree, lines) => {
    const call = findEditableCallAt(tree, lines, sourceLine);
    if (!call) {
      return null;
    }
    const guideCall = findMemberCallInChain(call, 'guide');
    if (!guideCall) {
      return null;
    }
    const guideArgs = getArgumentsNode(guideCall);
    if (!guideArgs || guideArgs.namedChildren.length !== 0) {
      return null;
    }
    const member = guideCall.childForFieldName('function');
    const object = member ? member.childForFieldName('object') : null;
    if (!object) {
      return null;
    }
    return spliceCode(code, object.endIndex, guideCall.endIndex, '');
  });
}

/**
 * Remove the `[x, y]` point nearest to `point` from the call on the resolved
 * row — the bezier draw-mode flow taking a control point back. Like
 * `insertPoint` it edits the outermost call on the row.
 */
export function removePoint(
  code: string,
  sourceLine: number,
  point: [number, number],
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

    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < args.namedChildren.length; i++) {
      const parsed = parsePointLiteral(args.namedChildren[i]);
      if (!parsed) {
        continue;
      }
      const dx = parsed[0] - point[0];
      const dy = parsed[1] - point[1];
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) {
      return null;
    }

    const pointNode = args.namedChildren[bestIndex];
    let deleteStart = pointNode.startIndex;
    let deleteEnd = pointNode.endIndex;

    if (args.namedChildren.length > 1) {
      if (bestIndex === 0) {
        deleteEnd = consumeTrailingSeparator(code, deleteEnd);
      } else {
        deleteStart = consumeLeadingSeparator(code, deleteStart);
      }
    }

    return spliceCode(code, deleteStart, deleteEnd, '');
  });
}

export function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The two element expressions of a point argument, as authored. Only an
 * `[x, y]` literal has them — a `Point2DLike` may also be an identifier or a
 * lazy accessor (`circle(hole.center(), 5)`), which has no per-axis text.
 */
export async function getPointExpression(
  code: string,
  sourceLine: number,
  pointIndex = 0,
): Promise<{ x: string; y: string } | null> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, sourceLine);
  if (!call) {
    return null;
  }
  const node = pointLiteralAt(call, pointIndex);
  if (!node) {
    return null;
  }
  return { x: node.namedChildren[0].text, y: node.namedChildren[1].text };
}
