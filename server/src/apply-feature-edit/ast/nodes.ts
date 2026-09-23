// Tree-sitter node helpers: identity, enclosing scopes/statements and sketch bodies.

import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../../code-editor/index.ts';

/** The 0-based row the character at `index` sits on. */
export function rowOfIndex(code: string, index: number): number {
  let row = 0;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) {
      row++;
    }
  }
  return row;
}

/** The root call node of a call chain, or null when `node` holds none. */
export function chainRootCall(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.type === 'call_expression') {
    const fn = current.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return current;
    }
    current = fn.type === 'member_expression' ? fn.childForFieldName('object') : null;
  }
  return null;
}

/**
 * web-tree-sitter mints a fresh wrapper object on every node access, so
 * reference equality between wrappers is meaningless — compare by span.
 */
export function sameNode(a: TSNode, b: TSNode): boolean {
  return a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/** Nearest enclosing statement_block or the program root. */
export function enclosingScope(node: TSNode): TSNode {
  let current: TSNode | null = node.parent;
  while (current) {
    if (current.type === 'statement_block' || current.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return node;
}

/** Nearest ancestor that is a direct child of a statement_block or program. */
export function enclosingStatement(node: TSNode): TSNode | null {
  let current: TSNode | null = node;
  while (current && current.parent) {
    if (current.parent.type === 'statement_block' || current.parent.type === 'program') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_expression', 'arrow_function',
  'method_definition', 'generator_function', 'generator_function_declaration',
]);

/**
 * Nearest enclosing scope that executes once per build: a function body or
 * the program root, skipping loop/conditional statement blocks. A statement
 * inserted at the end of this scope runs after the whole model is built.
 */
export function enclosingFunctionScope(node: TSNode): TSNode {
  let scope = enclosingScope(node);
  while (scope.type === 'statement_block') {
    const parent = scope.parent;
    if (parent && FUNCTION_NODE_TYPES.has(parent.type)) {
      return scope;
    }
    scope = enclosingScope(scope);
  }
  return scope;
}

export const LOOP_NODE_TYPES = new Set([
  'for_statement', 'for_in_statement', 'while_statement', 'do_statement',
]);

/**
 * The statement of the `sketch(…)` call whose body callback contains `node`,
 * or null when the node lives outside every sketch body. The edited
 * projection's hoisted declarations go before this statement.
 */
/**
 * The line of the `sketch()` call whose callback body holds the statement
 * at `line` — a projection's receiving sketch — or null when the line holds
 * no editable call or the call sits in no sketch body. What the edit routes
 * check a re-sourced whole-sketch reference against: a sketch cannot
 * project itself.
 */
export async function enclosingSketchLine(code: string, line: number): Promise<number | null> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const call = findEditableCallAt(tree, splitLines(code), line);
  if (!call) {
    return null;
  }
  for (let cur = call.parent; cur; cur = cur.parent) {
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'sketch') {
        return cur.startPosition.row + 1;
      }
    }
  }
  return null;
}

export function enclosingSketchStatement(node: TSNode): TSNode | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'call_expression') {
      const fn = cur.childForFieldName('function');
      if (fn?.type === 'identifier' && fn.text === 'sketch') {
        return enclosingStatement(cur) ?? cur;
      }
    }
  }
  return null;
}
