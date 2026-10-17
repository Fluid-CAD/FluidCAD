// Feature names: the `.name('…')` literals and `part('…')` first arguments a
// file holds, the next "<DisplayType> <n>" for a statement the UI writes,
// and the clash a rename would make.
//
// Names are unique per file (plan: shape-naming-and-lineage, D2–D4). The
// create path names every statement it writes so a row's label survives
// lines shifting above it (the lineage key of a named root is its name);
// hand-written and agent-written code may leave names out and get the same
// numbered labels at render time (lib `DefaultNames`). The allocator here
// and the render's numbering agree by construction only on the shape of the
// label; a file may hold both a written "Extrude 2" and an unnamed extrude
// the render lists as "Extrude 3" past it.

import {
  chainBaseCall,
  chainRootCallee,
  findEditableCallAt,
  findSketchBody,
  getArgumentsNode,
  getJavaScriptParser,
  quoteForSingleQuotes,
  splitLines,
  stringLiteralValue,
  walkTree,
  type TSNode,
  type TSTree,
} from './code-editor/index.ts';
import { DISPLAY_TYPE_BY_CALLEE } from './apply-feature-edit/parse/parsed-statement.ts';

/** One name a file holds: the literal, the 1-based line its statement starts on and the statement's root callee. */
export type FeatureNameUse = { name: string; line: number; callee: string };

export class FeatureNames {
  /**
   * Every `.name('<literal>')` chain and `part('<literal>', …)` first
   * argument of the file, in source order. A part with both lists twice —
   * the chain overrides the argument in the lib, but both are names a new
   * statement must not take.
   */
  static collect(tree: TSTree): FeatureNameUse[] {
    const uses: FeatureNameUse[] = [];
    for (const node of walkTree(tree.rootNode)) {
      if (node.type !== 'call_expression') {
        continue;
      }
      const name = FeatureNames.chainNameLiteral(node) ?? FeatureNames.partNameLiteral(node);
      if (name === null) {
        continue;
      }
      uses.push({
        name,
        line: chainBaseCall(node).startPosition.row + 1,
        callee: chainRootCallee(node) ?? 'statement',
      });
    }
    return uses;
  }

  /**
   * `<displayType> <n>`, n one past the HIGHEST `<displayType> <k>` the file
   * already holds — never a freed number, the rule `sketch-names.ts` applies
   * to bindings: after "Extrude 1" and "Extrude 3" the next extrude is
   * "Extrude 4", so a name a deletion freed never lands on a new row.
   */
  static allocate(tree: TSTree, displayType: string): string {
    const numbered = new RegExp(`^${FeatureNames.escape(displayType)} (\\d+)$`);
    let highest = 0;
    for (const use of FeatureNames.collect(tree)) {
      const match = numbered.exec(use.name);
      if (match) {
        highest = Math.max(highest, Number(match[1]));
      }
    }
    return `${displayType} ${highest + 1}`;
  }

  /**
   * The statement already named `name`, other than the one starting on
   * `exceptLine` (1-based, resolved the way every line-addressed edit
   * resolves it) — or null when the name is free. Renaming a statement to
   * its own name is no clash.
   */
  static conflict(tree: TSTree, lines: string[], name: string, exceptLine?: number): FeatureNameUse | null {
    const own = exceptLine === undefined ? null : findEditableCallAt(tree, lines, exceptLine);
    const ownLine = own ? chainBaseCall(own).startPosition.row + 1 : null;
    for (const use of FeatureNames.collect(tree)) {
      if (use.name === name && use.line !== ownLine) {
        return use;
      }
    }
    return null;
  }

  /** `conflict` over source text — the rename route's check. */
  static async conflictIn(code: string, name: string, exceptLine?: number): Promise<FeatureNameUse | null> {
    const parser = await getJavaScriptParser();
    return FeatureNames.conflict(parser.parse(code), splitLines(code), name, exceptLine);
  }

  /** The D3 refusal for a `conflict` — the text the hosts and the timeline input show. */
  static conflictMessage(name: string, use: FeatureNameUse): string {
    return `'${name}' is already the name of the ${use.callee} at line ${use.line}`;
  }

  /** The one-line form a name takes in code: whitespace runs collapsed, trimmed (what `setFeatureName` writes). */
  static normalize(name: string | null | undefined): string {
    return (name ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * The `.name('<DisplayType> <n>')` chain to append to a statement the UI
   * writes with `callee` landing at `index` of the file — '' when the
   * statement is not auto-named: a callee with no display type (a part, a
   * connector, an exposure, a section, an in-sketch derived op) or any
   * statement inside a sketch body (a 2D fillet, mirror, copy or rotate
   * shares its callee with the 3D feature but is a sketch entity).
   */
  static chainFor(tree: TSTree, callee: string, index?: number): string {
    const displayType = DISPLAY_TYPE_BY_CALLEE[callee];
    if (displayType === undefined) {
      return '';
    }
    if (index !== undefined && FeatureNames.insideSketchBody(tree, index)) {
      return '';
    }
    return `.name('${quoteForSingleQuotes(FeatureNames.allocate(tree, displayType))}')`;
  }

  /** Whether `index` lies inside the callback body of a `sketch(…)` call. */
  static insideSketchBody(tree: TSTree, index: number): boolean {
    for (const node of walkTree(tree.rootNode)) {
      if (node.type !== 'call_expression' || chainRootCallee(node) !== 'sketch') {
        continue;
      }
      const body = findSketchBody(node);
      if (body && body.startIndex < index && index <= body.endIndex) {
        return true;
      }
    }
    return false;
  }

  /** The literal of a `.name('…')` call node, or null when `call` is not one (or its argument is not a string). */
  private static chainNameLiteral(call: TSNode): string | null {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'name') {
      return null;
    }
    const args = getArgumentsNode(call)?.namedChildren.filter(arg => arg.type !== 'comment') ?? [];
    return args.length === 1 ? stringLiteralValue(args[0]) : null;
  }

  /** The literal first argument of a `part('…', …)` call node, or null. */
  private static partNameLiteral(call: TSNode): string | null {
    const fn = call.childForFieldName('function');
    if (!fn || fn.type !== 'identifier' || fn.text !== 'part') {
      return null;
    }
    const first = getArgumentsNode(call)?.namedChildren.find(arg => arg.type !== 'comment');
    return first ? stringLiteralValue(first) : null;
  }

  private static escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
