// An instance's variable follows its name: renaming `bracket1` to "Left
// bracket" in the parts panel renames the `const` its insert() is bound to
// and every read of it, the way a parameter's variable follows its label.

import { applySpliceEdits, LexicalBindings, type TSNode, type TSTree } from './code-editor/index.ts';
import {
  bindingOfDeclarator,
  findBindingReferences,
  renameReferenceEdits,
  type BindingReference,
} from './code-editor/binding-references.ts';
import { isSameNode } from './code-editor/declaration-calls.ts';
import { DeclarationRewrite } from './declaration-rewrite.ts';

/**
 * `code` with the `const` that `chain` — an `insert()` chain's outermost
 * call — initializes renamed after `name`, along with every read of it: the
 * mates, replicates and poses spelled through the binding. `Left bracket`
 * binds `leftBracket`, stepped past any name the file already declares. A
 * shorthand in an assembly's returned parts keeps its key
 * (`{ bracket1: leftBracket }`), so the files reading `.parts.bracket1` are
 * untouched.
 *
 * The code comes back as it was when no variable can follow the name: the
 * chain is not a declarator's whole value, the name has no letter or digit
 * to build an identifier from, it reduces to the variable already bound, or
 * the binding is exported — another file imports it by that name.
 */
export function renameInsertBinding(code: string, tree: TSTree, chain: TSNode, name: string): string {
  const declarator = chain.parent;
  if (declarator?.type !== 'variable_declarator' || !isSameNode(declarator.childForFieldName('value'), chain)) {
    return code;
  }
  const id = declarator.childForFieldName('name');
  if (id?.type !== 'identifier' || !/[a-zA-Z0-9]/.test(name)) {
    return code;
  }
  const variable = DeclarationRewrite.variableNameFor(name, tree, id.text);
  if (variable === id.text) {
    return code;
  }
  const bindings = new LexicalBindings(tree);
  const binding = bindingOfDeclarator(bindings, id);
  if (!binding) {
    return code;
  }
  const references = findBindingReferences(bindings, binding);
  if (isExported(declarator, references)) {
    return code;
  }
  return applySpliceEdits(code, [
    { start: id.startIndex, end: id.endIndex, text: variable },
    ...renameReferenceEdits(references, variable),
  ]);
}

/** Whether the binding leaves the file under its own name: `export const a = …` or `export { a }`. */
function isExported(declarator: TSNode, references: BindingReference[]): boolean {
  return declarator.parent?.parent?.type === 'export_statement'
    || references.some(({ node }) => node.parent?.type === 'export_specifier');
}
