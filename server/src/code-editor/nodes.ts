// Node helpers: tree walking, the editable call at a source line, chain roots, arguments and literals.

import { resolveSourceRow, splitLines, type CodeEditResult } from './lines.ts';
import { getParser, type TSNode, type TSTree } from './parser.ts';

export function* walkTree(node: TSNode): Generator<TSNode> {
  yield node;
  for (const child of node.namedChildren) {
    yield* walkTree(child);
  }
}

/**
 * Resolve a 1-indexed `sourceLine` (captured from a V8 stack trace) to the
 * outermost `call_expression` node whose invocation starts on that row.
 *
 * "Outermost" means: of all call_expression nodes starting on the resolved
 * row, return the one with the largest endIndex. That picks the whole
 * `.guide()` chain for `line(…).guide()` and the only call on the row
 * for the multi-line case
 *   fillet(4,
 *     edge().circle()
 *   )
 * — both match how the old line-based code (which found the last `)` on
 * the line) behaved for the cases it handled.
 *
 * Returns `null` when no call starts on that row, preserving the existing
 * silent-no-op contract of the edit functions.
 */
export function findEditableCallAt(tree: TSTree, lines: string[], sourceLine: number): TSNode | null {
  const row = resolveSourceRow(lines, sourceLine);
  if (row < 0) {
    return null;
  }
  let best: TSNode | null = null;
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    if (node.startPosition.row !== row) {
      continue;
    }
    if (!best || node.endIndex > best.endIndex) {
      best = node;
    }
  }
  return best;
}

export function getArgumentsNode(call: TSNode): TSNode | null {
  return call.childForFieldName('arguments');
}

/**
 * If `call` or any call in its `function` chain invokes `.<memberName>(...)`,
 * return the call_expression for that invocation.
 */
export function findMemberCallInChain(call: TSNode, memberName: string): TSNode | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (fn && fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (prop && prop.text === memberName) {
        return current;
      }
      const object = fn.childForFieldName('object');
      current = object;
      continue;
    }
    break;
  }
  return null;
}

/**
 * The innermost call of a member chain — the geometry call that owns the
 * point argument. A missing point must be inserted there: for
 * `rect(16, 166).centered('horizontal')` the start point belongs to
 * `rect(...)`, not to the chained modifier the line's outermost call is.
 */
export function chainBaseCall(call: TSNode): TSNode {
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

/**
 * Shared setup for the five AST-based edit functions: parse the code once,
 * split it into lines for `resolveSourceRow`, run the caller's transform,
 * and wrap the result. Returning `null` from `fn` means "no edit" and
 * yields the original code verbatim.
 */
export async function withParsedCode(
  code: string,
  fn: (tree: TSTree, lines: string[]) => string | null,
): Promise<CodeEditResult> {
  const p = await getParser();
  const tree = p.parse(code);
  const lines = splitLines(code);
  const next = fn(tree, lines);
  return { newCode: next ?? code };
}

/**
 * Delete the line(s) a top-level statement spans, newline included. A blank
 * line on each side collapses to one: the statement usually sits between
 * the imports and the first geometry with its own breathing room, and
 * leaving both gaps would stack two blank lines where there was one.
 */
export function removeStatementLine(code: string, node: TSNode): string {
  let start = node.startIndex;
  while (start > 0 && code[start - 1] !== '\n') {
    start--;
  }
  let end = node.endIndex;
  while (end < code.length && code[end] !== '\n') {
    end++;
  }
  if (end < code.length) {
    end++;
  }
  if (start >= 2 && code.slice(start - 2, start) === '\n\n' && code[end] === '\n') {
    end++;
  }
  return code.slice(0, start) + code.slice(end);
}

// ---------------------------------------------------------------------------
// Statement removal — delete a feature statement at a timeline row's source line
// ---------------------------------------------------------------------------

/** Nearest ancestor that is a direct child of a statement_block or program. */
export function enclosingStatementOf(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.parent) {
    if (current.parent.type === 'statement_block' || current.parent.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Every identifier the file binds at any depth: import bindings (named,
 * aliased, default, namespace) plus `const`/`let`/`var` declarators
 * (destructuring included), function and class declarations. Conservative
 * on purpose — a name bound anywhere is treated as taken, so a generated
 * top-level binding never shadows or collides with one the author wrote.
 */
export function collectBoundNames(tree: TSTree): Set<string> {
  const names = new Set<string>();
  for (const node of tree.rootNode.namedChildren) {
    if (node.type === 'import_statement') {
      for (const spec of walkTree(node)) {
        if (spec.type === 'import_specifier') {
          const local = spec.childForFieldName('alias') ?? spec.childForFieldName('name') ?? spec.namedChild(0);
          if (local) {
            names.add(local.text);
          }
        } else if (spec.type === 'namespace_import') {
          const id = spec.namedChildren.find(c => c.type === 'identifier');
          if (id) {
            names.add(id.text);
          }
        } else if (spec.type === 'import_clause') {
          for (const child of spec.namedChildren) {
            if (child.type === 'identifier') {
              names.add(child.text);
            }
          }
        }
      }
    }
  }
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'function_declaration' || node.type === 'class_declaration') {
      const name = node.childForFieldName('name');
      if (name) {
        names.add(name.text);
      }
      continue;
    }
    if (node.type !== 'variable_declarator') {
      continue;
    }
    const pattern = node.childForFieldName('name');
    if (!pattern) {
      continue;
    }
    if (pattern.type === 'identifier') {
      names.add(pattern.text);
      continue;
    }
    // Destructuring: `const { a, b: c } = …` binds a and c; `[x, y]` binds
    // both. Property keys parse as property_identifier, so every plain
    // identifier inside the pattern is a binding.
    for (const n of walkTree(pattern)) {
      if (n.type === 'shorthand_property_identifier_pattern' || n.type === 'identifier') {
        names.add(n.text);
      }
    }
  }
  return names;
}

/** The text a string literal node denotes, with its surrounding quotes dropped. */
export function stringLiteralValue(node: TSNode): string | null {
  if (node.type !== 'string') {
    return null;
  }
  const fragment = node.namedChildren.find(c => c.type === 'string_fragment');
  return fragment ? fragment.text : '';
}

/** The numeric value of a `number` (or unary-minus number) node, else null. */
export function numericLiteralValue(node: TSNode): number | null {
  if (node.type !== 'number'
    && !(node.type === 'unary_expression' && node.namedChildren[0]?.type === 'number')) {
    return null;
  }
  const value = parseFloat(node.text);
  return Number.isNaN(value) ? null : value;
}

// ---------------------------------------------------------------------------
// Expression-aware dimension helpers
// ---------------------------------------------------------------------------

export function findNonArrayArgFromEnd(args: TSNode, offset = 0): TSNode | null {
  let skipped = 0;
  for (let i = args.namedChildren.length - 1; i >= 0; i--) {
    const child = args.namedChildren[i];
    if (child.type !== 'array') {
      if (skipped === offset) {
        return child;
      }
      skipped++;
    }
  }
  return null;
}

// Name of the function a call expression invokes: `rect(...)` -> 'rect',
// `foo.radius(...)` -> 'radius'.
export function callFunctionName(call: TSNode): string | null {
  const fn = call.childForFieldName('function');
  if (!fn) {
    return null;
  }
  if (fn.type === 'identifier') {
    return fn.text;
  }
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

/** Root identifier of a call chain: `part('A', () => {}).hidden()` → `part`. */
export function chainRootCallee(call: TSNode): string | null {
  let current: TSNode | null = call;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return fn.text;
    }
    if (fn.type === 'member_expression') {
      current = fn.childForFieldName('object');
      continue;
    }
    return null;
  }
  return null;
}
