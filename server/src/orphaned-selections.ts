// Cleaning up the helper declarations a structured edit leaves behind.
//
// Dialog-written features keep some of their inputs in statements of their
// own: a loft connection's `const sel = select(…)` has to run before the
// `loft(…)` that reads it, a projection's before the sketch it lands in (see
// `SelectHoist`). Those statements exist only for the feature that references
// them, so whatever removes the last reference — deleting the feature from
// the timeline, a cascade, dropping a connection in the edit dialog,
// re-picking a projection source — must take them along, or every such edit
// leaves a dead `select()` row in the history.
//
// The rule is stated over the edit's two texts, so it needs no knowledge of
// the transform that ran: a helper declaration that WAS referenced before
// the edit and is referenced by nothing after it was orphaned by that edit,
// and is removed. A declaration nothing referenced to begin with is the
// user's own and stays. Any transform gets the cleanup by passing its input
// and output through {@link OrphanedSelections.sweep}; the edit dispatcher
// and the statement-removal route do so for every edit they apply.

import {
  getJavaScriptParser,
  spliceCode,
  splitLines,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';
import { isReferenceUse } from './lint-fluid-js.ts';
import { StatementAnalysis } from './statement-analysis.ts';

/** One helper declaration and how many live references its binding has. */
type HelperDeclaration = { statement: TSNode; key: string; references: number };

export class OrphanedSelections extends StatementAnalysis {
  /**
   * Callees whose bare call, bound to a name, is a helper declaration: a
   * statement with no effect on the model beyond being referenced.
   */
  private static readonly HELPER_CALLEES = new Set(['select']);

  /**
   * `after` without the helper declarations the edit `before` → `after`
   * orphaned, recursively (a helper only another orphan referenced goes
   * too). Returns `after` unchanged when the edit orphaned nothing.
   */
  static async sweep(before: string, after: string): Promise<string> {
    if (before === after || !OrphanedSelections.mentionsHelper(before) || !OrphanedSelections.mentionsHelper(after)) {
      return after;
    }
    const parser = await getJavaScriptParser();
    const referencedBefore = OrphanedSelections.tally(
      OrphanedSelections.declarations(parser.parse(before)).filter((helper) => helper.references > 0),
    );
    const unreferencedBefore = OrphanedSelections.tally(
      OrphanedSelections.declarations(parser.parse(before)).filter((helper) => helper.references === 0),
    );
    if (referencedBefore.size === 0) {
      return after;
    }

    let working = after;
    for (;;) {
      const orphans = OrphanedSelections.orphans(parser.parse(working), referencedBefore, unreferencedBefore);
      if (orphans.length === 0) {
        return working;
      }
      const edits = OrphanedSelections.removalEdits(working, splitLines(working), orphans);
      edits.sort((a, b) => b.start - a.start);
      for (const edit of edits) {
        working = spliceCode(working, edit.start, edit.end, edit.text);
      }
    }
  }

  /**
   * The unreferenced helpers of `tree` this edit is answerable for, in
   * document order: per declaration text, as many as went unreferenced
   * beyond the ones that already were — the latest first, so a user's own
   * unused twin higher up is the one that stays.
   */
  private static orphans(
    tree: TSTree,
    referencedBefore: Map<string, number>,
    unreferencedBefore: Map<string, number>,
  ): TSNode[] {
    const unreferenced = new Map<string, TSNode[]>();
    for (const helper of OrphanedSelections.declarations(tree)) {
      if (helper.references === 0 && referencedBefore.has(helper.key)) {
        unreferenced.set(helper.key, [...(unreferenced.get(helper.key) ?? []), helper.statement]);
      }
    }
    const out: TSNode[] = [];
    for (const [key, statements] of unreferenced) {
      const orphaned = Math.min(statements.length - (unreferencedBefore.get(key) ?? 0), referencedBefore.get(key)!);
      if (orphaned > 0) {
        out.push(...statements.slice(statements.length - orphaned));
      }
    }
    return out.sort((a, b) => a.startIndex - b.startIndex);
  }

  /** Every helper declaration of the file with its live reference count. */
  private static declarations(tree: TSTree): HelperDeclaration[] {
    const out: HelperDeclaration[] = [];
    for (const node of walkTree(tree.rootNode)) {
      const name = OrphanedSelections.helperName(node);
      if (name !== null) {
        out.push({
          statement: node,
          key: `${name}\u0000${node.text.replace(/;\s*$/, '')}`,
          references: OrphanedSelections.countReferences(tree, node, name),
        });
      }
    }
    return out;
  }

  /**
   * The name a helper declaration binds, or null when `node` is not one: a
   * `const` / `let` statement standing in a block (an exported binding is
   * someone else's input), one plain identifier, initialized with the bare
   * helper call — `const sel = select(…)`, nothing chained onto it.
   */
  private static helperName(node: TSNode): string | null {
    if (node.type !== 'lexical_declaration' || node.namedChildren.length !== 1) {
      return null;
    }
    if (node.parent?.type !== 'statement_block' && node.parent?.type !== 'program') {
      return null;
    }
    const declarator = node.namedChildren[0];
    const name = declarator.childForFieldName('name');
    const value = declarator.childForFieldName('value');
    if (declarator.type !== 'variable_declarator' || name?.type !== 'identifier' || value?.type !== 'call_expression') {
      return null;
    }
    const callee = value.childForFieldName('function');
    if (callee?.type !== 'identifier' || !OrphanedSelections.HELPER_CALLEES.has(callee.text)) {
      return null;
    }
    return name.text;
  }

  /** Uses of `name` that resolve to `declaration`'s binding — `{ sel }` shorthand included. */
  private static countReferences(tree: TSTree, declaration: TSNode, name: string): number {
    let count = 0;
    for (const node of walkTree(tree.rootNode)) {
      if (node.text !== name || OrphanedSelections.within(node, declaration)) {
        continue;
      }
      const isUse = node.type === 'shorthand_property_identifier'
        || (node.type === 'identifier' && isReferenceUse(node));
      if (isUse && OrphanedSelections.resolvesTo(node, declaration, name)) {
        count++;
      }
    }
    return count;
  }

  private static tally(helpers: HelperDeclaration[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const helper of helpers) {
      out.set(helper.key, (out.get(helper.key) ?? 0) + 1);
    }
    return out;
  }

  private static mentionsHelper(code: string): boolean {
    for (const callee of OrphanedSelections.HELPER_CALLEES) {
      if (new RegExp(`\\b${callee}\\s*\\(`).test(code)) {
        return true;
      }
    }
    return false;
  }
}
