// Tree helpers over a sketch body: chain bases, callees, enclosing statements and loops, bound names, hoisting.

import type { TSNode } from '../code-editor/index.ts';
import { allocateSolvedName } from '../sketch-names.ts';

/** The innermost call of a member chain — the entity command itself,
 * beneath any chained modifiers (`.cw()`, `.guide()`). */
export function chainBase(call: TSNode): TSNode {
  let current = call;
  while (current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    const object = fn && fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
    if (object && object.type === 'call_expression') {
      current = object;
    } else {
      break;
    }
  }
  return current;
}

export function calleeName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  return fn && fn.type === 'identifier' ? fn.text : null;
}

/** Walk up to the child of a statement_block/program — the whole statement
 * the call lives in. */
export function enclosingStatement(node: TSNode): TSNode {
  let current = node;
  while (current.parent
    && current.parent.type !== 'statement_block'
    && current.parent.type !== 'program') {
    current = current.parent;
  }
  return current;
}

/** The statement's bound variable, when it is `const NAME = …`. */
export function boundVariableName(statement: TSNode): string | null {
  if (statement.type !== 'lexical_declaration' && statement.type !== 'variable_declaration') {
    return null;
  }
  const declarator = statement.namedChildren.find(c => c.type === 'variable_declarator');
  const name = declarator?.childForFieldName('name');
  return name && name.type === 'identifier' ? name.text : null;
}

/** Loop statement node types — a statement inside one executes per iteration,
 * so its entities are addressed per-instance (`occurrence`) via a collector
 * array hoisted before the outermost enclosing loop. */
const LOOP_STATEMENT_TYPES = new Set<string>([
  'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
]);

/** Function-boundary node types: a statement behind one of these runs in its
 * own scope — a collector hoisted next to it could never be in scope at the
 * constraint row, so loop targeting stops at the boundary. */
const FUNCTION_BOUNDARY_TYPES = new Set<string>([
  'arrow_function', 'function', 'function_expression', 'function_declaration',
  'generator_function', 'generator_function_declaration', 'method_definition',
]);

/**
 * The OUTERMOST loop statement between `call` and the sketch callback's
 * statement_block, or null when no loop encloses the call in the same scope
 * chain (a function boundary on the way up hides any loop above it, and a
 * call outside the sketch body has no usable loop either way).
 */
export function enclosingLoop(call: TSNode, body: TSNode): TSNode | null {
  let outermost: TSNode | null = null;
  let current = call.parent;
  while (current) {
    // Byte-span comparison — tree-sitter hands out fresh wrapper objects per
    // access, so identity never matches across two walks of the same tree.
    if (current.type === body.type
      && current.startIndex === body.startIndex
      && current.endIndex === body.endIndex) {
      return outermost;
    }
    if (FUNCTION_BOUNDARY_TYPES.has(current.type)) {
      return null;
    }
    if (LOOP_STATEMENT_TYPES.has(current.type)) {
      outermost = current;
    }
    current = current.parent;
  }
  return null;
}

/** `X.push(arg)` — a single-argument `.push()` member call on a bare
 * identifier. The loop-instance transform emits these, so recognising them
 * lets a repeat emission reuse the collector instead of stacking a second. */
export function pushCall(call: TSNode): { arrayName: string; argument: TSNode } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') {
    return null;
  }
  const property = fn.childForFieldName('property');
  const object = fn.childForFieldName('object');
  if (!property || property.text !== 'push' || !object || object.type !== 'identifier') {
    return null;
  }
  const args = call.childForFieldName('arguments');
  if (!args || args.namedChildren.length !== 1) {
    return null;
  }
  return { arrayName: object.text, argument: args.namedChildren[0] };
}

/** The collector a bound loop statement already feeds: `const l = line(…);`
 * immediately followed by `X.push(l);` → `X`. Siblings are matched by byte
 * position — tree-sitter hands out fresh wrapper objects per access. */
export function followingPushArray(statement: TSNode, bound: string): string | null {
  const block = statement.parent;
  if (!block) {
    return null;
  }
  const siblings = block.namedChildren;
  const at = siblings.findIndex(s => s.startIndex === statement.startIndex);
  const next = at >= 0 ? siblings[at + 1] : undefined;
  if (!next || next.type !== 'expression_statement') {
    return null;
  }
  const call = next.namedChild(0);
  if (!call || call.type !== 'call_expression') {
    return null;
  }
  const push = pushCall(call);
  return push && push.argument.type === 'identifier' && push.argument.text === bound
    ? push.arrayName
    : null;
}

/** Bind an unbound existing statement (`const l3 = line(…)`) so a
 * constraint can reference it — the shared rail of the constraint toolbar,
 * the split/trim tools and the sketch exports. A statement the drawing
 * tools wrote is already bound; this is for hand-written ones. */
export function hoistSolvedStatement(
  statement: TSNode,
  callee: string,
  used: Set<string>,
  hoistedNames: Map<number, string>,
  edits: { start: number; text: string }[],
): string {
  let bound = boundVariableName(statement) ?? hoistedNames.get(statement.startIndex);
  if (!bound) {
    bound = allocateSolvedName(used, callee);
    hoistedNames.set(statement.startIndex, bound);
    edits.push({ start: statement.startIndex, text: `const ${bound} = ` });
  }
  return bound;
}
