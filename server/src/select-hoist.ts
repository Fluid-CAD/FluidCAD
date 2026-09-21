// Lifting `select(…)` calls out of a rendered feature statement into
// declarations of their own.
//
// `select()` registers a scene-wide query where its call runs, and the scene
// builds in that order. Written inline it is only correct as a ROOT argument
// of the feature (`fillet(2, select(…))` — arguments run before the call).
// Two places get it wrong, and both are fixed the same way — a
// `const sel = select(…)` ahead of the consumer, referenced by name:
//
// - 'late': inside a chained call (`loft(a, b).connect(select(…).end(), …)`)
//   the selection runs AFTER `loft(…)` registered, so the loft builds against
//   a selection that has not resolved. Declarations go before the statement.
// - 'all': inside a sketch body (`project(select(…))`) the selection captures
//   the sketch's own scope, empty of solids. Declarations go before the
//   sketch statement.
//
// Lifting is always safe — a declaration directly ahead of its consumer
// resolves against the same model an inline root argument would — so 'late'
// errs towards lifting. The declarations are the feature's alone:
// `OrphanedSelections` removes them with their last reference.

import {
  getJavaScriptParser,
  spliceCode,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor.ts';

export type SelectHoistPolicy = 'late' | 'all';

export type SelectHoistResult = {
  /** The statement with every lifted call replaced by its name. */
  statement: string;
  /** `const <name> = select(…)` declarations, in source order of the calls. */
  decls: string[];
};

export class SelectHoist {
  /**
   * Lift the `select(…)` calls `policy` covers out of `statementText` (a
   * complete call-chain expression). `used` holds the names already taken
   * and receives the allocated ones (`sel`, `sel2`, …).
   */
  static async extract(
    statementText: string,
    policy: SelectHoistPolicy,
    used: Set<string>,
    useSemicolon: boolean,
  ): Promise<SelectHoistResult> {
    if (!/\bselect\s*\(/.test(statementText)) {
      return { statement: statementText, decls: [] };
    }
    const parser = await getJavaScriptParser();
    const root = parser.parse(statementText).rootNode;
    const selects = SelectHoist.outermost(
      [...walkTree(root)].filter((node) => SelectHoist.isSelectCall(node)
        && (policy === 'all' || SelectHoist.runsLate(node))),
    );
    if (selects.length === 0) {
      return { statement: statementText, decls: [] };
    }

    // Name in source order (stable `sel`, `sel2`, … numbering), then splice
    // descending so earlier spans keep their offsets.
    const names = new Map<TSNode, string>();
    for (const node of selects) {
      let name = 'sel';
      for (let suffix = 2; used.has(name); suffix++) {
        name = `sel${suffix}`;
      }
      used.add(name);
      names.set(node, name);
    }
    let statement = statementText;
    for (const node of [...selects].reverse()) {
      statement = spliceCode(statement, node.startIndex, node.endIndex, names.get(node)!);
    }
    return {
      statement,
      decls: selects.map((node) => `const ${names.get(node)} = ${node.text}${useSemicolon ? ';' : ''}`),
    };
  }

  /** Every name of the file plus `extra` — what a new declaration must not collide with. */
  static usedNames(tree: TSTree, extra: Iterable<string | null | undefined> = []): Set<string> {
    const used = new Set<string>();
    for (const node of walkTree(tree.rootNode)) {
      if (node.type === 'identifier' || node.type === 'property_identifier'
        || node.type === 'shorthand_property_identifier') {
        used.add(node.text);
      }
    }
    for (const name of extra) {
      if (name) {
        used.add(name);
      }
    }
    return used;
  }

  private static isSelectCall(node: TSNode): boolean {
    if (node.type !== 'call_expression') {
      return false;
    }
    const callee = node.childForFieldName('function');
    return callee?.type === 'identifier' && callee.text === 'select';
  }

  /**
   * Does the call sit in the arguments of a chained call — a method invoked
   * on the result of another call (`loft(…).connect(<here>)`)? The receiver
   * has run by then, so the feature it created precedes the selection. A
   * method on a plain name (`e.sideFaces(select(…))`) is an accessor handed
   * to a consumer that is still to come, and does not count.
   */
  private static runsLate(select: TSNode): boolean {
    for (let node = select; node.parent; node = node.parent) {
      const parent = node.parent;
      if (parent.type !== 'arguments' || parent.parent?.type !== 'call_expression') {
        continue;
      }
      const callee = parent.parent.childForFieldName('function');
      if (callee?.type === 'member_expression' && callee.childForFieldName('object')?.type === 'call_expression') {
        return true;
      }
    }
    return false;
  }

  /** `nodes` in source order, minus the ones nested inside another. */
  private static outermost(nodes: TSNode[]): TSNode[] {
    const sorted = [...nodes].sort((a, b) => a.startIndex - b.startIndex);
    return sorted.filter((node) => !sorted.some((other) => other !== node
      && other.startIndex <= node.startIndex && other.endIndex >= node.endIndex));
  }
}
