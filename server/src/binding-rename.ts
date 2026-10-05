// A `const` that follows the name of what it is bound to — a part's
// `part('Fixed leaf', …)`, an instance's `.name('Left bracket')` — the way a
// parameter's variable follows its label. This is the part of a rename the
// two share: the name the variable takes, its reads in the declaring file,
// and the name it leaves the file under.

import { LexicalBindings, type SpliceEdit, type TSNode, type TSTree } from './code-editor/index.ts';
import {
  bindingOfDeclarator,
  findBindingReferences,
  renameReferenceEdits,
  type BindingReference,
} from './code-editor/binding-references.ts';
import { isSameNode } from './code-editor/declaration-calls.ts';
import { DeclarationRewrite } from './declaration-rewrite.ts';
import { DeclarationUsages, exportNameOf, type DeclarationRef } from './declaration-usages.ts';
import { normalizePath } from './normalize-path.ts';

/** What a rename does to the variable its statement is bound to. */
export type BindingRenamePlan = {
  /** The name the binding takes. */
  variable: string;
  /** The declaring file's edits: the binding, its reads, and the names it leaves the file under. */
  edits: SpliceEdit[];
  /** How the other files of the workspace read the binding, or null when none can. */
  declaration: DeclarationRef | null;
  /** The name the binding is exported under once renamed, or null when the file keeps it to itself. */
  variableExport: string | null;
};

export class BindingRename {
  private constructor(
    /** The identifier the declarator names. */
    private readonly id: TSNode,
    /** The name the binding takes. */
    readonly variable: string,
    /** Every read of the binding in its file. */
    readonly references: BindingReference[],
    /** The name the binding is exported under today, or null when the file keeps it to itself. */
    private readonly exported: string | null,
    readonly bindings: LexicalBindings,
  ) {}

  /**
   * How the `const` that `value` — a statement's outermost call — is the
   * whole initializer of follows `name`: `Left bracket` binds `leftBracket`,
   * stepped past any name the file already declares.
   *
   * Null when no variable can follow the name: the call is not a
   * declarator's whole value, the name has no letter or digit to build an
   * identifier from, or it reduces to the variable already bound.
   */
  static of(tree: TSTree, value: TSNode, name: string): BindingRename | null {
    const declarator = value.parent;
    if (declarator?.type !== 'variable_declarator' || !isSameNode(declarator.childForFieldName('value'), value)) {
      return null;
    }
    const id = declarator.childForFieldName('name');
    if (id?.type !== 'identifier' || !/[a-zA-Z0-9]/.test(name)) {
      return null;
    }
    const variable = DeclarationRewrite.variableNameFor(name, tree, id.text);
    const bindings = new LexicalBindings(tree);
    const binding = bindingOfDeclarator(bindings, id);
    if (!binding || variable === id.text) {
      return null;
    }
    const exported = binding.scope.type === 'program' ? exportNameOf(tree, binding) : null;
    return new BindingRename(id, variable, findBindingReferences(bindings, binding), exported, bindings);
  }

  /**
   * The name the binding is exported under once renamed: `export const a`
   * and `export { a }` export the name itself, so the export follows;
   * `export { a as b }` keeps its alias.
   */
  get variableExport(): string | null {
    return this.exported === this.id.text ? this.variable : this.exported;
  }

  /**
   * The declaring file's share of the rename: the binding and its reads
   * take the new name, and so do the file's own by-name reads of it. An
   * object shorthand keeps its key (`{ bracket1: leftBracket }`) — except
   * `renamedKey`, the one shorthand whose key is to take the new name along.
   *
   * `kind` and `definition` say how the rest of the workspace reads the
   * binding: through an import of its export, and — for an instance — by
   * name off an occurrence of `definition`, the assembly that returns it.
   */
  plan(
    tree: TSTree,
    filePath: string,
    kind: 'part' | 'instance',
    definition: DeclarationRef['definition'] = null,
    renamedKey: TSNode | null = null,
  ): BindingRenamePlan {
    const edits: SpliceEdit[] = [{ start: this.id.startIndex, end: this.id.endIndex, text: this.variable }];
    for (const reference of this.references) {
      if (renamedKey && isSameNode(reference.node, renamedKey)) {
        edits.push({ start: renamedKey.startIndex, end: renamedKey.endIndex, text: this.variable });
      } else {
        edits.push(...renameReferenceEdits([reference], this.variable));
      }
    }
    const declaration: DeclarationRef | null = this.exported === null && definition === null
      ? null
      : {
        kind,
        key: this.id.text,
        filePath: normalizePath(filePath),
        variable: null,
        variableExport: this.exported,
        definition,
      };
    if (declaration) {
      const usages = new DeclarationUsages(tree, filePath, declaration);
      edits.push(...usages.renameEdits(usages.sites(), this.variable, null, this.variableExport));
    }
    return { variable: this.variable, edits, declaration, variableExport: this.variableExport };
  }
}
