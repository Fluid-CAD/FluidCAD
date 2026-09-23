// The module-level binding a `part(...)` call is assigned to.

import {
  chainRootCallee,
  findEditableCallAt,
  getJavaScriptParser,
  splitLines,
  type TSNode,
} from '../code-editor.ts';
import { chainRootCall } from './ast/nodes.ts';

/**
 * The module-level `const` a `part(...)` call at `line` is bound to —
 * the identifier a cross-part reference renders (`p1.features.<name>`).
 * Refuses unbound forms (`return part(...)` factories) and non-module-scope
 * bindings: the consumer statement references the identifier from another
 * top-level part body, so nothing narrower can serve it.
 */
export async function resolvePartBindingIdent(
  code: string,
  line: number,
): Promise<{ ident: string; exported: boolean } | { error: string }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const lines = splitLines(code);
  const call = findEditableCallAt(tree, lines, line);
  if (!call || chainRootCallee(call) !== 'part') {
    return { error: `no part() call found at line ${line} — is the file in sync with the last render?` };
  }
  let current: TSNode | null = call;
  while (current && current.type !== 'variable_declarator') {
    if (current.type === 'statement_block' || current.type === 'program') {
      current = null;
      break;
    }
    current = current.parent;
  }
  const name = current?.childForFieldName('name');
  const value = current?.childForFieldName('value');
  // The declarator's own value chain must root at THIS part call — a
  // wrapped form (`const x = registry.add(part(...))`) binds the wrapper,
  // not the definition, and `x.features` would not exist.
  const directBinding = !!value
    && chainRootCall(value)?.startIndex === chainRootCall(call)?.startIndex
    && chainRootCall(value) !== null;
  if (!current || !name || name.type !== 'identifier' || !directBinding) {
    return {
      error: `the part at line ${line} is not bound to a const — bind it `
        + '(const p1 = part(...)) so the sketch can reference p1.features.<name>',
    };
  }
  const declaration = current.parent;
  const holder = declaration?.parent;
  const exported = holder?.type === 'export_statement' && holder.parent?.type === 'program';
  const moduleScope = holder?.type === 'program' || exported;
  if (!moduleScope) {
    return {
      error: `the part at line ${line} is bound inside a nested scope — `
        + `move the declaration to module scope so other parts can reference it`,
    };
  }
  return { ident: name.text, exported };
}
