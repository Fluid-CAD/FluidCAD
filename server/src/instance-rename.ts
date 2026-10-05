// An instance's variable follows its name: renaming `bracket1` to "Left
// bracket" in the parts panel rewrites the `.name('…')` chain of its insert()
// and renames the `const` the insert is bound to after it — every read of
// that const, the name its assembly returns it under and the name it is
// exported by included — the way a parameter's variable follows its label.
// This is the declaring file's share; it also says how the rest of the
// workspace reads the binding, so `DeclarationRefactor` can follow the rename
// through the other files.

import { applySpliceEdits, getJavaScriptParser, type TSNode, type TSTree } from './code-editor/index.ts';
import { assemblyBodies, returnedParts } from './code-editor/assembly.ts';
import type { BindingReference } from './code-editor/binding-references.ts';
import { isSameNode } from './code-editor/declaration-calls.ts';
import { BindingRename, type BindingRenamePlan } from './binding-rename.ts';
import { enclosingDefinition, entryKey } from './declaration-usages.ts';
import { findChainAt, getBaseCallName, getChainCalls, updateInsertChain } from './insert-chain-edit.ts';

/** The parts panel's Rename, riding `ApplyFeatureEditSpec` as a side-channel. */
export type InstanceRenameSpec = {
  /** 1-based row the `insert()` chain starts on (serialized sourceLocation.line). */
  sourceLine: number;
  name: string;
  /** What the row shows without a `.name()` of its own — renaming to it drops the chain. */
  defaultName?: string;
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
   * How the `const` the insert() on `sourceLine` initializes follows `name`
   * (see {@link BindingRename}): every read of the const — the mates,
   * replicates and poses spelled through it — takes the new name.
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
   * Null when no variable can follow the name.
   */
  static async plan(
    code: string,
    filePath: string,
    sourceLine: number,
    name: string,
  ): Promise<BindingRenamePlan | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const chain = InstanceRename.insertChainAt(tree, sourceLine);
    const rename = chain ? BindingRename.of(tree, chain, name) : null;
    if (!chain || !rename) {
      return null;
    }
    const definition = enclosingDefinition(tree, rename.bindings, chain);
    const member = definition?.localName
      ? InstanceRename.returnedMember(tree, chain, rename.references, rename.variable)
      : null;
    return rename.plan(tree, filePath, 'instance', member ? definition : null, member);
  }

  /** The outermost call of the `insert()` chain starting on `sourceLine`, or null when the line holds none. */
  private static insertChainAt(tree: TSTree, sourceLine: number): TSNode | null {
    const chain = findChainAt(tree, sourceLine);
    return chain && getBaseCallName(getChainCalls(chain)) === 'insert' ? chain : null;
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
