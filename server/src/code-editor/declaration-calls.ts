// Locating the `fn('literal', …)` declaration calls of a file — `param()`,
// `property()` — and what a panel edit needs to know about each: the
// variable it binds, whether a chained method follows it, whether deleting
// its statement deletes it alone, and how much of the model reads the
// variable. Shared by the parameter and property editors so both address a
// declaration the same way: by its literal key, with the line only breaking
// a tie.

import { stringLiteralValue, walkTree } from './nodes.ts';
import type { TSNode, TSTree } from './parser.ts';

/** A located `fn('key', …)` call and everything the transforms need about it. */
export type DeclarationCall = {
  call: TSNode;
  args: TSNode;
  /** The first argument's string literal — the registry key / the property name. */
  key: string;
  /** The `const <name> =` this declaration binds, when it binds one. */
  variable: string | null;
  /** True when a `.slider()`-style tail follows the call. */
  chained: boolean;
  /** 1-indexed row the call starts on. */
  line: number;
};

/** Every `fn('literal', …)` call in the file, in source order. */
export function findDeclarationCalls(tree: TSTree, fn: string): DeclarationCall[] {
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
    const first = args?.namedChild(0);
    // A computed key (a variable, a template string) is not something a
    // panel can address — the key it produces isn't in the source.
    const key = first ? stringLiteralValue(first) : null;
    if (!args || key === null) {
      continue;
    }
    declarations.push({
      call: node,
      args,
      key,
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

/** How many places read the declaration's variable, and where (1-indexed, capped for display). */
export function countVariableReferences(
  tree: TSTree,
  declaration: DeclarationCall,
): { references: number; referenceLines: number[] } {
  const name = declaration.variable;
  if (!name) {
    return { references: 0, referenceLines: [] };
  }
  const lines: number[] = [];
  for (const node of walkTree(tree.rootNode)) {
    if (node.type !== 'identifier' || node.text !== name) {
      continue;
    }
    const parent = node.parent;
    // The declaration's own name, a property access (`o.width`), and a
    // non-shorthand object key (`{ width: 1 }`) all spell the name without
    // reading the variable.
    if (parent?.type === 'variable_declarator' && isSameNode(parent.childForFieldName('name'), node)) {
      continue;
    }
    if (parent?.type === 'member_expression' && isSameNode(parent.childForFieldName('property'), node)) {
      continue;
    }
    if (parent?.type === 'pair' && isSameNode(parent.childForFieldName('key'), node)) {
      continue;
    }
    lines.push(node.startPosition.row + 1);
  }
  return { references: lines.length, referenceLines: lines.slice(0, 5) };
}
