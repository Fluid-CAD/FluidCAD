// Locating the `fn('literal', …)` declaration calls of a file — `param()`,
// `property()` — and what a panel edit needs to know about each: the
// variable it binds, whether a chained method follows it, and whether
// deleting its statement deletes it alone. Shared by the parameter and
// property editors so both address a declaration the same way: by its
// literal key, with the line only breaking a tie. Who reads the variable is
// `binding-references.ts`'s business.

import { stringLiteralValue, walkTree } from './nodes.ts';
import type { TSNode, TSTree } from './parser.ts';

/**
 * Where a declaration call keeps its key and its value: `param('Label',
 * default)` is keyed by its first argument, `property('Label', 'name',
 * value)` by its second — the name the code reads it by, not the label.
 */
export const DECLARATION_SHAPES: Record<string, { key: number; value: number }> = {
  param: { key: 0, value: 1 },
  property: { key: 1, value: 2 },
};

/** A located `fn(…, 'key', …)` call and everything the transforms need about it. */
export type DeclarationCall = {
  call: TSNode;
  args: TSNode;
  /** The key argument's string literal — the registry label / the property name. */
  key: string;
  /** The value argument — a param's default, a property's value — or null when the call has none. */
  value: TSNode | null;
  /** The `const <name> =` this declaration binds, when it binds one. */
  variable: string | null;
  /** True when a `.slider()`-style tail follows the call. */
  chained: boolean;
  /** 1-indexed row the call starts on. */
  line: number;
};

/** Every `fn(…)` call in the file whose key is a string literal, in source order. */
export function findDeclarationCalls(tree: TSTree, fn: string): DeclarationCall[] {
  const shape = DECLARATION_SHAPES[fn] ?? { key: 0, value: 1 };
  const declarations: DeclarationCall[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'call_expression') {
      continue;
    }
    const callee = node.childForFieldName('function');
    if (!callee || callee.type !== 'identifier' || callee.text !== fn) {
      continue;
    }
    const args = node.childForFieldName('arguments');
    const keyNode = args?.namedChild(shape.key);
    // A computed key (a variable, a template string) is not something a
    // panel can address — the key it produces isn't in the source.
    const key = keyNode ? stringLiteralValue(keyNode) : null;
    if (!args || key === null) {
      continue;
    }
    declarations.push({
      call: node,
      args,
      key,
      value: args.namedChild(shape.value),
      variable: boundVariable(node),
      chained: isChained(node),
      line: node.startPosition.row + 1,
    });
  }
  return declarations;
}

/**
 * The declaration a panel means. Matching on the key is the drift guard: the
 * panel computed the edit against what the last render declared, so a file
 * that no longer declares it is refused rather than rewritten blind. The
 * line only breaks a tie — an edit typed after the file moved underneath
 * still resolves, because a key the source spells once is unambiguous
 * wherever it now sits. `noun` words the errors: "labelled" for a param's
 * label, "named" for a property's name.
 */
export function locateDeclarationCall(
  tree: TSTree,
  fn: string,
  key: string,
  line: number | undefined,
  noun: string,
): { declaration: DeclarationCall } | { error: string } {
  const byKey = findDeclarationCalls(tree, fn).filter((d) => d.key === key);
  if (byKey.length === 1) {
    return { declaration: byKey[0] };
  }
  if (byKey.length > 1) {
    const onLine = byKey.find((d) => d.line === line);
    if (onLine) {
      return { declaration: onLine };
    }
    return {
      error: `"${key}" is declared ${byKey.length} times in this file — edit it in the code instead`,
    };
  }
  return {
    error: `no ${fn}() call ${noun} "${key}" — is the file in sync with the last render?`,
  };
}

/** True when a member access reads the call's result (`param(…).slider()`). */
export function isChained(call: TSNode): boolean {
  const parent = call.parent;
  return parent?.type === 'member_expression' && isSameNode(parent.childForFieldName('object'), call);
}

/**
 * The name of the `const` this declaration initializes, or null when the
 * call is not a declarator's whole value (an inline argument, a
 * reassignment, a destructuring target).
 */
export function boundVariable(call: TSNode): string | null {
  const outer = outermostExpression(call);
  const declarator = outer.parent;
  if (declarator?.type !== 'variable_declarator') {
    return null;
  }
  if (!isSameNode(declarator.childForFieldName('value'), outer)) {
    return null;
  }
  const name = declarator.childForFieldName('name');
  return name?.type === 'identifier' ? name.text : null;
}

/**
 * Whether deleting the enclosing statement deletes this call and nothing
 * else — a bound declaration or a bare `fn(…)` expression statement.
 */
export function isStandaloneDeclaration(declaration: DeclarationCall): boolean {
  if (declaration.variable !== null) {
    return true;
  }
  const parent = outermostExpression(declaration.call).parent;
  return parent?.type === 'expression_statement';
}

/** The whole `fn(…).a().b()` chain this call sits at the root of. */
export function outermostExpression(call: TSNode): TSNode {
  let current = call;
  while (current.parent) {
    const parent = current.parent;
    if (parent.type === 'member_expression' && isSameNode(parent.childForFieldName('object'), current)) {
      current = parent;
      continue;
    }
    if (parent.type === 'call_expression' && isSameNode(parent.childForFieldName('function'), current)) {
      current = parent;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Node identity by source span — the parser hands back fresh wrappers for
 * the same node on every access, so `===` cannot be trusted.
 */
export function isSameNode(a: TSNode | null, b: TSNode | null): boolean {
  return a !== null && b !== null
    && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

/** Whether any `const`/`let`/`var`/function/class/import in the file claims `name`. */
export function declaresName(tree: TSTree, name: string): boolean {
  for (const node of walkTree(tree.rootNode)) {
    if (node.type === 'variable_declarator' || node.type === 'function_declaration'
      || node.type === 'class_declaration') {
      if (node.childForFieldName('name')?.text === name) {
        return true;
      }
    }
    if (node.type === 'import_specifier' || node.type === 'namespace_import') {
      const alias = node.childForFieldName('alias') ?? node.childForFieldName('name') ?? node.namedChild(0);
      if (alias?.text === name) {
        return true;
      }
    }
  }
  return false;
}
