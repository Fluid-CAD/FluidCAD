// A part's variable follows its name: renaming `Part 1` to "Fixed leaf" on
// its timeline row rewrites the name `part('…', …)` takes and renames the
// `const` the part is bound to after it — `fixedLeaf` — along with every
// read of that const and the name it is exported by. This is the declaring
// file's share; it also says how the rest of the workspace reads the
// binding, so `DeclarationRefactor` can follow the rename through the files
// that import the part.

import {
  applySpliceEdits,
  chainRootCallee,
  findEditableCallAt,
  getJavaScriptParser,
  setFeatureName,
  splitLines,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { BindingRename, type BindingRenamePlan } from './binding-rename.ts';

/** The part row's Rename, riding `ApplyFeatureEditSpec` as a side-channel. */
export type PartRenameSpec = {
  /** 1-based row the `part()` statement starts on (serialized sourceLocation.line). */
  sourceLine: number;
  name: string;
};

export class PartRename {
  /** Rename the part declared on `spec.sourceLine`: its name, then the variable after it. */
  static async apply(
    code: string,
    filePath: string,
    spec: PartRenameSpec,
  ): Promise<{ newCode: string; error?: string }> {
    const parser = await getJavaScriptParser();
    if (!PartRename.partAt(parser.parse(code), code, spec.sourceLine)) {
      return {
        newCode: code,
        error: `no part() statement starts on line ${spec.sourceLine} — the scene may be out of date; try again after the next recompute`,
      };
    }
    const named = await setFeatureName(code, spec.sourceLine, spec.name);
    // Naming the part adds no line, so its statement is still where the spec says.
    const plan = await PartRename.plan(named.newCode, filePath, spec.sourceLine, spec.name);
    return { newCode: plan ? applySpliceEdits(named.newCode, plan.edits) : named.newCode };
  }

  /**
   * How the `const` the part() on `sourceLine` initializes follows `name`
   * (see {@link BindingRename}): every read of the const takes the new
   * name, and so does the name the file exports it by. Null when no
   * variable can follow the name.
   */
  static async plan(
    code: string,
    filePath: string,
    sourceLine: number,
    name: string,
  ): Promise<BindingRenamePlan | null> {
    const parser = await getJavaScriptParser();
    const tree = parser.parse(code);
    const part = PartRename.partAt(tree, code, sourceLine);
    return (part && BindingRename.of(tree, part, name)?.plan(tree, filePath, 'part')) ?? null;
  }

  /** The outermost call of the `part()` statement starting on `sourceLine`, or null when the line holds none. */
  private static partAt(tree: TSTree, code: string, sourceLine: number): TSNode | null {
    const call = findEditableCallAt(tree, splitLines(code), sourceLine);
    return call && chainRootCallee(call) === 'part' ? call : null;
  }
}
