// An instance's variable follows its name: renaming `bracket1` to "Left
// bracket" in the parts panel rewrites the `.name('…')` chain of its insert()
// and renames the `const` the insert is bound to after it — every read of
// that const, the name its assembly returns it under and the name it is
// exported by included — the way a parameter's variable follows its label.
// This is the declaring file's share; it also says how the rest of the
// workspace reads the binding, so `DeclarationRefactor` can follow the rename
// through the other files.

import {
  applySpliceEdits,
  getJavaScriptParser,
  LexicalBindings,
  type SpliceEdit,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { assemblyBodies, returnedParts } from './code-editor/assembly.ts';
import {
  bindingOfDeclarator,
  findBindingReferences,
  renameReferenceEdits,
  type BindingReference,
} from './code-editor/binding-references.ts';
import { isSameNode } from './code-editor/declaration-calls.ts';
import { DeclarationRewrite } from './declaration-rewrite.ts';
import {
  DeclarationUsages,
  enclosingDefinition,
  entryKey,
  exportNameOf,
  type DeclarationRef,
} from './declaration-usages.ts';
import { findChainAt, getBaseCallName, getChainCalls, updateInsertChain } from './insert-chain-edit.ts';
import { normalizePath } from './normalize-path.ts';

/** The parts panel's Rename, riding `ApplyFeatureEditSpec` as a side-channel. */
export type InstanceRenameSpec = {
  /** 1-based row the `insert()` chain starts on (serialized sourceLocation.line). */
  sourceLine: number;
  name: string;
  /** What the row shows without a `.name()` of its own — renaming to it drops the chain. */
  defaultName?: string;
};

/** What renaming an instance does to the variable its insert() is bound to. */
export type InstanceRenamePlan = {
  /** The name the binding takes. */
  variable: string;
  /** The declaring file's edits: the binding, its reads, and the names it leaves the file under. */
  edits: SpliceEdit[];
  /** How the other files of the workspace read the binding, or null when none can. */
  declaration: DeclarationRef | null;
  /** The name the binding is exported under once renamed, or null when the file keeps it to itself. */
  variableExport: string | null;
};

export class InstanceRename {
  /**
   * Rename the instance inserted on `spec.sourceLine`: set its `.name('…')`
   * chain, then let the variable follow — see {@link InstanceRename.plan}.
   */
  static async apply(
    code: string,
    filePath: string,
    spec: InstanceRenameSpec,
  ): Promise<{ newCode: string; error?: string }> {
    const parser = await getJavaScriptParser();
    if (!InstanceRename.insertChainAt(parser.parse(code), spec.sourceLine)) {
      return {
        newCode: code,
        error: `no insert() statement starts on line ${spec.sourceLine} — the scene may be out of date; try again after the next recompute`,
      };
    }
    const named = await updateInsertChain(code, spec.sourceLine, { name: spec.name, defaultName: spec.defaultName });
    // Naming the chain adds no line, so the insert is still where the spec says.
    const plan = await InstanceRename.plan(named.newCode, filePath, spec.sourceLine, spec.name);
    return { newCode: plan ? applySpliceEdits(named.newCode, plan.edits) : named.newCode };
  }

  /**
   * How the `const` the insert() on `sourceLine` initializes follows `name`:
   * `Left bracket` binds `leftBracket`, stepped past any name the file
   * already declares, and every read of the const — the mates, replicates
   * and poses spelled through it — takes the new name.
   *
   * So do the names the binding leaves the file under. A shorthand among
   * the parts its assembly returns (`return { bracket1 }`) is the name other
   * code reads it by — `occ.parts.bracket1` — and is renamed along with
   * those reads; so is the name a top-level binding is exported by. A
   * returned name the rest of the model cannot be followed through keeps
   * its key instead (`{ bracket1: leftBracket }`): one nested deeper in the
   * returned object, one the new name would collide in, or one of an
   * assembly no module-level const names.
   *
   * Null when no variable can follow the name: the chain is not a
   * declarator's whole value, the name has no letter or digit to build an
   * identifier from, or it reduces to the variable already bound.
   */
  static async plan(
    code: string,
    filePath: string,
    sourceLine: number,
    name: string,
  ): Promise<InstanceRenamePlan | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const chain = InstanceRename.insertChainAt(tree, sourceLine);
    const id = chain ? InstanceRename.boundName(chain) : null;
    if (!chain || !id || !/[a-zA-Z0-9]/.test(name)) {
      return null;
    }
    const variable = DeclarationRewrite.variableNameFor(name, tree, id.text);
    const bindings = new LexicalBindings(tree);
    const binding = bindingOfDeclarator(bindings, id);
    if (!binding || variable === id.text) {
      return null;
    }
    const references = findBindingReferences(bindings, binding);
    const definition = enclosingDefinition(tree, bindings, chain);
    const member = definition?.localName ? InstanceRename.returnedMember(tree, chain, references, variable) : null;
    const exported = binding.scope.type === 'program' ? exportNameOf(tree, binding) : null;
    const declaration: DeclarationRef | null = member || exported !== null
      ? {
        kind: 'instance',
        key: id.text,
        filePath: normalizePath(filePath),
        variable: null,
        variableExport: exported,
        definition: member ? definition : null,
      }
      : null;
    // `export const a` and `export { a }` export the name itself, so the
    // export follows; `export { a as b }` keeps its alias.
    const variableExport = exported === id.text ? variable : exported;

    const edits: SpliceEdit[] = [{ start: id.startIndex, end: id.endIndex, text: variable }];
    for (const reference of references) {
      if (member && isSameNode(reference.node, member)) {
        edits.push({ start: member.startIndex, end: member.endIndex, text: variable });
      } else {
        edits.push(...renameReferenceEdits([reference], variable));
      }
    }
    if (declaration) {
      const usages = new DeclarationUsages(tree, filePath, declaration);
      edits.push(...usages.renameEdits(usages.sites(), variable, null, variableExport));
    }
    return { variable, edits, declaration, variableExport };
  }

  /** The outermost call of the `insert()` chain starting on `sourceLine`, or null when the line holds none. */
  private static insertChainAt(tree: TSTree, sourceLine: number): TSNode | null {
    const chain = findChainAt(tree, sourceLine);
    return chain && getBaseCallName(getChainCalls(chain)) === 'insert' ? chain : null;
  }

  /** The identifier of the `const <name> = ` the chain is the whole value of, or null when it is not one's. */
  private static boundName(chain: TSNode): TSNode | null {
    const declarator = chain.parent;
    if (declarator?.type !== 'variable_declarator' || !isSameNode(declarator.childForFieldName('value'), chain)) {
      return null;
    }
    const id = declarator.childForFieldName('name');
    return id?.type === 'identifier' ? id : null;
  }

  /**
   * The shorthand entry the binding has among the parts its assembly body
   * returns, when that entry can take `variable` as its new name — null when
   * the body does not return the binding by shorthand, or another entry is
   * already keyed by the new name.
   */
  private static returnedMember(
    tree: TSTree,
    chain: TSNode,
    references: BindingReference[],
    variable: string,
  ): TSNode | null {
    const within = (body: TSNode) => body.startIndex <= chain.startIndex && chain.endIndex <= body.endIndex;
    // Bodies come in document order, so the last one around the chain is the innermost.
    const body = assemblyBodies(tree.rootNode).filter(within).pop();
    const parts = body ? returnedParts(body) : null;
    if (!parts || parts.namedChildren.some((entry) => entryKey(entry) === variable)) {
      return null;
    }
    return parts.namedChildren.find((entry) => entry.type === 'shorthand_property_identifier'
      && references.some((reference) => isSameNode(reference.node, entry))) ?? null;
  }
}
